import assert from "node:assert/strict";

import {
    categoryForRecord,
    classificationDecision,
    normalizeTag,
    parsePrompt,
    syntaxCategory,
} from "../js/prompt_parser.js";


assert.equal(
    normalizeTag("(large_wings:1.2)"),
    "large wings"
);

assert.equal(
    normalizeTag("[looking_at_viewer]"),
    "looking at viewer"
);

assert.equal(
    syntaxCategory("<lora:foo:0.8>"),
    "lora"
);

assert.equal(
    syntaxCategory("embedding:foo"),
    "embedding"
);

assert.equal(
    syntaxCategory("__pose__"),
    "wildcard"
);

const parsed = parsePrompt(
    "female, large_wings,\n(looking_at_viewer:1.1)"
);

assert.equal(parsed.length, 3);
assert.equal(parsed[0].normalized, "female");
assert.equal(parsed[1].normalized, "large wings");
assert.equal(
    parsed[2].normalized,
    "looking at viewer"
);

assert.equal(
    categoryForRecord(
        {
            category: "anatomy",
            score: 0.7,
            margin: 0.08,
        },
        0.10,
        0.01
    ),
    "anatomy"
);

assert.equal(
    categoryForRecord(
        {
            category: "anatomy",
            score: 0.09,
            margin: 0.08,
        },
        0.10,
        0.01
    ),
    "other"
);


assert.deepEqual(
    classificationDecision(
        null,
        0.10,
        0.01
    ),
    {
        category: "other",
        accepted: false,
        reason: "missing",
        score: null,
        margin: null,
    }
);

assert.equal(
    classificationDecision(
        {
            category: "species",
            score: 0.09,
            margin: 0.20,
        },
        0.10,
        0.01
    ).reason,
    "score<0.1"
);

assert.equal(
    classificationDecision(
        {
            category: "species",
            score: 0.70,
            margin: 0.009,
        },
        0.10,
        0.01
    ).reason,
    "margin<0.01"
);

assert.deepEqual(
    classificationDecision(
        {
            category: "species",
            score: 0.70,
            margin: 0.10,
        },
        0.10,
        0.01
    ),
    {
        category: "species",
        accepted: true,
        reason: "accepted",
        score: 0.70,
        margin: 0.10,
    }
);

console.log("parser tests: OK");
