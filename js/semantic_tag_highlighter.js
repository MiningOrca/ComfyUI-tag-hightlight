import { app } from "../../scripts/app.js";

import {
    categoryForRecord,
    normalizeTag,
    parsePrompt,
} from "./prompt_parser.js";

import {
    ALL_CATEGORIES,
    DEFAULT_MIN_MARGIN,
    DEFAULT_MIN_SCORE,
    ML_CATEGORIES,
    MODEL_VERSION,
    TAXONOMY_VERSION,
    classificationCacheKey,
    normalizeCategory,
} from "./classifier_schema.js";

import {
    clearClassifications,
    clearOverrides,
    deleteOverride,
    getClassifications,
    getOverrides,
    putClassifications,
    setOverride,
} from "./storage.js";


const EXTENSION_NAME = "semantic_tag_highlighter";
const STATE_PROPERTY = "__semantic_tag_highlighter";

const CATEGORIES = ALL_CATEGORIES;

/*
 * NLI is O(tags × candidate labels), unlike embedding classification.
 * Keep batches deliberately small so colors appear progressively and so
 * multiple prompt widgets never launch competing model inference calls.
 */
const CLASSIFY_BATCH_SIZE = 4;

/*
 * These are TEST CASES, not classifier rules. They are never passed into the
 * taxonomy/category definitions. The browser self-test runs the actual model
 * and reports both accuracy and wall-clock inference time.
 */
const MODEL_SELF_TEST_CASES = Object.freeze([
    ["human", "species"],
    ["anthro dragon", "species"],
    ["perfect eyes", "anatomy"],
    ["tan skin", "anatomy"],
    ["looking at viewer", "expression"],
    ["hand between legs", "pose"],
    ["school uniform", "clothing"],
    ["nude", "sexual"],
    ["cel shading", "style"],
    ["three quarter view", "camera"],
    ["rim lighting", "lighting"],
    ["forest background", "environment"],
    ["low quality", "quality"],
    ["extra fingers", "defect"],
    ["watermark", "text_metadata"],
]);

const COLOR_DEFAULTS = {
    subject: "#82aaff",
    species: "#c792ea",
    anatomy: "#f78c6c",
    pose: "#ffcb6b",
    expression: "#f07178",
    clothing: "#89ddff",
    sexual: "#ff7ab2",
    artist: "#b4f9f8",
    style: "#c3e88d",
    camera: "#80cbc4",
    lighting: "#ffd580",
    environment: "#addb67",
    quality: "#f2a65a",
    defect: "#ff8b72",
    text_metadata: "#a6e22e",
    lora: "#bb9af7",
    embedding: "#7dcfff",
    wildcard: "#b4f9f8",
};

const SETTINGS = {
    enabled: "SemanticTagHighlighter.Enabled",
    showButtons: "SemanticTagHighlighter.ShowEnableButtons",
    minScore: "SemanticTagHighlighter.NliMinScore",
    minMargin: "SemanticTagHighlighter.NliMinMargin",
    colors: Object.fromEntries(
        Object.keys(COLOR_DEFAULTS).map(
            (category) => [
                category,
                `SemanticTagHighlighter.Color.${category}`,
            ]
        )
    ),
};

const controllersByTextarea = new WeakMap();
const controllers = new Set();
const memoryClassifications = new Map();
const memoryOverrides = new Map();
const checkedClassifications = new Set();
const checkedOverrides = new Set();

let scanTimer = null;
let rafId = null;
let globalStatusPill = null;


function settingValue(id, fallback) {
    try {
        const value = app.extensionManager?.setting?.get?.(id);
        if (value !== undefined) return value;
    } catch {}

    try {
        const value = app.ui?.settings?.getSettingValue?.(id);
        if (value !== undefined) return value;
    } catch {}

    return fallback;
}

function toast(severity, summary, detail) {
    try {
        app.extensionManager?.toast?.add?.({
            severity,
            summary,
            detail,
            life: 4500,
        });
        return;
    } catch {}

    const method = severity === "error" ? "error" : "log";
    console[method](`[Semantic Tag Highlighter] ${summary}: ${detail}`);
}

