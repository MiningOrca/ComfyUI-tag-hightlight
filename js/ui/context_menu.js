import {
    categoryForRecord,
    normalizeTag,
    parsePrompt,
} from "../prompt_parser.js";

import {
    deleteOverride,
    setOverride,
} from "../storage.js";

import {
    CATEGORIES,
    checkedOverrides,
    memoryClassifications,
    memoryOverrides,
    minMargin,
    minScore,
    refreshAll,
    toast,
} from "../core/runtime.js";

import { hydrateTags } from "../classifier/classifier_client.js";
import { debugLog } from "./diagnostics.js";
import { normalizeCategory } from "../classifier_schema.js";

let activeSemanticMenu = null;

function closeSemanticMenu() {
    if (!activeSemanticMenu) return;

    activeSemanticMenu.cleanup?.();
    activeSemanticMenu.root?.remove();
    activeSemanticMenu.submenu?.remove();
    activeSemanticMenu = null;
}

function tagAtTextareaSelection(textarea) {
    const value = String(textarea.value ?? "");
    const start = Number(textarea.selectionStart ?? 0);
    const end = Number(textarea.selectionEnd ?? start);
    if (end > start) {
        const selected = normalizeTag(
            value.slice(start, end)
        );

        if (selected && !selected.includes(",")) {
            return selected;
        }
    }

    const segments = parsePrompt(value);
    let offset = 0;

    for (const segment of segments) {
        const length =
            segment.raw.length +
            segment.comma.length;
        if (
            start >= offset &&
            start <= offset + length
        ) {
            return segment.normalized || "";
        }

        offset += length;
    }

    return "";
}

function placeMenu(element, x, y) {
    element.style.left = `${Math.max(4, x)}px`;
    element.style.top = `${Math.max(4, y)}px`;
    requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const left = Math.min(
            Math.max(4, x),
            window.innerWidth - rect.width - 4
        );
        const top = Math.min(
            Math.max(4, y),
            window.innerHeight - rect.height - 4
        );

        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
    });
}

function menuButton(label, callback, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sth-context-item";
    button.textContent = label;
    button.disabled = Boolean(disabled);

    if (!disabled && callback) {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeSemanticMenu();
            void callback();
        });
    }
    return button;
}

async function editOverrideForTag(tag) {
    if (!tag) return;

    await hydrateTags([tag]);

    const inferred =
        categoryForRecord(
            memoryClassifications.get(tag),
            minScore(),
            minMargin()
        );

    const current =
        memoryOverrides.get(tag) ??
        (inferred !== "other" ? inferred : "appearance");
    const category = window.prompt(
        `Semantic category for "${tag}":\n${CATEGORIES.join(", ")}`,
        current
    );

    if (category === null) return;

    const normalizedCategory =
        normalizeCategory(
            category.trim().toLowerCase()
        );
    if (
        normalizedCategory === "other" &&
        category.trim().toLowerCase() !== "other"
    ) {
        toast(
            "error",
            "Semantic Tag Highlighter",
            `Unknown category "${category.trim()}"`
        );
        return;
    }

    await setOverride(
        tag,
        normalizedCategory
    );

    memoryOverrides.set(
        tag,
        normalizedCategory
    );
    checkedOverrides.add(tag);
    debugLog(
        "info",
        `override set • ${tag} → ${normalizedCategory}`
    );

    refreshAll();
}

async function removeOverrideForTag(tag) {
    if (!tag) return;

    await deleteOverride(tag);
    memoryOverrides.delete(tag);
    checkedOverrides.add(tag);

    debugLog(
        "info",
        `override removed • ${tag}`
    );

    refreshAll();
}

export async function openSemanticTagContextMenu(
    controller,
    event
) {
    event.preventDefault();
    event.stopPropagation();
    closeSemanticMenu();

    const tag = tagAtTextareaSelection(
        controller.textarea
    );

    if (tag) {
        await hydrateTags([tag]);
    }

    const root = document.createElement("div");
    root.className = "sth-context-menu";

    const opener = document.createElement("button");
    opener.type = "button";
    opener.className = "sth-context-item";
    opener.innerHTML =
        `<span>Semantic tags</span><span>▶</span>`;
    root.appendChild(opener);
    const submenu = document.createElement("div");
    submenu.className = "sth-context-menu";
    submenu.style.display = "none";

    if (tag) {
        const tagLine = document.createElement("div");
        tagLine.className = "sth-context-tag";
        tagLine.textContent = tag;
        submenu.appendChild(tagLine);
    }

    const enabled =
        controller.isEnabledInWorkflow();
    submenu.appendChild(
        menuButton(
            enabled
                ? "Disable highlighting for this field"
                : "Enable highlighting for this field",
            () => {
                enabled
                    ? controller.disable()
                    : controller.enable();
            }
        )
    );

    const separator = document.createElement("div");
    separator.className = "sth-context-separator";
    submenu.appendChild(separator);
    submenu.appendChild(
        menuButton(
            tag
                ? `Edit override…`
                : "Edit override… (place caret on a tag)",
            () => editOverrideForTag(tag),
            !tag
        )
    );

    const hasOverride =
        Boolean(tag) &&
        memoryOverrides.has(tag);
    submenu.appendChild(
        menuButton(
            hasOverride
                ? "Remove override"
                : "Remove override (none set)",
            () => removeOverrideForTag(tag),
            !hasOverride
        )
    );

    document.body.appendChild(root);
    document.body.appendChild(submenu);

    const showSubmenu = () => {
        submenu.style.display = "block";
        const rootRect = root.getBoundingClientRect();
        const openerRect = opener.getBoundingClientRect();
        const subRect = submenu.getBoundingClientRect();

        let left = rootRect.right + 4;
        if (left + subRect.width > window.innerWidth - 4) {
            left = rootRect.left - subRect.width - 4;
        }

        const top = Math.min(
            openerRect.top,
            window.innerHeight - subRect.height - 4
        );
        submenu.style.left = `${Math.max(4, left)}px`;
        submenu.style.top = `${Math.max(4, top)}px`;
    };

    opener.addEventListener("mouseenter", showSubmenu);
    opener.addEventListener("click", (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        showSubmenu();
    });
    const closeOnPointer = (pointerEvent) => {
        if (
            root.contains(pointerEvent.target) ||
            submenu.contains(pointerEvent.target)
        ) {
            return;
        }

        closeSemanticMenu();
    };

    const closeOnKey = (keyEvent) => {
        if (keyEvent.key === "Escape") {
            closeSemanticMenu();
        }
    };
    document.addEventListener(
        "pointerdown",
        closeOnPointer,
        true
    );
    document.addEventListener(
        "keydown",
        closeOnKey,
        true
    );
    activeSemanticMenu = {
        root,
        submenu,
        cleanup: () => {
            document.removeEventListener(
                "pointerdown",
                closeOnPointer,
                true
            );
            document.removeEventListener(
                "keydown",
                closeOnKey,
                true
            );
        },
    };

    placeMenu(root, event.clientX, event.clientY);
}
