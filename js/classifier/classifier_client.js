import {
    categoryForRecord,
} from "../prompt_parser.js";

import {
    MODEL_VERSION,
    TAXONOMY_VERSION,
    classificationCacheKey,
    normalizeCategory,
} from "../classifier_schema.js";

import {
    getClassifications,
    getOverrides,
    putClassifications,
} from "../storage.js";

import {
    CLASSIFY_BATCH_SIZE,
    checkedClassifications,
    checkedOverrides,
    memoryClassifications,
    memoryOverrides,
    minMargin,
    minScore,
    refreshAll,
    toast,
} from "../core/runtime.js";

import {
    debugLog,
    diagnosticState,
    formatProgress,
    logDecisionTable,
    renderGlobalStatus,
    setGlobalStatus,
    updateDiagnosticCounts,
} from "../ui/diagnostics.js";

export class ClassificationCoordinator {
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
            new URL("../classifier_worker.js", import.meta.url),
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

export const coordinator = new ClassificationCoordinator();

export async function hydrateTags(tags) {
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

export function resolvedCategory(segment) {
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
