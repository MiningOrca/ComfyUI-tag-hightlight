import { app } from "../../../scripts/app.js";

import {
    controllers,
    controllersByTextarea,
    getTextareas,
    widgetTextareaLabel,
    widgetTextareaStateKey,
} from "../core/runtime.js";

import { FieldController } from "./field_controller.js";
import { debugLog } from "../ui/diagnostics.js";

export function scanNode(node) {
    if (!node?.widgets) return;
    for (const widget of node.widgets) {
        const textareas = getTextareas(widget);

        for (let index = 0; index < textareas.length; index += 1) {
            const textarea = textareas[index];

            if (controllersByTextarea.has(textarea)) {
                continue;
            }

            const key = widgetTextareaStateKey(
                widget,
                textarea,
                index
            );
            const label = widgetTextareaLabel(
                widget,
                textarea,
                index,
                textareas.length
            );

            debugLog(
                "info",
                `textarea discovered • node=${node.comfyClass ?? node.type ?? "unknown"} • field=${label} • key=${key}`
            );
            new FieldController(
                node,
                widget,
                textarea,
                key,
                label
            );
        }
    }
}

export function scanAllNodes() {
    const nodes =
        app.graph?._nodes ??
        app.rootGraph?._nodes ??
        [];

    for (const node of nodes) {
        scanNode(node);
    }
    for (const controller of [...controllers]) {
        controller.syncDomState();
    }
}
