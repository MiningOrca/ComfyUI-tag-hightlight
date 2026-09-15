import { classificationDecision } from "../prompt_parser.js";

import {
    controllers,
    debugLoggingEnabled,
    minMargin,
    minScore,
    pluginEnabled,
} from "../core/runtime.js";

let globalStatusPill = null;
let diagnosticTimer = null;
let statusFadeTimer = null;

const STATUS_IDLE_HOLD_MS = 5000;

export const diagnosticState = {
    phase: "idle",
    message: "idle",
    queued: 0,
    busy: false,
    classified: 0,
    accepted: 0,
    rejected: 0,
    cacheHits: 0,
    cacheRejected: 0,
    lastBatchMs: null,
    batchStartedAt: null,
    lastOutcome: "",
    error: null,
};

export function ensureGlobalStatusPill() {
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

function hasEnabledFields() {
    return [...controllers].some(
        (controller) =>
            controller.isEnabledInWorkflow?.()
    );
}

function resetGlobalStatusFade(pill) {
    if (statusFadeTimer) {
        clearTimeout(statusFadeTimer);
        statusFadeTimer = null;
    }

    pill.classList.remove("sth-global-status-faded");
}

function scheduleGlobalStatusFade(pill) {
    const idle =
        diagnosticState.phase === "idle" &&
        !diagnosticState.busy &&
        diagnosticState.queued === 0 &&
        !diagnosticState.error;

    if (!idle) {
        resetGlobalStatusFade(pill);
        return;
    }

    if (
        statusFadeTimer ||
        pill.classList.contains("sth-global-status-faded")
    ) {
        return;
    }

    statusFadeTimer = setTimeout(() => {
        statusFadeTimer = null;
        if (
            diagnosticState.phase === "idle" &&
            !diagnosticState.busy &&
            diagnosticState.queued === 0 &&
            !diagnosticState.error
        ) {
            pill.classList.add("sth-global-status-faded");
        }
    }, STATUS_IDLE_HOLD_MS);
}

export function renderGlobalStatus() {
    const pill = ensureGlobalStatusPill();
    const shouldShow =
        pluginEnabled() &&
        (
            hasEnabledFields() ||
            diagnosticState.phase !== "idle" ||
            diagnosticState.error
        );

    if (!shouldShow) {
        resetGlobalStatusFade(pill);
        pill.style.display = "none";
        return;
    }

    scheduleGlobalStatusFade(pill);
    const elapsed =
        diagnosticState.busy &&
        diagnosticState.batchStartedAt
            ? performance.now() -
              diagnosticState.batchStartedAt
            : diagnosticState.lastBatchMs;

    const timing =
        Number.isFinite(elapsed)
            ? ` • ${(elapsed / 1000).toFixed(1)}s`
            : "";
    const cachePart =
        diagnosticState.cacheHits
            ? ` • cache ${diagnosticState.cacheHits}` +
              (
                  diagnosticState.cacheRejected
                      ? ` (${diagnosticState.cacheRejected} white)`
                      : ""
              )
            : "";
    const sessionPart =
        diagnosticState.classified
            ? `new ${diagnosticState.classified}` +
              ` • colored ${diagnosticState.accepted}` +
              ` • white ${diagnosticState.rejected}`
            : "new 0";

    pill.dataset.phase =
        diagnosticState.error
            ? "error"
            : diagnosticState.phase;
    pill.textContent =
        `Semantic tags • ${diagnosticState.phase}${timing}\n` +
        `queue ${diagnosticState.queued}` +
        ` • ${sessionPart}${cachePart}` +
        (
            diagnosticState.message &&
            diagnosticState.message !== diagnosticState.phase
                ? `\n${diagnosticState.message}`
                : ""
        ) +
        (
            diagnosticState.lastOutcome
                ? `\nlast: ${diagnosticState.lastOutcome}`
                : ""
        );
    pill.style.display = "block";
}

export function setGlobalStatus(
    message,
    visible = true,
    phase = null
) {
    if (phase) {
        diagnosticState.phase = phase;
    }

    diagnosticState.message =
        message || diagnosticState.phase || "idle";

    if (!visible) {
        diagnosticState.phase = "idle";
        diagnosticState.message = "idle";
        diagnosticState.busy = false;
        diagnosticState.batchStartedAt = null;
    }

    renderGlobalStatus();
}

export function debugLog(level, message, data = undefined) {
    if (!debugLoggingEnabled()) return;

    const prefix = "[Semantic Tag Highlighter]";
    const fn =
        level === "error"
            ? console.error
            : level === "warn"
                ? console.warn
                : level === "debug"
                    ? console.debug
                    : console.info;
    if (data === undefined) {
        fn(`${prefix} ${message}`);
    } else {
        fn(`${prefix} ${message}`, data);
    }
}

function decisionRow(tag, record, source) {
    const decision =
        classificationDecision(
            record,
            minScore(),
            minMargin()
        );
    return {
        tag,
        source,
        rawCategory:
            record?.category ?? "<none>",
        score:
            Number.isFinite(Number(record?.score))
                ? Number(record.score).toFixed(4)
                : "",
        margin:
            Number.isFinite(Number(record?.margin))
                ? Number(record.margin).toFixed(4)
                : "",
        effectiveCategory:
            decision.category,
        accepted:
            decision.accepted,
        reason:
            decision.reason,
    };
}

export function logDecisionTable(source, records) {
    const rows =
        records.map(
            (record) =>
                decisionRow(
                    record.tag,
                    record,
                    source
                )
        );

    if (debugLoggingEnabled() && rows.length) {
        console.groupCollapsed(
            `[Semantic Tag Highlighter] ${source}: ${rows.length} tag${rows.length === 1 ? "" : "s"}`
        );
        console.table(rows);
        console.groupEnd();
    }
    return rows;
}

export function updateDiagnosticCounts(rows, source) {
    if (!rows.length) return;

    const rejected =
        rows.filter(
            (row) => !row.accepted
        ).length;
    if (source === "cache") {
        diagnosticState.cacheHits +=
            rows.length;
        diagnosticState.cacheRejected +=
            rejected;
    } else if (source === "model") {
        diagnosticState.classified +=
            rows.length;
        diagnosticState.rejected +=
            rejected;
        diagnosticState.accepted +=
            rows.length - rejected;
    }

    const last = rows.at(-1);
    if (last) {
        diagnosticState.lastOutcome =
            `${last.tag} → ` +
            `${last.effectiveCategory}` +
            (
                last.accepted
                    ? ""
                    : ` (${last.reason})`
            );
    }

    renderGlobalStatus();
}

export function formatProgress(info) {
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

export function startDiagnostics() {
    if (!diagnosticTimer) {
        diagnosticTimer = setInterval(
            renderGlobalStatus,
            500
        );
    }
}
