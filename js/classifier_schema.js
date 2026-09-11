export const MODEL_ID =
    "Xenova/all-MiniLM-L6-v2";

export const MODEL_DTYPE = "int8";
export const MODEL_VERSION =
    "Xenova-all-MiniLM-L6-v2-int8-definition-cosine-v1";

export const TAXONOMY_VERSION = 4;

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

/*
 * MiniLM cosine scores from the real browser benchmark clustered around
 * ~0.23–0.54 for useful semantic matches. A 0.20 floor rejects weak/opaque
 * tags while retaining the observed good booru-style matches. Margin is not
 * used by default because several valid categories are naturally close in
 * embedding space; it remains configurable in Settings.
 */
export const DEFAULT_MIN_SCORE = 0.20;
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
            "Invalid cosine classifier output: expected a non-empty score array"
        );
    }

    const ranked = scores.map((item) => ({
        category: String(item?.category ?? "other"),
        score: Number(item?.score),
    }));

    if (ranked.some((item) => !Number.isFinite(item.score))) {
        throw new Error(
            "Invalid cosine classifier output: score must be finite"
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
