import assert from "node:assert/strict";

import {
    ALL_CATEGORIES,
    CACHE_NAMESPACE,
    DEFAULT_MIN_MARGIN,
    DEFAULT_MIN_SCORE,
    HYPOTHESIS_TEMPLATE,
    ML_CATEGORIES,
    ML_CATEGORY_DEFINITIONS,
    MODEL_DTYPE,
    MODEL_ID,
    MODEL_VERSION,
    NLI_CANDIDATE_LABELS,
    NLI_LABEL_TO_CATEGORY,
    TAXONOMY_VERSION,
    classificationCacheKey,
    normalizeCategory,
    zeroShotOutputToRecord,
} from "../js/classifier_schema.js";


// Model/config contract.
assert.equal(
    MODEL_ID,
    "MoritzLaurer/deberta-v3-xsmall-zeroshot-v1.1-all-33"
);
assert.equal(MODEL_DTYPE, "q8");
assert.equal(TAXONOMY_VERSION, 3);
assert.equal(
    HYPOTHESIS_TEMPLATE,
    "This prompt tag describes {}."
);

// Regression: v3 initially referenced CACHE_NAMESPACE from the UI module
// without defining/importing it, which stopped classification before worker
// inference. Cache-key construction now belongs to the shared tested schema.
assert.equal(
    CACHE_NAMESPACE,
    `${MODEL_VERSION}:taxonomy-${TAXONOMY_VERSION}:`
);
assert.equal(
    classificationCacheKey("looking at viewer"),
    `${MODEL_VERSION}:taxonomy-${TAXONOMY_VERSION}:looking at viewer`
);
assert.equal(
    classificationCacheKey(""),
    `${MODEL_VERSION}:taxonomy-${TAXONOMY_VERSION}:`
);


// Taxonomy sanity.
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

for (const label of NLI_CANDIDATE_LABELS) {
    assert.ok(
        NLI_LABEL_TO_CATEGORY[label],
        `Unmapped NLI label: ${label}`
    );
}


// Guard against the previous failure mode: category definitions must remain
// abstract. These are regression examples, NOT embedded classifier rules.
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


// Simulated Transformers.js zero-shot output -> plugin record.
const speciesLabel =
    ML_CATEGORY_DEFINITIONS.species;
const anatomyLabel =
    ML_CATEGORY_DEFINITIONS.anatomy;
const expressionLabel =
    ML_CATEGORY_DEFINITIONS.expression;

const speciesRecord =
    zeroShotOutputToRecord(
        "human",
        {
            sequence: "human",
            labels: [
                anatomyLabel,
                speciesLabel,
                expressionLabel,
            ],
            scores: [
                0.11,
                0.77,
                0.12,
            ],
        }
    );

assert.equal(speciesRecord.tag, "human");
assert.equal(speciesRecord.category, "species");
assert.equal(speciesRecord.score, 0.77);
assert.equal(speciesRecord.secondScore, 0.12);
assert.ok(
    Math.abs(speciesRecord.margin - 0.65) < 1e-12
);


// The converter must sort defensively instead of trusting label order.
const expressionRecord =
    zeroShotOutputToRecord(
        "looking at viewer",
        {
            labels: [
                anatomyLabel,
                expressionLabel,
                speciesLabel,
            ],
            scores: [
                0.21,
                0.63,
                0.16,
            ],
        }
    );

assert.equal(
    expressionRecord.category,
    "expression"
);
assert.ok(
    Math.abs(expressionRecord.margin - 0.42) < 1e-12
);


// Old "body" overrides migrate semantically; no tag-specific migration.
assert.equal(
    normalizeCategory("body"),
    "anatomy"
);
assert.equal(
    normalizeCategory("pose"),
    "pose"
);
assert.equal(
    normalizeCategory("does-not-exist"),
    "other"
);


// NLI thresholds are intentionally lower than the old embedding cosine
// thresholds because single-label probabilities are normalized across many
// candidate classes.
assert.ok(DEFAULT_MIN_SCORE > 0);
assert.ok(DEFAULT_MIN_SCORE < 0.35);
assert.ok(DEFAULT_MIN_MARGIN > 0);
assert.ok(DEFAULT_MIN_MARGIN < 0.1);


// Invalid model output is rejected rather than silently cached.
assert.throws(
    () =>
        zeroShotOutputToRecord(
            "x",
            {
                labels: ["a"],
                scores: [],
            }
        ),
    /Invalid zero-shot classifier output/
);

console.log("classifier schema tests: OK");