function getColor(category) {
    if (category === "other") return null;

    return settingValue(
        SETTINGS.colors[category],
        COLOR_DEFAULTS[category] ?? null
    );
}

function minScore() {
    return Number(settingValue(SETTINGS.minScore, DEFAULT_MIN_SCORE));
}

function minMargin() {
    return Number(settingValue(SETTINGS.minMargin, DEFAULT_MIN_MARGIN));
}

function pluginEnabled() {
    return Boolean(settingValue(SETTINGS.enabled, true));
}

function buttonsEnabled() {
    return Boolean(settingValue(SETTINGS.showButtons, true));
}

function getNodeState(node) {
    const raw = node.properties?.[STATE_PROPERTY];

    if (
        raw &&
        typeof raw === "object" &&
        Array.isArray(raw.enabledWidgets)
    ) {
        return {
            enabledWidgets: [...new Set(raw.enabledWidgets.map(String))],
        };
    }

    return {
        enabledWidgets: [],
    };
}

function setNodeState(node, state) {
    node.properties ??= {};

    const clean = {
        enabledWidgets: [...new Set(state.enabledWidgets.map(String))],
    };

    if (typeof node.setProperty === "function") {
        node.setProperty(STATE_PROPERTY, clean);
    } else {
        node.properties[STATE_PROPERTY] = clean;
    }

    node.setDirtyCanvas?.(true, true);
}

function widgetLogicalName(widget) {
    if (widget?.__dptLogicalName) {
        return String(widget.__dptLogicalName);
    }

    return String(
        widget?.label ??
        widget?.name ??
        "text"
    );
}

function widgetStateKey(widget) {
    if (widget?.__dptLogicalName) {
        return `dpt:${widget.__dptLogicalName}`;
    }

    return String(widget?.name ?? widgetLogicalName(widget));
}

function getTextarea(widget) {
    if (!widget) return null;

    if (widget.element instanceof HTMLTextAreaElement) {
        return widget.element;
    }

    if (widget.inputEl instanceof HTMLTextAreaElement) {
        return widget.inputEl;
    }

    if (widget.__dptTextarea instanceof HTMLTextAreaElement) {
        return widget.__dptTextarea;
    }

    if (widget.element instanceof HTMLElement) {
        return widget.element.querySelector("textarea");
    }

    return null;
}

function ensureGlobalStatusPill() {
    if (globalStatusPill?.isConnected) {
        return globalStatusPill;
    }

    const pill = document.createElement("div");
    pill.className = "sth-global-status";
    pill.style.display = "none";
    document.body.appendChild(pill);

    globalStatusPill = pill;
    return pill;
}

function setGlobalStatus(message, visible = true) {
    const pill = ensureGlobalStatusPill();
    pill.textContent = message;
    pill.style.display = visible ? "block" : "none";
}

function formatProgress(info) {
    if (!info) return "Loading semantic tag model…";

    if (
        info.status === "progress_total" &&
        Number.isFinite(info.progress)
    ) {
        return `Downloading semantic model… ${Math.round(info.progress)}%`;
    }

    if (
        info.status === "progress" &&
        Number.isFinite(info.progress)
    ) {
        return `Downloading semantic model… ${Math.round(info.progress)}%`;
    }

    if (info.file) {
        return `Downloading semantic model… ${info.file}`;
    }

    return "Loading semantic tag model…";
}


class ClassificationCoordinator {
    constructor() {
        this.worker = null;
        this.pending = new Map();
        this.queuedOrInflight = new Set();
        this.timer = null;
        this.nextRequestId = 1;
        this.inflight = new Map();
        this.busy = false;
        this.failed = false;
        this.idleWaiters = [];
    }

    ensureWorker() {
        if (this.worker) return this.worker;

        this.worker = new Worker(
            new URL("./classifier_worker.js", import.meta.url),
            { type: "module" }
        );

        this.worker.addEventListener(
            "message",
            (event) => this.onMessage(event.data)
        );

        this.worker.addEventListener("error", (event) => {
            this.failed = true;
            this.busy = false;
            this.resolveIdleWaiters();

            setGlobalStatus(
                "Semantic classifier failed",
                true
            );

            toast(
                "error",
                "Semantic Tag Highlighter",
                event.message ||
                    "Classifier worker failed"
            );
        });

        return this.worker;
    }

