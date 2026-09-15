import {app} from "../../scripts/app.js";

import {
    COLOR_DEFAULTS,
    EXTENSION_NAME,
    SETTINGS,
    controllers,
    setRefreshAllHandler,
} from "./core/runtime.js";

import {
    ensureGlobalStatusPill,
    renderGlobalStatus,
    startDiagnostics,
} from "./ui/diagnostics.js";

import {
    scanAllNodes,
    scanNode,
} from "./highlighter/field_discovery.js";

import { injectCss } from "./ui/styles.js";

let scanTimer = null;

function refreshAll() {
    for (const controller of [...controllers]) {
        controller.syncEnabledState();
        controller.highlighter?.render();
    }
}

setRefreshAllHandler(refreshAll);

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
            id: SETTINGS.debugLogging,
            category: [
                "Semantic Tag Highlighter",
                "Classifier",
                "Debug logging",
            ],
            name: "Log classifier activity to browser console",
            tooltip:
                "Logs queue/cache/model decisions as console tables, including score, margin and rejection reason.",
            type: "boolean",
            defaultValue: false,
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
        renderGlobalStatus();
        startDiagnostics();

        if (!scanTimer) {
            scanTimer = setInterval(
                scanAllNodes,
                700
            );
        }
    }
});
