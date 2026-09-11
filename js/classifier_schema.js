export const MODEL_ID =
    "MoritzLaurer/deberta-v3-xsmall-zeroshot-v1.1-all-33";

export const MODEL_DTYPE = "q8";
export const MODEL_VERSION =
    "MoritzLaurer-deberta-v3-xsmall-zeroshot-v1.1-all-33-q8";

export const TAXONOMY_VERSION = 3;

export const CACHE_NAMESPACE =
    `${MODEL_VERSION}:taxonomy-${TAXONOMY_VERSION}:`;

export function classificationCacheKey(tag) {
    return `${CACHE_NAMESPACE}${String(tag ?? "")}`;
}

export const ML_CATEGORY_DEFINITIONS = Object.freeze({
    subject:
        "a subject identity, gender, count, or general person descriptor",

    species:
        "a species, creature type, biological race, or humanoid or animal kind",

    anatomy:
        "an anatomical body part, physical trait, body shape, color, or appearance",

    pose:
        "a body pose, posture, gesture, physical action, or limb position",

    expression:
        "a facial expression, emotion, gaze direction, or eye contact",

    clothing:
        "clothing, footwear, armor, jewelry, or a worn accessory",

    sexual:
        "nudity, sexual anatomy, sexual activity, or explicitly sexual content",

    artist:
        "an artist, creator, illustrator, photographer, or creator attribution",

    style:
        "an artistic style, medium, rendering technique, or visual aesthetic",

    camera:
        "a camera angle, viewpoint, framing, shot type, perspective, or composition",

    lighting:
        "lighting, illumination, shadow, glow, or a light source",

    environment:
        "a background, scenery, location, environment, setting, or scene prop",

    quality:
        "image quality, resolution, sharpness, fidelity, or a quality rating",

    defect:
        "an unwanted visual defect, malformed anatomy, cropping error, artifact, or generation failure",

    text_metadata:
        "visible text, watermark, logo, signature, creator name, or image metadata",
});

export const ML_CATEGORIES =
    Object.freeze(Object.keys(ML_CATEGORY_DEFINITIONS));

export const SYNTAX_CATEGORIES =
    Object.freeze(["lora", "embedding", "wildcard"]);

export const ALL_CATEGORIES =
    Object.freeze([
        ...ML_CATEGORIES,
        ...SYNTAX_CATEGORIES,
        "other",
    ]);

export const NLI_LABEL_TO_CATEGORY = Object.freeze(
    Object.fromEntries(
        Object.entries(ML_CATEGORY_DEFINITIONS).map(
            ([category, label]) => [label, category]
        )
    )
);

export const NLI_CANDIDATE_LABELS =
    Object.freeze(Object.keys(NLI_LABEL_TO_CATEGORY));

export const HYPOTHESIS_TEMPLATE =
    "This prompt tag describes {}.";

export const DEFAULT_MIN_SCORE = 0.16;
export const DEFAULT_MIN_MARGIN = 0.025;


/**
 * Backward compatibility for overrides created by the MiniLM prototype version.
 * This is category-name migration only; it is not tag-specific classification.
 */
export function normalizeCategory(category) {
    if (category === "body") return "anatomy";
    return ALL_CATEGORIES.includes(category)
        ? category
        : "other";
}


export function zeroShotOutputToRecord(tag, output) {
    if (
        !output ||
        !Array.isArray(output.labels) ||
        !Array.isArray(output.scores) ||
        output.labels.length === 0 ||
        output.labels.length !== output.scores.length
    ) {
        throw new Error(
            "Invalid zero-shot classifier output: expected equally sized labels/scores arrays"
        );
    }

    const ranked = output.labels.map((label, index) => ({
        label,
        category: NLI_LABEL_TO_CATEGORY[label] ?? "other",
        score: Number(output.scores[index]),
    }));

    ranked.sort((a, b) => b.score - a.score);

    const best = ranked[0] ?? {
        category: "other",
        score: 0,
    };

    const second = ranked[1] ?? {
        category: "other",
        score: 0,
    };

    return {
        tag,
        category: best.category,
        score: Number.isFinite(best.score) ? best.score : 0,
        secondScore: Number.isFinite(second.score) ? second.score : 0,
        margin:
            Number.isFinite(best.score) &&
            Number.isFinite(second.score)
                ? best.score - second.score
                : 0,
    };
}
