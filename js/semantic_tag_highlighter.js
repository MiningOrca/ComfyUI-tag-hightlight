import { app } from "../../scripts/app.js";

import {
    categoryForRecord,
    classificationDecision,
    normalizeTag,
    parsePrompt,
} from "./prompt_parser.js";

import {
    ALL_CATEGORIES,
    DEFAULT_MIN_MARGIN,
    DEFAULT_MIN_SCORE,
    MODEL_VERSION,
    TAXONOMY_VERSION,
    classificationCacheKey,
    normalizeCategory,
} from "./classifier_schema.js";


import {
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
 * MiniLM is fast enough to classify a normal prompt in one batch. Keep a
 * moderate cap to avoid pathological giant text widgets.
 */
const CLASSIFY_BATCH_SIZE = 32;

const COLOR_DEFAULTS = {
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

const SETTINGS = {
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

const controllersByTextarea = new WeakMap();
const controllers = new Set();
const memoryClassifications = new Map();
const memoryOverrides = new Map();
const checkedClassifications = new Set();
const checkedOverrides = new Set();

let scanTimer = null;
let rafId = null;
let globalStatusPill = null;
let diagnosticTimer = null;
let statusFadeTimer = null;

const STATUS_IDLE_HOLD_MS = 5000;

const diagnosticState = {
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
    return DEFAULT_MIN_SCORE;
}

function minMargin() {
    return DEFAULT_MIN_MARGIN;
}

function pluginEnabled() {
    return Boolean(settingValue(SETTINGS.enabled, true));
}


function debugLoggingEnabled() {
    return Boolean(settingValue(SETTINGS.debugLogging, true));
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

function getTextareas(widget) {
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


function textareaExplicitName(textarea) {
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


function widgetTextareaStateKey(widget, textarea, index) {
    const base = widgetStateKey(widget);

    if (index === 0) {
        return base;
    }

    const explicit = textareaExplicitName(textarea);

    return explicit
        ? `${base}::${explicit}`
        : `${base}::textarea:${index + 1}`;
}


function widgetTextareaLabel(widget, textarea, index, total) {
    const explicit = textareaExplicitName(textarea);
    if (explicit) return explicit;

    const base = widgetLogicalName(widget);
    return total > 1
        ? `${base} #${index + 1}`
        : base;
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

function renderGlobalStatus() {
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

function setGlobalStatus(
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

function debugLog(level, message, data = undefined) {
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

function logDecisionTable(source, records) {
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

function updateDiagnosticCounts(rows, source) {
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

        debugLog(
            "info",
            `starting classifier worker • model=${MODEL_VERSION} • taxonomy=${TAXONOMY_VERSION}`
        );

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
            diagnosticState.busy = false;
            diagnosticState.error =
                event.message ||
                "Classifier worker failed";
            diagnosticState.phase = "error";
            diagnosticState.message =
                diagnosticState.error;
            this.resolveIdleWaiters();

            debugLog(
                "error",
                "classifier worker error",
                event
            );
            renderGlobalStatus();

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

        diagnosticState.queued =
            this.pending.size;
        diagnosticState.phase =
            this.busy
                ? "classifying"
                : "queued";
        diagnosticState.message =
            `queued: ${tag}`;

        debugLog(
            "debug",
            `queued "${tag}" • pending=${this.pending.size}`
        );
        renderGlobalStatus();

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
            diagnosticState.phase =
                "classifying";
            diagnosticState.busy = true;
            diagnosticState.batchStartedAt =
                performance.now();
            diagnosticState.queued =
                this.pending.size;
            diagnosticState.message =
                `batch: ${batch.map((item) => item.tag).join(", ")}`;

            debugLog(
                "info",
                `classifying batch ${requestId}`,
                {
                    tags:
                        batch.map(
                            (item) => item.tag
                        ),
                    pending:
                        this.pending.size,
                    minScore:
                        minScore(),
                    minMargin:
                        minMargin(),
                }
            );

            renderGlobalStatus();
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
            diagnosticState.phase =
                "loading";
            diagnosticState.message =
                formatProgress(message.info);

            debugLog(
                "debug",
                diagnosticState.message,
                message.info
            );
            renderGlobalStatus();
            return;
        }

        if (message.type === "status") {
            diagnosticState.phase =
                message.state === "ready"
                    ? "ready"
                    : "loading";
            diagnosticState.message =
                message.message ||
                "Loading semantic model…";

            debugLog(
                "info",
                `worker status: ${message.state}`,
                message
            );
            renderGlobalStatus();
            return;
        }

        if (message.type === "debug") {
            debugLog(
                "debug",
                message.message ||
                    "worker debug",
                message.data
            );
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
            diagnosticState.busy = false;
            diagnosticState.batchStartedAt = null;
            diagnosticState.phase = "error";
            diagnosticState.error =
                message.message ||
                "Classification failed";
            diagnosticState.message =
                diagnosticState.error;
            diagnosticState.queued =
                this.pending.size;

            debugLog(
                "error",
                `classification request ${message.requestId} failed`,
                {
                    error:
                        diagnosticState.error,
                    batch:
                        request.batch.map(
                            (item) => item.tag
                        ),
                }
            );
            renderGlobalStatus();

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

        const decisionRows =
            logDecisionTable(
                "model",
                records
            );
        updateDiagnosticCounts(
            decisionRows,
            "model"
        );

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
         * Paint after each batch so newly classified tags become visible
         * immediately even for unusually large text widgets.
         */
        refreshAll();

        const remaining =
            this.pending.size;

        diagnosticState.lastBatchMs =
            elapsedMs;
        diagnosticState.batchStartedAt =
            null;
        diagnosticState.busy = false;
        diagnosticState.queued =
            remaining;
        diagnosticState.error = null;

        debugLog(
            "info",
            `batch ${message.requestId} finished in ${(elapsedMs / 1000).toFixed(2)}s`,
            {
                classified:
                    records.length,
                pending:
                    remaining,
                accepted:
                    decisionRows.filter(
                        (row) => row.accepted
                    ).length,
                rejected:
                    decisionRows.filter(
                        (row) => !row.accepted
                    ).length,
            }
        );

        if (remaining) {
            diagnosticState.phase =
                "queued";
            diagnosticState.message =
                `${remaining} tag${remaining === 1 ? "" : "s"} waiting`;
            renderGlobalStatus();

            setTimeout(
                () => this.flush(),
                0
            );
        } else {
            diagnosticState.phase =
                "idle";
            diagnosticState.message =
                "idle";
            renderGlobalStatus();

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

            const cacheRecords = [];
            const cacheMissTags = [];

            for (let i = 0; i < classificationMisses.length; i += 1) {
                const tag = classificationMisses[i];
                const record = records[i];

                checkedClassifications.add(tag);

                if (record) {
                    memoryClassifications.set(tag, record);
                    cacheRecords.push(record);
                } else {
                    cacheMissTags.push(tag);
                }
            }

            if (cacheRecords.length) {
                const rows =
                    logDecisionTable(
                        "cache",
                        cacheRecords
                    );

                updateDiagnosticCounts(
                    rows,
                    "cache"
                );
            }

            if (cacheMissTags.length) {
                debugLog(
                    "info",
                    `cache miss: ${cacheMissTags.length} tag${cacheMissTags.length === 1 ? "" : "s"}`,
                    cacheMissTags
                );
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


function injectCss() {
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


function scanNode(node) {
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


async function openSemanticTagContextMenu(
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
            defaultValue: true,
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

        if (!diagnosticTimer) {
            diagnosticTimer = setInterval(
                renderGlobalStatus,
                500
            );
        }

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
    }
});
