import { parsePrompt } from "../prompt_parser.js";

import {
    getColor,
    memoryClassifications,
    memoryOverrides,
} from "../core/runtime.js";

import {
    coordinator,
    hydrateTags,
    resolvedCategory,
} from "../classifier/classifier_client.js";

export class PromptHighlighter {
    constructor(controller) {
        this.controller = controller;
        this.textarea = controller.textarea;

        this.overlay = document.createElement("div");
        this.content = document.createElement("div");

        this.overlay.className = "sth-overlay";
        this.content.className = "sth-overlay-content";

        this.overlay.appendChild(this.content);
        /*
         * Keep the mirror in the textarea's own DOM/stacking context.
         * A body-level fixed overlay can paint above ComfyUI sidebars and
         * other chrome when a node is partially hidden by the UI.
         */
        this.overlayHost =
            this.textarea.offsetParent ??
            this.textarea.parentElement;

        if (!this.overlayHost) {
            throw new Error("Could not find a DOM host for prompt overlay");
        }
        this.overlayHost.appendChild(this.overlay);

        this.previousInlineColor = this.textarea.style.color;
        this.previousCaretColor = this.textarea.style.caretColor;

        const computed = getComputedStyle(this.textarea);
        this.originalTextColor = computed.color;

        this.textarea.style.color = "transparent";
        this.textarea.style.caretColor = this.originalTextColor;

        this.onInput = () => this.update();
        this.onScroll = () => this.syncScroll();
        this.textarea.addEventListener("input", this.onInput);
        this.textarea.addEventListener("scroll", this.onScroll);

        this.update();
    }

    destroy() {
        this.textarea.removeEventListener("input", this.onInput);
        this.textarea.removeEventListener("scroll", this.onScroll);

        this.textarea.style.color = this.previousInlineColor;
        this.textarea.style.caretColor = this.previousCaretColor;

        this.overlay.remove();
    }

    syncStyle() {
        const textarea = this.textarea;
        const computed = getComputedStyle(textarea);
        /*
         * Overlay and textarea now share the same offset parent, so ComfyUI's
         * node/canvas transform is inherited automatically. No viewport-space
         * scaling math is needed, and the overlay cannot float above unrelated
         * application chrome.
         */
        Object.assign(this.overlay.style, {
            left: `${textarea.offsetLeft}px`,
            top: `${textarea.offsetTop}px`,
            width: `${textarea.offsetWidth}px`,
            height: `${textarea.offsetHeight}px`,
            display:
                textarea.offsetWidth > 0 &&
                textarea.offsetHeight > 0 &&
                textarea.isConnected
                    ? "block"
                    : "none",
            zIndex: "1",
            transform: "none",
            borderRadius: computed.borderRadius,
            fontFamily: computed.fontFamily,
            fontSize: computed.fontSize,
            fontWeight: computed.fontWeight,
            fontStyle: computed.fontStyle,
            lineHeight: computed.lineHeight,
            letterSpacing: computed.letterSpacing,
            textAlign: computed.textAlign,
            textTransform: computed.textTransform,
            tabSize: computed.tabSize,
            color: this.originalTextColor,
        });
        Object.assign(this.content.style, {
            width: "100%",
            minHeight: "100%",
            boxSizing: "border-box",
            whiteSpace: "pre-wrap",
            overflowWrap: computed.overflowWrap || "break-word",
            wordBreak: computed.wordBreak || "normal",
            paddingTop: computed.paddingTop,
            paddingRight: computed.paddingRight,
            paddingBottom: computed.paddingBottom,
            paddingLeft: computed.paddingLeft,
        });
        this.syncScroll();
    }

    syncScroll() {
        this.content.style.transform =
            `translate(${-this.textarea.scrollLeft}px, ${-this.textarea.scrollTop}px)`;
    }

    async update() {
        const segments = parsePrompt(this.textarea.value);
        const modelTags = [
            ...new Set(
                segments
                    .filter(
                        (segment) =>
                            segment.normalized &&
                            !segment.syntaxCategory
                    )
                    .map((segment) => segment.normalized)
            ),
        ];

        this.render(segments);

        await hydrateTags(modelTags);
        this.render(segments);
        for (const segment of segments) {
            if (
                !segment.normalized ||
                segment.syntaxCategory ||
                memoryOverrides.has(segment.normalized) ||
                memoryClassifications.has(segment.normalized)
            ) {
                continue;
            }

            coordinator.queue(
                segment.normalized,
                segment.normalized
            );
        }
    }

    render(segments = parsePrompt(this.textarea.value)) {
        const fragment = document.createDocumentFragment();

        for (const segment of segments) {
            if (segment.leading) {
                fragment.appendChild(
                    document.createTextNode(segment.leading)
                );
            }
            if (segment.core) {
                const span = document.createElement("span");
                const category = resolvedCategory(segment);
                const color = getColor(category);

                span.textContent = segment.core;
                span.dataset.category = category;

                if (color) {
                    span.style.color = color;
                } else {
                    span.style.color = this.originalTextColor;
                }
                fragment.appendChild(span);
            }

            if (segment.trailing) {
                fragment.appendChild(
                    document.createTextNode(segment.trailing)
                );
            }

            if (segment.comma) {
                fragment.appendChild(
                    document.createTextNode(segment.comma)
                );
            }
        }

        this.content.replaceChildren(fragment);
        this.syncStyle();
    }
}