    queue(tag, text) {
        if (
            !tag ||
            !text ||
            this.failed ||
            memoryOverrides.has(tag) ||
            memoryClassifications.has(tag) ||
            this.queuedOrInflight.has(tag)
        ) {
            return;
        }

        this.pending.set(tag, text);
        this.queuedOrInflight.add(tag);

        clearTimeout(this.timer);

        this.timer = setTimeout(
            () => this.flush(),
            180
        );
    }

    flush() {
        if (
            this.busy ||
            !this.pending.size ||
            this.failed
        ) {
            return;
        }

        const entries =
            [...this.pending.entries()]
                .slice(0, CLASSIFY_BATCH_SIZE);

        for (const [tag] of entries) {
            this.pending.delete(tag);
        }

        const batch =
            entries.map(
                ([tag, text]) => ({
                    tag,
                    text,
                })
            );

        this.sendRequest(
            batch,
            "normal"
        );
    }

    sendRequest(batch, kind, resolve = null, reject = null) {
        if (!batch.length) {
            resolve?.({
                results: [],
                elapsedMs: 0,
            });
            return;
        }

        this.busy = true;

        const requestId =
            this.nextRequestId++;

        this.inflight.set(
            requestId,
            {
                batch,
                kind,
                resolve,
                reject,
                startedAt:
                    performance.now(),
            }
        );

        if (kind === "normal") {
            setGlobalStatus(
                `Classifying ${batch.length} tag${batch.length === 1 ? "" : "s"}…`,
                true
            );
        }

        this.ensureWorker().postMessage({
            type: "classify",
            requestId,
            tags: batch,
        });
    }

    async waitUntilIdle() {
        if (
            !this.busy &&
            this.pending.size === 0
        ) {
            return;
        }

        await new Promise((resolve) => {
            this.idleWaiters.push(resolve);
        });
    }

    resolveIdleWaiters() {
        if (
            this.busy ||
            this.pending.size
        ) {
            return;
        }

        const waiters =
            this.idleWaiters.splice(0);

        for (const resolve of waiters) {
            resolve();
        }
    }

    async classifyForTest(items) {
        await this.waitUntilIdle();

        if (this.failed) {
            throw new Error(
                "Classifier worker is in failed state"
            );
        }

        const batch =
            items.map((item) => ({
                tag: item.tag,
                text: item.text,
            }));

        return new Promise(
            (resolve, reject) => {
                this.sendRequest(
                    batch,
                    "self-test",
                    resolve,
                    reject
                );
            }
        );
    }

