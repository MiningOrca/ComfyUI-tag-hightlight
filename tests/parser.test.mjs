import assert from "node:assert/strict";

import {
    categoryForRecord,
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
            category: "body",
            score: 0.7,
            margin: 0.08,
        },
        0.16,
        0.025
    ),
    "body"
);

assert.equal(
    categoryForRecord(
        {
            category: "body",
            score: 0.7,
            margin: 0.01,
        },
        0.16,
        0.025
    ),
    "other"
);

console.log("parser tests: OK");
