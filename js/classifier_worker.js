import {
    ML_CATEGORIES,
    MODEL_DTYPE,
    MODEL_ID,
    scoresToRecord,
} from "./classifier_schema.js";


const TRANSFORMERS_URLS = [
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1",
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm",
];

const CLASSIFIER_URL =
    new URL("./models/semantic_classifier.json", import.meta.url);

const CLASSIFIER_FORMAT =
    "semantic-tag-highlighter-linear-v1";

const WEIGHT_LAYOUT =
    "feature-major: weights[input_index * outputDimension + category_index]";


let transformers = null;
let extractor = null;
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


function validateClassifier(model) {
    if (!model || model.format !== CLASSIFIER_FORMAT) {
        throw new Error(
            `Unsupported classifier format: ${model?.format ?? "<missing>"}`
        );
    }

    if (
        model.encoder?.id !== MODEL_ID ||
        model.encoder?.dtype !== MODEL_DTYPE ||
        model.encoder?.pooling !== "mean" ||
        model.encoder?.normalized !== true
    ) {
        throw new Error(
            "Classifier encoder metadata does not match the MiniLM runtime"
        );
    }

    if (
        !Number.isInteger(model.inputDimension) ||
        !Number.isInteger(model.outputDimension) ||
        model.inputDimension <= 0 ||
        model.outputDimension <= 0
    ) {
        throw new Error("Classifier dimensions are invalid");
    }

    if (
        !Array.isArray(model.categories) ||
        model.categories.length !== model.outputDimension ||
        model.categories.some(
            (category, index) =>
                category !== ML_CATEGORIES[index]
        )
    ) {
        throw new Error(
            "Classifier categories do not match the production semantic taxonomy"
        );
    }

    if (model.weightLayout !== WEIGHT_LAYOUT) {
        throw new Error(
            `Unsupported classifier weight layout: ${model.weightLayout}`
        );
    }

    if (
        !Array.isArray(model.weights) ||
        model.weights.length !==
            model.inputDimension * model.outputDimension ||
        model.weights.some((value) => !Number.isFinite(value))
    ) {
        throw new Error("Classifier weights are invalid");
    }

    if (
        !Array.isArray(model.bias) ||
        model.bias.length !== model.outputDimension ||
        model.bias.some((value) => !Number.isFinite(value))
    ) {
        throw new Error("Classifier bias is invalid");
    }

    return model;
}


function linearScores(vector) {
    if (vector.length !== classifier.inputDimension) {
        throw new Error(
            `MiniLM embedding dimension ${vector.length} does not match classifier input ${classifier.inputDimension}`
        );
    }

    const scores =
        classifier.bias.map((value) => Number(value));

    for (
        let inputIndex = 0;
        inputIndex < classifier.inputDimension;
        inputIndex += 1
    ) {
        const value = vector[inputIndex];
        const offset =
            inputIndex * classifier.outputDimension;

        for (
            let categoryIndex = 0;
            categoryIndex < classifier.outputDimension;
            categoryIndex += 1
        ) {
            scores[categoryIndex] +=
                value *
                classifier.weights[
                    offset + categoryIndex
                ];
        }
    }

    return classifier.categories.map(
        (category, index) => ({
            category,
            score: scores[index],
        })
    );
}


async function ensureLoaded() {
    if (extractor && classifier) return;
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
            state: "loading-classifier",
            message: "Loading trained semantic classifier…",
        });

        const response = await fetch(
            CLASSIFIER_URL,
            { cache: "no-cache" }
        );

        if (!response.ok) {
            throw new Error(
                `Could not load trained classifier: HTTP ${response.status}`
            );
        }

        classifier =
            validateClassifier(await response.json());

        self.postMessage({
            type: "debug",
            message:
                `MiniLM + linear classifier loaded • encoder=${MODEL_ID} • dtype=${MODEL_DTYPE} • head=${classifier.model} • categories=${classifier.categories.length}`,
        });

        self.postMessage({
            type: "status",
            state: "ready",
            message: "Trained semantic classifier ready",
        });
    })();

    try {
        await loadPromise;
    } catch (error) {
        extractor = null;
        classifier = null;
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

        return scoresToRecord(
            item.tag,
            linearScores(vector)
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