    async onMessage(message) {
        if (!message) return;

        if (message.type === "progress") {
            setGlobalStatus(
                formatProgress(message.info),
                true
            );
            return;
        }

        if (message.type === "status") {
            if (message.state === "ready") {
                setGlobalStatus(
                    "Semantic model ready",
                    true
                );

                setTimeout(
                    () =>
                        setGlobalStatus(
                            "",
                            false
                        ),
                    1200
                );
            } else {
                setGlobalStatus(
                    message.message ||
                        "Loading semantic model…",
                    true
                );
            }
            return;
        }

        const request =
            this.inflight.get(
                message.requestId
            );

        if (!request) {
            return;
        }

        if (message.type === "error") {
            this.inflight.delete(
                message.requestId
            );

            for (
                const item
                of request.batch
            ) {
                this.queuedOrInflight.delete(
                    item.tag
                );
            }

            this.busy = false;

            request.reject?.(
                new Error(
                    message.message ||
                    "Classification failed"
                )
            );

            setGlobalStatus(
                "Semantic classifier error",
                true
            );

            toast(
                "error",
                "Semantic Tag Highlighter",
                message.message ||
                    "Classification failed"
            );

            if (this.pending.size) {
                setTimeout(
                    () => this.flush(),
                    0
                );
            } else {
                this.resolveIdleWaiters();
            }

            return;
        }

        if (
            message.type !== "result"
        ) {
            return;
        }

        this.inflight.delete(
            message.requestId
        );

        for (
            const item
            of request.batch
        ) {
            this.queuedOrInflight.delete(
                item.tag
            );
        }

        this.busy = false;

        const elapsedMs =
            Number(message.elapsedMs) ||
            (
                performance.now() -
                request.startedAt
            );

        if (
            request.kind ===
            "self-test"
        ) {
            request.resolve?.({
                results:
                    message.results ?? [],
                elapsedMs,
            });

            if (this.pending.size) {
                setTimeout(
                    () => this.flush(),
                    0
                );
            } else {
                this.resolveIdleWaiters();
            }

            return;
        }

        const records =
            (message.results ?? [])
                .map((result) => {
                    const record = {
                        key:
                            classificationCacheKey(
                                result.tag
                            ),
                        tag: result.tag,
                        category:
                            result.category,
                        score:
                            Number(
                                result.score
                            ),
                        secondScore:
                            Number(
                                result.secondScore
                            ),
                        margin:
                            Number(
                                result.margin
                            ),
                        modelVersion:
                            MODEL_VERSION,
                        taxonomyVersion:
                            TAXONOMY_VERSION,
                    };

                    memoryClassifications.set(
                        result.tag,
                        record
                    );

                    checkedClassifications.add(
                        result.tag
                    );

                    return record;
                });

        try {
            await putClassifications(
                records
            );
        } catch (error) {
            console.warn(
                "[Semantic Tag Highlighter] " +
                "Could not persist classification cache",
                error
            );
        }

        /*
         * Paint after every small batch instead of waiting for an entire
         * prompt. This makes slow NLI progress visible.
         */
        refreshAll();

        const remaining =
            this.pending.size;

        setGlobalStatus(
            remaining
                ? `Classified ${records.length} tags in ${(elapsedMs / 1000).toFixed(1)}s; ${remaining} queued…`
                : `Classified ${records.length} tags in ${(elapsedMs / 1000).toFixed(1)}s`,
            true
        );

        if (remaining) {
            setTimeout(
                () => this.flush(),
                0
            );
        } else {
            setTimeout(
                () =>
                    setGlobalStatus(
                        "",
                        false
                    ),
                1800
            );

            this.resolveIdleWaiters();
        }
    }
}
const coordinator = new ClassificationCoordinator();


async function hydrateTags(tags) {
    const unique = [...new Set(tags.filter(Boolean))];

    const overrideMisses = unique.filter(
        (tag) => !checkedOverrides.has(tag)
    );

    if (overrideMisses.length) {
        try {
            const records = await getOverrides(overrideMisses);

            for (let i = 0; i < overrideMisses.length; i += 1) {
                const tag = overrideMisses[i];
                const record = records[i];

                checkedOverrides.add(tag);

                if (record?.category) {
                    memoryOverrides.set(tag, record.category);
                }
            }
        } catch (error) {
            console.warn(
                "[Semantic Tag Highlighter] Could not read overrides",
                error
            );
        }
    }

    const classificationMisses = unique.filter(
        (tag) =>
            !memoryOverrides.has(tag) &&
            !checkedClassifications.has(tag)
    );

    if (classificationMisses.length) {
        try {
            const records = await getClassifications(
                classificationMisses.map(classificationCacheKey)
            );

            for (let i = 0; i < classificationMisses.length; i += 1) {
                const tag = classificationMisses[i];
                const record = records[i];

                checkedClassifications.add(tag);

                if (record) {
                    memoryClassifications.set(tag, record);
                }
            }
        } catch (error) {
            console.warn(
                "[Semantic Tag Highlighter] Could not read classification cache",
                error
            );
        }
    }
}


function resolvedCategory(segment) {
    if (segment.syntaxCategory) {
        return segment.syntaxCategory;
    }

    if (!segment.normalized) {
        return "other";
    }

    if (memoryOverrides.has(segment.normalized)) {
        return normalizeCategory(
            memoryOverrides.get(segment.normalized)
        );
    }

    return categoryForRecord(
        memoryClassifications.get(segment.normalized),
        minScore(),
        minMargin()
    );
}


