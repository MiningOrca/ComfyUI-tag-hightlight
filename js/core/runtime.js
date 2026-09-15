import { app } from "../../../scripts/app.js";

import {
    ALL_CATEGORIES,
    DEFAULT_MIN_MARGIN,
    DEFAULT_MIN_SCORE,
} from "../classifier_schema.js";

export const EXTENSION_NAME = "semantic_tag_highlighter";
const STATE_PROPERTY = "__semantic_tag_highlighter";

export const CATEGORIES = ALL_CATEGORIES;
export const CLASSIFY_BATCH_SIZE = 32;
export const COLOR_DEFAULTS = {
    subject: "#82aaff",
    species: "#c792ea",
    anatomy: "#f78c6c",
    appearance: "#ff9e64",
    pose: "#ffcb6b",
    expression: "#f07178",
    clothing: "#89ddff",
    sexual: "#ff7ab2",
    artist: "#b4f9f8",
    aesthetic: "#c3e88d",
    style: "#a6da95",
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

export const SETTINGS = {
    enabled: "SemanticTagHighlighter.Enabled",
    debugLogging: "SemanticTagHighlighter.DebugLogging",
    colors: Object.fromEntries(
        Object.keys(COLOR_DEFAULTS).map(
            (category) => [
                category,
                `SemanticTagHighlighter.Color.${category}`,
            ]
        )
    ),
};

export const controllersByTextarea = new WeakMap();
export const controllers = new Set();
export const memoryClassifications = new Map();
export const memoryOverrides = new Map();
export const checkedClassifications = new Set();
export const checkedOverrides = new Set();

let refreshAllHandler = () => {};

export function setRefreshAllHandler(handler) {
    refreshAllHandler =
        typeof handler === "function"
            ? handler
            : () => {};
}

export function refreshAll() {
    refreshAllHandler();
}

export function settingValue(id, fallback) {
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

export function toast(severity, summary, detail) {
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

export function getColor(category) {
    if (category === "other") return null;

    return settingValue(
        SETTINGS.colors[category],
        COLOR_DEFAULTS[category] ?? null
    );
}

export function minScore() {
    return DEFAULT_MIN_SCORE;
}

export function minMargin() {
    return DEFAULT_MIN_MARGIN;
}

export function pluginEnabled() {
    return Boolean(settingValue(SETTINGS.enabled, true));
}

export function debugLoggingEnabled() {
    return Boolean(settingValue(SETTINGS.debugLogging, true));
}

export function getNodeState(node) {
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

export function setNodeState(node, state) {
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

export function widgetLogicalName(widget) {
    if (widget?.__dptLogicalName) {
        return String(widget.__dptLogicalName);
    }

    return String(
        widget?.label ??
        widget?.name ??
        "text"
    );
}

export function widgetStateKey(widget) {
    if (widget?.__dptLogicalName) {
        return `dpt:${widget.__dptLogicalName}`;
    }

    return String(widget?.name ?? widgetLogicalName(widget));
}

export function getTextareas(widget) {
    if (!widget) return [];
    const found = [];
    const seen = new Set();

    const add = (element) => {
        if (
            !(element instanceof HTMLTextAreaElement) ||
            seen.has(element)
        ) {
            return;
        }

        seen.add(element);
        found.push(element);
    };

    add(widget.element);
    add(widget.inputEl);
    add(widget.__dptTextarea);
    for (const container of [widget.element, widget.inputEl]) {
        if (
            !(container instanceof HTMLElement) ||
            container instanceof HTMLTextAreaElement
        ) {
            continue;
        }

        for (const textarea of container.querySelectorAll("textarea")) {
            add(textarea);
        }
    }

    return found;
}

export function textareaExplicitName(textarea) {
    const candidates = [
        textarea?.dataset?.name,
        textarea?.dataset?.field,
        textarea?.getAttribute?.("name"),
        textarea?.getAttribute?.("aria-label"),
        textarea?.getAttribute?.("placeholder"),
    ];

    for (const candidate of candidates) {
        const value = String(candidate ?? "").trim();

        if (value && value.length <= 80) {
            return value;
        }
    }

    return null;
}

export function widgetTextareaStateKey(widget, textarea, index) {
    const base = widgetStateKey(widget);

    if (index === 0) {
        return base;
    }

    const explicit = textareaExplicitName(textarea);

    return explicit
        ? `${base}::${explicit}`
        : `${base}::textarea:${index + 1}`;
}

export function widgetTextareaLabel(widget, textarea, index, total) {
    const explicit = textareaExplicitName(textarea);
    if (explicit) return explicit;
    const base = widgetLogicalName(widget);
    return total > 1
        ? `${base} #${index + 1}`
        : base;
}
