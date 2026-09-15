import {
    controllers,
    controllersByTextarea,
    getNodeState,
    pluginEnabled,
    setNodeState,
} from "../core/runtime.js";

import { PromptHighlighter } from "./prompt_highlighter.js";
import { openSemanticTagContextMenu } from "../ui/context_menu.js";
import { renderGlobalStatus } from "../ui/diagnostics.js";

export class FieldController {
    constructor(
        node,
        widget,
        textarea,
        key,
        label
    ) {
        this.node = node;
        this.widget = widget;
        this.textarea = textarea;
        this.key = key;
        this.label = label;
        this.highlighter = null;

        this.onContextMenu = (event) => {
            if (event.shiftKey) {
                // Shift+right-click keeps the native browser text menu available.
                return;
            }
            void openSemanticTagContextMenu(
                this,
                event
            );
        };

        this.textarea.addEventListener(
            "contextmenu",
            this.onContextMenu
        );

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
            return;
        }

        if (this.isEnabledInWorkflow()) {
            this.ensureHighlighter();
        } else {
            this.destroyHighlighter();
        }
    }

    enable() {
        const state = getNodeState(this.node);

        if (!state.enabledWidgets.includes(this.key)) {
            state.enabledWidgets.push(this.key);
            setNodeState(this.node, state);
        }
        this.syncEnabledState();
        renderGlobalStatus();
    }

    disable() {
        const state = getNodeState(this.node);

        state.enabledWidgets =
            state.enabledWidgets.filter(
                (key) => key !== this.key
            );

        setNodeState(this.node, state);
        this.syncEnabledState();
        renderGlobalStatus();
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

        this.highlighter?.syncStyle();
    }

    destroy() {
        this.textarea.removeEventListener(
            "contextmenu",
            this.onContextMenu
        );

        this.destroyHighlighter();
        if (
            controllersByTextarea.get(this.textarea) === this
        ) {
            controllersByTextarea.delete(this.textarea);
        }

        controllers.delete(this);
        renderGlobalStatus();
    }
}