class PromptHighlighter {
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


class FieldController {
    constructor(node, widget, textarea) {
        this.node = node;
        this.widget = widget;
        this.textarea = textarea;
        this.key = widgetStateKey(widget);
        this.label = widgetLogicalName(widget);

        this.button = null;
        this.highlighter = null;

        controllers.add(this);
        controllersByTextarea.set(textarea, this);

        this.syncEnabledState();
    }

    isEnabledInWorkflow() {
        return getNodeState(this.node)
            .enabledWidgets
            .includes(this.key);
    }

    syncEnabledState() {
        if (!pluginEnabled()) {
            this.destroyHighlighter();
            this.removeButton();
            return;
        }

        const enabled = this.isEnabledInWorkflow();

        if (enabled) {
            this.ensureHighlighter();
        } else {
            this.destroyHighlighter();
        }

        if (buttonsEnabled()) {
            this.ensureButton();
            this.updateButtonState(enabled);
        } else {
            this.removeButton();
        }
    }

    enable() {
        const state = getNodeState(this.node);

        if (!state.enabledWidgets.includes(this.key)) {
            state.enabledWidgets.push(this.key);
            setNodeState(this.node, state);
        }

        this.syncEnabledState();
    }

    disable() {
        const state = getNodeState(this.node);

        state.enabledWidgets = state.enabledWidgets.filter(
            (key) => key !== this.key
        );

        setNodeState(this.node, state);
        this.syncEnabledState();
    }

    ensureButton() {
        if (this.button?.isConnected) return;

        const host =
            this.textarea.offsetParent ??
            this.textarea.parentElement;

        if (!host) return;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "sth-enable-button";

        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();

            // The field button is intentionally enable-only.
            // Disable from the node context menu/options.
            if (!this.isEnabledInWorkflow()) {
                this.enable();
            }
        });

        host.appendChild(button);
        this.button = button;
        this.buttonHost = host;

        this.updateButtonState(this.isEnabledInWorkflow());
    }

    updateButtonState(enabled) {
        if (!this.button) return;

        this.button.textContent = enabled ? "Tags ✓" : "Tags";
        this.button.classList.toggle("sth-active", enabled);

        this.button.title = enabled
            ? `Semantic tag highlighting is enabled for "${this.label}". Disable it from the node menu.`
            : `Enable semantic tag highlighting for "${this.label}"`;
    }

    removeButton() {
        this.button?.remove();
        this.button = null;
    }

    ensureHighlighter() {
        if (this.highlighter) return;

        this.highlighter = new PromptHighlighter(this);
    }

    destroyHighlighter() {
        this.highlighter?.destroy();
        this.highlighter = null;
    }

    position() {
        if (!this.textarea.isConnected) {
            this.destroy();
            return;
        }

        if (this.button) {
            const visible =
                this.textarea.offsetWidth > 0 &&
                this.textarea.offsetHeight > 0 &&
                this.textarea.isConnected;

            this.button.style.display =
                visible ? "inline-flex" : "none";

            if (visible) {
                const buttonWidth =
                    this.button.offsetWidth || 34;

                const left = Math.max(
                    0,
                    this.textarea.offsetLeft +
                    this.textarea.offsetWidth -
                    buttonWidth -
                    5
                );

                const top = Math.max(
                    0,
                    this.textarea.offsetTop -
                    (this.button.offsetHeight || 18) -
                    3
                );

                this.button.style.setProperty(
                    "--sth-left",
                    `${left}px`
                );

                this.button.style.setProperty(
                    "--sth-top",
                    `${top}px`
                );
            }
        }

        this.highlighter?.syncStyle();
    }

    destroy() {
        this.removeButton();
        this.destroyHighlighter();
        controllers.delete(this);
    }
}


