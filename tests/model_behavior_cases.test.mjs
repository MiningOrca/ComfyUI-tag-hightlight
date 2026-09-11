import assert from "node:assert/strict";

import {
    ML_CATEGORIES,
} from "../js/classifier_schema.js";


const cases = [
    ["human", "species"],
    ["anthro dragon", "species"],
    ["perfect eyes", "anatomy"],
    ["tan skin", "anatomy"],
    ["looking at viewer", "expression"],
    ["hand between legs", "pose"],
    ["school uniform", "clothing"],
    ["nude", "sexual"],
    ["cel shading", "style"],
    ["three quarter view", "camera"],
    ["rim lighting", "lighting"],
    ["forest background", "environment"],
    ["low quality", "quality"],
    ["extra fingers", "defect"],
    ["watermark", "text_metadata"],
];

assert.equal(
    new Set(cases.map(([tag]) => tag)).size,
    cases.length,
    "Self-test tags must be unique"
);

for (const [tag, expected] of cases) {
    assert.ok(tag.length > 0);
    assert.ok(
        ML_CATEGORIES.includes(expected),
        `Invalid expected category: ${tag} -> ${expected}`
    );
}

assert.ok(
    cases.length >= ML_CATEGORIES.length - 1,
    "Behavior corpus should cover almost all ML categories"
);

console.log("model behavior case definitions: OK");
