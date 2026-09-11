import {
    ML_CATEGORY_DEFINITIONS,
    MODEL_DTYPE,
    MODEL_ID,
    scoresToRecord,
} from "./classifier_schema.js";


const TRANSFORMERS_URLS = [
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1",
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm",
];


let transformers = null;
let extractor = null;
let categoryVectors = null;
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

            self.postMessage({
                type: "debug",
                message:
                    `Transformers.js runtime loaded from ${url}`,
            });

            return transformers;
        } catch (error) {
            lastError = error;

            self.postMessage({
                type: "debug",
                message:
                    `Transformers.js import failed from ${url}`,
                data:
                    error instanceof Error
                        ? error.message
                        : String(error),
            });
        }
    }

    throw (
        lastError ??
        new Error("Could not load Transformers.js")
    );
}


function dot(a, b) {
    let sum = 0;
    const length = Math.min(a.length, b.length);

    for (let i = 0; i < length; i += 1) {
        sum += a[i] * b[i];
    }

    return sum;
}


async function ensureLoaded() {
    if (extractor && categoryVectors) return;
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

        self.postMessage({
            type: "status",
            state: "loading-model",
            message: "Loading MiniLM semantic classifier…",
        });

        extractor = await pipeline(
            "feature-extraction",
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
            state: "loading-taxonomy",
            message: "Embedding semantic categories…",
        });

        const entries =
            Object.entries(ML_CATEGORY_DEFINITIONS)
                .map(([category, definition]) => ({
                    category,
                    text: `${category}: ${definition}`,
                }));

        const tensor = await extractor(
            entries.map((item) => item.text),
            {
                pooling: "mean",
                normalize: true,
            }
        );

        const rows = tensor.tolist();

        categoryVectors =
            entries.map((item, index) => ({
                category: item.category,
                vector: rows[index],
            }));

        self.postMessage({
            type: "debug",
            message:
                `MiniLM classifier loaded • model=${MODEL_ID} • dtype=${MODEL_DTYPE} • categories=${categoryVectors.length}`,
        });

        self.postMessage({
            type: "status",
            state: "ready",
            message: "MiniLM semantic classifier ready",
        });
    })();

    try {
        await loadPromise;
    } catch (error) {
        extractor = null;
        categoryVectors = null;
        loadPromise = null;
        throw error;
    }
}


async function classify(tags) {
    await ensureLoaded();

    if (!tags.length) return [];

    const texts =
        tags.map((item) => item.text);

    self.postMessage({
        type: "debug",
        message:
            `MiniLM inference start • ${texts.length} tag${texts.length === 1 ? "" : "s"}`,
        data: texts,
    });

    const tensor = await extractor(
        texts,
        {
            pooling: "mean",
            normalize: true,
        }
    );

    const rows = tensor.tolist();

    return tags.map((item, index) => {
        const vector = rows[index];

        const scores =
            categoryVectors.map((category) => ({
                category: category.category,
                score: dot(vector, category.vector),
            }));

        return scoresToRecord(
            item.tag,
            scores
        );
    });
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
