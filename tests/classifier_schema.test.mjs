import assert from "node:assert/strict";

import {
    ALL_CATEGORIES,
    CACHE_NAMESPACE,
    DEFAULT_MIN_MARGIN,
    DEFAULT_MIN_SCORE,
    ML_CATEGORIES,
    ML_CATEGORY_DEFINITIONS,
    MODEL_DTYPE,
    MODEL_ID,
    MODEL_VERSION,
    TAXONOMY_VERSION,
    classificationCacheKey,
    normalizeCategory,
    scoresToRecord,
} from "../js/classifier_schema.js";

assert.equal(
    MODEL_ID,
    "Xenova/all-MiniLM-L6-v2"
);
assert.equal(MODEL_DTYPE, "int8");
assert.equal(TAXONOMY_VERSION, 4);
assert.match(MODEL_VERSION, /MiniLM/);

assert.equal(
    CACHE_NAMESPACE,
    `${MODEL_VERSION}:taxonomy-${TAXONOMY_VERSION}:`
);
assert.equal(
    classificationCacheKey("goth"),
    `${MODEL_VERSION}:taxonomy-${TAXONOMY_VERSION}:goth`
);

assert.equal(
    new Set(ML_CATEGORIES).size,
    ML_CATEGORIES.length
);
assert.equal(
    new Set(ALL_CATEGORIES).size,
    ALL_CATEGORIES.length
);

for (const category of ML_CATEGORIES) {
    assert.ok(
        ML_CATEGORY_DEFINITIONS[category],
        `Missing definition for ${category}`
    );
}

const definitions =
    Object.values(ML_CATEGORY_DEFINITIONS)
        .join("\n")
        .toLowerCase();

for (const forbidden of [
    "perfect eyes",
    "looking at viewer",
    "anthro dragon",
    "purple lipstick",
    "hand between legs",
]) {
    assert.equal(
        definitions.includes(forbidden),
        false,
        `Concrete tag leaked into taxonomy definition: ${forbidden}`
    );
}

const record = scoresToRecord(
    "dragon wings",
    [
        { category: "species", score: 0.21 },
        { category: "anatomy", score: 0.41 },
        { category: "appearance", score: 0.30 },
    ]
);

assert.equal(record.category, "anatomy");
assert.equal(record.score, 0.41);
assert.equal(record.secondScore, 0.30);
assert.ok(Math.abs(record.margin - 0.11) < 1e-12);

assert.throws(
    () => scoresToRecord("x", []),
    /non-empty score array/
);
assert.throws(
    () => scoresToRecord(
        "x",
        [{ category: "species", score: NaN }]
    ),
    /score must be finite/
);

assert.equal(normalizeCategory("body"), "anatomy");
assert.equal(normalizeCategory("appearance"), "appearance");
assert.equal(normalizeCategory("nonsense"), "other");

assert.equal(DEFAULT_MIN_SCORE, 0.20);
assert.equal(DEFAULT_MIN_MARGIN, 0.0);

console.log("classifier schema tests: OK");