function injectCss() {
    if (document.getElementById("sth-styles")) return;

    const style = document.createElement("style");
    style.id = "sth-styles";
    style.textContent = `
        .sth-enable-button {
            /*
             * ComfyUI themes apply fairly aggressive global button styles.
             * Reset them completely so this stays a tiny opt-in control.
             */
            all: unset !important;
            position: absolute !important;
            left: var(--sth-left, 4px) !important;
            top: var(--sth-top, 4px) !important;
            z-index: 2147483000 !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            box-sizing: border-box !important;

            width: auto !important;
            min-width: 0 !important;
            max-width: none !important;
            height: 18px !important;
            min-height: 18px !important;
            max-height: 18px !important;

            padding: 0 5px !important;
            margin: 0 !important;

            border: 1px solid color-mix(in srgb, currentColor 25%, transparent) !important;
            border-radius: 4px !important;

            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
            font-size: 10px !important;
            font-weight: 500 !important;
            line-height: 16px !important;

            color: var(--input-text, #d7d7d7) !important;
            background: color-mix(in srgb, var(--comfy-menu-bg, #252525) 94%, transparent) !important;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.24) !important;

            cursor: pointer !important;
            user-select: none !important;
            opacity: 0.72 !important;
        }

        .sth-enable-button:hover {
            opacity: 1 !important;
        }

        .sth-enable-button.sth-active {
            opacity: 0.92 !important;
            border-color: color-mix(in srgb, currentColor 48%, transparent) !important;
        }

        .sth-overlay {
            position: absolute;
            pointer-events: none;
            overflow: hidden;
            box-sizing: border-box;
            background: transparent;
        }

        .sth-overlay-content {
            pointer-events: none;
            transform-origin: top left;
        }

        .sth-global-status {
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 2147483640;
            max-width: min(480px, calc(100vw - 32px));
            padding: 7px 10px;
            border-radius: 6px;
            font: 12px/1.35 sans-serif;
            color: var(--input-text, #ddd);
            background: color-mix(in srgb, var(--comfy-menu-bg, #252525) 96%, transparent);
            border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        }
    `;

    document.head.appendChild(style);
}


function scanNode(node) {
    if (!node?.widgets) return;

    for (const widget of node.widgets) {
        const textarea = getTextarea(widget);

        if (!(textarea instanceof HTMLTextAreaElement)) {
            continue;
        }

        if (controllersByTextarea.has(textarea)) {
            continue;
        }

        new FieldController(
            node,
            widget,
            textarea
        );
    }
}

function scanAllNodes() {
    const nodes =
        app.graph?._nodes ??
        app.rootGraph?._nodes ??
        [];

    for (const node of nodes) {
        scanNode(node);
    }

    for (const controller of [...controllers]) {
        if (!controller.textarea.isConnected) {
            controller.destroy();
        }
    }
}

function positionLoop() {
    for (const controller of [...controllers]) {
        controller.position();
    }

    rafId = requestAnimationFrame(positionLoop);
}

function refreshAll() {
    for (const controller of [...controllers]) {
        controller.syncEnabledState();
        controller.highlighter?.render();
    }
}


