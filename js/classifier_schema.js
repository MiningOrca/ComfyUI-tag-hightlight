export const MODEL_ID =
    "Xenova/all-MiniLM-L6-v2";

export const MODEL_DTYPE = "int8";
export const MODEL_VERSION =
    "Xenova-all-MiniLM-L6-v2-int8-linear-svm-c1-reviewed-v1";

export const TAXONOMY_VERSION = 5;

export const CACHE_NAMESPACE =
    `${MODEL_VERSION}:taxonomy-${TAXONOMY_VERSION}:`;

export function classificationCacheKey(tag) {
    return `${CACHE_NAMESPACE}${String(tag ?? "")}`;
}

export const ML_CATEGORY_DEFINITIONS = Object.freeze({
    subject:
        "a subject identity, gender, count, role, or general character descriptor",

    species:
        "a species, creature type, biological race, humanoid kind, or anthropomorphic animal type",

    anatomy:
        "a concrete body part, appendage, anatomical feature, or creature limb such as horns, wings, tail, ears, hands, claws, or face parts",

    appearance:
        "a physical appearance trait, body shape, body color, skin tone, makeup, cosmetic detail, or an attractive visual attribute",

    pose:
        "a body pose, posture, gesture, physical action, limb placement, or interaction of body parts",

    expression:
        "a facial expression, emotion, gaze direction, or eye contact",

    clothing:
        "clothing, costume, armor, footwear, jewelry, or a worn accessory",

    sexual:
        "nudity, sexual anatomy, sexual activity, fetish content, or explicitly sexual content",

    artist:
        "an artist, creator, illustrator, photographer, style author, or creator attribution tag",

    aesthetic:
        "a vibe, fashion aesthetic, mood adjective, subculture look, or overall visual feel such as goth, cute, edgy, elegant, or dark",

    style:
        "an artistic style, medium, rendering technique, line or shading approach, or named visual art style",

    camera:
        "a camera angle, viewpoint, framing, shot type, perspective, cropping choice, or composition instruction",

    lighting:
        "lighting, illumination, glow, shadow, contrast, or a light source description",

    environment:
        "a background, scenery, location, environment, setting, weather, time of day, or scene prop",

    quality:
        "image quality, resolution, sharpness, fidelity, or an overall quality rating",

    defect:
        "an unwanted visual defect, malformed anatomy, cropping error, duplication, missing part, compression artifact, or image generation failure",

    text_metadata:
        "visible text, letters, watermark, logo, signature, artist name, caption, or image metadata",
});

/*
 * Categories produced by the trained semantic head.
 *
 * "artist" intentionally stays outside the learned head: opaque creator
 * aliases are handled by explicit overrides / metadata instead of semantics.
 */
export const ML_CATEGORIES = Object.freeze([
    "subject",
    "species",
    "anatomy",
    "appearance",
    "pose",
    "expression",
    "clothing",
    "sexual",
    "aesthetic",
    "style",
    "camera",
    "lighting",
    "environment",
    "quality",
    "defect",
    "text_metadata",
]);

export const OVERRIDE_ONLY_CATEGORIES =
    Object.freeze(["artist"]);

export const SYNTAX_CATEGORIES =
    Object.freeze(["lora", "embedding", "wildcard"]);

export const ALL_CATEGORIES =
    Object.freeze([
        ...ML_CATEGORIES,
        ...OVERRIDE_ONLY_CATEGORIES,
        ...SYNTAX_CATEGORIES,
        "other",
    ]);

/*
 * LinearSVC decision-function values are not cosine similarities or calibrated
 * probabilities. Until rejection thresholds are calibrated separately from
 * OOF data, production uses pure argmax.
 */
export const DEFAULT_MIN_SCORE = Number.NEGATIVE_INFINITY;
export const DEFAULT_MIN_MARGIN = 0.0;


/**
 * Backward compatibility for overrides created by older versions.
 * This is category-name migration only; it is not tag-specific classification.
 */
export function normalizeCategory(category) {
    if (category === "body") return "anatomy";
    return ALL_CATEGORIES.includes(category)
        ? category
        : "other";
}


export function scoresToRecord(tag, scores) {
    if (!Array.isArray(scores) || !scores.length) {
        throw new Error(
            "Invalid classifier output: expected a non-empty score array"
        );
    }

    const ranked = scores.map((item) => ({
        category: String(item?.category ?? "other"),
        score: Number(item?.score),
    }));

    if (ranked.some((item) => !Number.isFinite(item.score))) {
        throw new Error(
            "Invalid classifier output: score must be finite"
        );
    }

    ranked.sort((a, b) => b.score - a.score);

    const best = ranked[0] ?? {
        category: "other",
        score: 0,
    };

    const second = ranked[1] ?? {
        category: "other",
        score: best.score,
    };

    return {
        tag,
        category: best.category,
        score: best.score,
        secondScore: second.score,
        margin: best.score - second.score,
    };
}
