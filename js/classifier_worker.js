import {
    HYPOTHESIS_TEMPLATE,
    MODEL_DTYPE,
    MODEL_ID,
    NLI_CANDIDATE_LABELS,
    zeroShotOutputToRecord,
} from "./classifier_schema.js";


const TRANSFORMERS_URLS = [
    // Official package CDN entrypoint for vanilla browser ESM.
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1",
    // Fallback through jsDelivr's ESM transform.
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm",
];


let transformers = null;
let classifier = null;
let loadPromise = null;


function safeProgress(info) {
    return {
        status: info?.status ?? "",
        file: info?.file ?? "",
        name: info?.name ?? "",
        progress:
            Number.isFinite(info?.progress)
                ? info.progress
                : null,
        loaded:
            Number.isFinite(info?.loaded)
                ? info.loaded
                : null,
        total:
            Number.isFinite(info?.total)
                ? info.total
                : null,
    };
}


async function importTransformers() {
    if (transformers) return transformers;

    let lastError = null;

    for (const url of TRANSFORMERS_URLS) {
        try {
            transformers = await import(url);
            return transformers;
        } catch (error) {
            lastError = error;
        }
    }

    throw (
        lastError ??
        new Error("Could not load Transformers.js")
    );
}


async function ensureLoaded() {
    if (classifier) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        self.postMessage({
            type: "status",
            state: "loading-runtime",
            message: "Loading Transformers.js…",
        });

        const { pipeline, env } =
            await importTransformers();

        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = true;

        /*
         * Do not pin ONNX Runtime WASM binaries separately.
         * Transformers.js knows which runtime version it expects and
         * loads its matching browser backend itself.
         */
        self.postMessage({
            type: "status",
            state: "loading-model",
            message:
                "Loading zero-shot semantic classifier…",
        });

        classifier = await pipeline(
            "zero-shot-classification",
            MODEL_ID,
            {
                dtype: MODEL_DTYPE,
                device: "wasm",
                progress_callback: (info) => {
                    self.postMessage({
                        type: "progress",
                        info: safeProgress(info),
                    });
                },
            }
        );

        self.postMessage({
            type: "status",
            state: "ready",
            message:
                "Zero-shot semantic classifier ready",
        });
    })();

    try {
        await loadPromise;
    } catch (error) {
        classifier = null;
        loadPromise = null;
        throw error;
    }
}


/**
 * Run each short prompt tag as a single-label zero-shot classification task.
 *
 * We deliberately do not batch candidate-label prompts ourselves. The
 * Transformers.js zero-shot pipeline owns tokenization/NLI formatting.
 */
async function classify(tags) {
    await ensureLoaded();

    if (!tags.length) return [];

    const texts =
        tags.map((item) => item.text);

    const outputs = await classifier(
        texts,
        NLI_CANDIDATE_LABELS,
        {
            hypothesis_template:
                HYPOTHESIS_TEMPLATE,
            multi_label: false,
        }
    );

    /*
     * For an array input Transformers.js returns one zero-shot result per
     * sequence. Keep a defensive single-input fallback in case a future
     * version returns the object directly for a one-element batch.
     */
    const batch =
        Array.isArray(outputs)
            ? outputs
            : [outputs];

    if (batch.length !== tags.length) {
        throw new Error(
            "Zero-shot classifier returned " +
            `${batch.length} results for ${tags.length} tags`
        );
    }

    return batch.map(
        (output, index) =>
            zeroShotOutputToRecord(
                tags[index].tag,
                output
            )
    );
}


self.addEventListener(
    "message",
    async (event) => {
        const message = event.data;

        if (
            !message ||
            message.type !== "classify"
        ) {
            return;
        }

        try {
            const startedAt = performance.now();

            const results = await classify(
                message.tags ?? []
            );

            self.postMessage({
                type: "result",
                requestId: message.requestId,
                results,
                elapsedMs:
                    performance.now() - startedAt,
            });
        } catch (error) {
            self.postMessage({
                type: "error",
                requestId: message.requestId,
                message:
                    error instanceof Error
                        ? error.message
                        : String(error),
            });
        }
    }
);