async function runClassifierSelfTest() {
    const cases =
        MODEL_SELF_TEST_CASES.map(
            ([tag, expected]) => ({
                tag,
                text: tag,
                expected,
            })
        );

    for (const item of cases) {
        if (
            !ML_CATEGORIES.includes(
                item.expected
            )
        ) {
            throw new Error(
                `Invalid self-test category: ${item.expected}`
            );
        }
    }

    setGlobalStatus(
        `Running real model self-test: ${cases.length} tags…`,
        true
    );

    try {
        const {
            results,
            elapsedMs,
        } =
            await coordinator.classifyForTest(
                cases
            );

        const byTag =
            new Map(
                results.map(
                    (result) => [
                        result.tag,
                        result,
                    ]
                )
            );

        const rows =
            cases.map((item) => {
                const raw =
                    byTag.get(item.tag);

                const actual =
                    categoryForRecord(
                        raw,
                        minScore(),
                        minMargin()
                    );

                return {
                    tag: item.tag,
                    expected:
                        item.expected,
                    actual,
                    rawCategory:
                        raw?.category ??
                        "<missing>",
                    score:
                        raw?.score
                            ?.toFixed?.(3) ??
                        "",
                    margin:
                        raw?.margin
                            ?.toFixed?.(3) ??
                        "",
                    pass:
                        actual ===
                        item.expected,
                };
            });

        const passed =
            rows.filter(
                (row) => row.pass
            ).length;

        const seconds =
            elapsedMs / 1000;

        console.group(
            "[Semantic Tag Highlighter] REAL MODEL SELF-TEST"
        );
        console.table(rows);
        console.log(
            `Result: ${passed}/${rows.length}; ` +
            `model inference: ${seconds.toFixed(2)}s; ` +
            `${(elapsedMs / rows.length).toFixed(0)} ms/tag`
        );
        console.groupEnd();

        const failures =
            rows.filter(
                (row) => !row.pass
            );

        const summary =
            [
                `Real model: ${passed}/${rows.length} expected categories`,
                `Inference: ${seconds.toFixed(2)} s total`,
                `${(elapsedMs / rows.length).toFixed(0)} ms/tag`,
                "",
                failures.length
                    ? "Failures:"
                    : "No category mismatches.",
                ...failures.map(
                    (row) =>
                        `${row.tag}: expected ${row.expected}, got ${row.actual} ` +
                        `(raw ${row.rawCategory}, score ${row.score}, margin ${row.margin})`
                ),
            ].join("\n");

        setGlobalStatus(
            `Self-test: ${passed}/${rows.length} in ${seconds.toFixed(1)}s`,
            true
        );

        window.alert(
            "Semantic Tag Highlighter\n\n" +
            summary +
            "\n\nFull table was written to the browser console."
        );

        setTimeout(
            () =>
                setGlobalStatus(
                    "",
                    false
                ),
            2500
        );
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : String(error);

        setGlobalStatus(
            "Classifier self-test failed",
            true
        );

        toast(
            "error",
            "Semantic Tag Highlighter",
            message
        );

        window.alert(
            "Semantic Tag Highlighter self-test failed:\n\n" +
            message
        );
    }
}

async function addOverrideInteractively() {
    const rawTag = window.prompt(
        "Tag to override, e.g. looking_at_viewer:"
    );

    if (rawTag === null) return;

    const tag = normalizeTag(rawTag);

    if (!tag) {
        toast(
            "warn",
            "Semantic Tag Highlighter",
            "Tag is empty"
        );
        return;
    }

    const current =
        memoryOverrides.get(tag) ??
        "expression";

    const category = window.prompt(
        `Category for "${tag}":\n${CATEGORIES.join(", ")}`,
        current
    );

    if (category === null) return;

    const normalizedCategory =
        category.trim().toLowerCase();

    if (!CATEGORIES.includes(normalizedCategory)) {
        toast(
            "error",
            "Semantic Tag Highlighter",
            `Unknown category "${normalizedCategory}"`
        );
        return;
    }

    const storedCategory =
        normalizeCategory(normalizedCategory);

    await setOverride(
        tag,
        storedCategory
    );

    memoryOverrides.set(
        tag,
        storedCategory
    );

    checkedOverrides.add(tag);
    refreshAll();
}

async function removeOverrideInteractively() {
    const rawTag = window.prompt(
        "Tag whose override should be removed:"
    );

    if (rawTag === null) return;

    const tag = normalizeTag(rawTag);
    if (!tag) return;

    await deleteOverride(tag);
    memoryOverrides.delete(tag);
    checkedOverrides.add(tag);

    refreshAll();
}

async function clearMlCacheInteractively() {
    if (
        !window.confirm(
            "Clear Semantic Tag Highlighter ML classification cache?\n" +
            "Manual overrides will be preserved."
        )
    ) {
        return;
    }

    await clearClassifications();

    memoryClassifications.clear();
    checkedClassifications.clear();

    for (const controller of controllers) {
        controller.highlighter?.update();
    }

    toast(
        "success",
        "Semantic Tag Highlighter",
        "Classification cache cleared"
    );
}

async function clearOverridesInteractively() {
    if (
        !window.confirm(
            "Clear all Semantic Tag Highlighter manual overrides?"
        )
    ) {
        return;
    }

    await clearOverrides();

    memoryOverrides.clear();
    checkedOverrides.clear();

    refreshAll();

    toast(
        "success",
        "Semantic Tag Highlighter",
        "Manual overrides cleared"
    );
}


