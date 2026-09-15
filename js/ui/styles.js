export function injectCss() {
    if (document.getElementById("sth-styles")) return;
    const style = document.createElement("style");
    style.id = "sth-styles";
    style.textContent = `
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
        .sth-context-menu {
            position: fixed;
            z-index: 2147483644;
            min-width: 210px;
            padding: 4px;
            box-sizing: border-box;
            border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
            border-radius: 6px;
            color: var(--input-text, #ddd);
            background: var(--comfy-menu-bg, #222);
            box-shadow: 0 6px 24px rgba(0, 0, 0, 0.42);
            font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .sth-context-item {
            display: flex;
            width: 100%;
            align-items: center;
            justify-content: space-between;
            gap: 14px;
            box-sizing: border-box;
            padding: 6px 8px;
            border: 0;
            border-radius: 4px;
            color: inherit;
            background: transparent;
            text-align: left;
            cursor: default;
            user-select: none;
        }
        .sth-context-item:not(:disabled):hover {
            background: color-mix(in srgb, currentColor 12%, transparent);
        }

        .sth-context-item:disabled {
            opacity: 0.42;
        }

        .sth-context-separator {
            height: 1px;
            margin: 4px 3px;
            background: color-mix(in srgb, currentColor 14%, transparent);
        }
        .sth-context-tag {
            max-width: 280px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding: 5px 8px 3px;
            opacity: 0.68;
            font: 11px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .sth-global-status {
            position: fixed;
            right: 14px;
            bottom: 14px;
            z-index: 2147483640;
            width: min(430px, calc(100vw - 28px));
            box-sizing: border-box;
            padding: 8px 10px;
            border-radius: 6px;
            white-space: pre-wrap;
            font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            color: var(--input-text, #ddd);
            background: color-mix(in srgb, var(--comfy-menu-bg, #252525) 97%, transparent);
            border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
            pointer-events: none;
            opacity: 0.92;
            transition: opacity 800ms ease;
        }
        .sth-global-status.sth-global-status-faded {
            opacity: 0;
        }

        .sth-global-status[data-phase="error"] {
            border-color: #ff6b6b;
        }

        .sth-global-status[data-phase="classifying"],
        .sth-global-status[data-phase="loading"] {
            border-color: #89ddff;
        }
    `;

    document.head.appendChild(style);
}