const colorSettings = Object.entries(COLOR_DEFAULTS).map(
    ([category, defaultValue]) => ({
        id: SETTINGS.colors[category],
        category: [
            "Semantic Tag Highlighter",
            "Colors",
            category,
        ],
        name:
            `Color: ${category[0].toUpperCase()}${category.slice(1)}`,
        type: "color",
        defaultValue,
        onChange: () => refreshAll(),
    })
);


app.registerExtension({
    name: EXTENSION_NAME,

    settings: [
        {
            id: SETTINGS.enabled,
            category: [
                "Semantic Tag Highlighter",
                "General",
                "Enabled",
            ],
            name: "Enabled",
            type: "boolean",
            defaultValue: true,
            onChange: () => refreshAll(),
        },
        {
            id: SETTINGS.showButtons,
            category: [
                "Semantic Tag Highlighter",
                "General",
                "Enable buttons",
            ],
            name: "Show 'Highlight tags' buttons on multiline fields",
            type: "boolean",
            defaultValue: true,
            onChange: () => refreshAll(),
        },
        {
            id: SETTINGS.minScore,
            category: [
                "Semantic Tag Highlighter",
                "Classifier",
                "Minimum score",
            ],
            name: "Minimum classification score",
            tooltip:
                "Below this zero-shot class probability the tag stays uncolored.",
            type: "slider",
            attrs: {
                min: 0,
                max: 1,
                step: 0.01,
            },
            defaultValue: DEFAULT_MIN_SCORE,
            onChange: () => refreshAll(),
        },
        {
            id: SETTINGS.minMargin,
            category: [
                "Semantic Tag Highlighter",
                "Classifier",
                "Minimum margin",
            ],
            name: "Minimum winner margin",
            tooltip:
                "Best category must beat the second-best category by at least this amount.",
            type: "slider",
            attrs: {
                min: 0,
                max: 0.25,
                step: 0.01,
            },
            defaultValue: DEFAULT_MIN_MARGIN,
            onChange: () => refreshAll(),
        },
        ...colorSettings,
    ],

    init() {
        injectCss();
        ensureGlobalStatusPill();
    },

    nodeCreated(node) {
        // Other extensions can append DOM widgets after nodeCreated, so we
        // scan now and the periodic scanner will pick up late/dynamic widgets.
        queueMicrotask(() => scanNode(node));
        setTimeout(() => scanNode(node), 100);
        setTimeout(() => scanNode(node), 500);
    },

    loadedGraphNode(node) {
        setTimeout(() => scanNode(node), 0);
        setTimeout(() => scanNode(node), 200);
    },

    setup() {
        scanAllNodes();

        if (!scanTimer) {
            scanTimer = setInterval(
                scanAllNodes,
                700
            );
        }

        if (!rafId) {
            rafId = requestAnimationFrame(
                positionLoop
            );
        }
    },

    getNodeMenuItems(node) {
        const nodeControllers = [...controllers].filter(
            (controller) =>
                controller.node === node &&
                controller.isEnabledInWorkflow()
        );

        if (!nodeControllers.length) {
            return [];
        }

        const items = [null];

        for (const controller of nodeControllers) {
            items.push({
                content:
                    `Disable semantic highlighting: ${controller.label}`,
                callback: () => controller.disable(),
            });
        }

        if (nodeControllers.length > 1) {
            items.push({
                content:
                    "Disable semantic highlighting: all fields on this node",
                callback: () => {
                    for (const controller of nodeControllers) {
                        controller.disable();
                    }
                },
            });
        }

        items.push(
            {
                content:
                    "Semantic Tag Highlighter: run real model self-test…",
                callback: () =>
                    runClassifierSelfTest(),
            },
            {
                content:
                    "Semantic tag override: add/edit…",
                callback: () =>
                    addOverrideInteractively(),
            },
            {
                content:
                    "Semantic tag override: remove…",
                callback: () =>
                    removeOverrideInteractively(),
            },
            {
                content:
                    "Semantic Tag Highlighter: clear ML cache",
                callback: () =>
                    clearMlCacheInteractively(),
            },
            {
                content:
                    "Semantic Tag Highlighter: clear all overrides",
                callback: () =>
                    clearOverridesInteractively(),
            }
        );

        return items;
    },
});
