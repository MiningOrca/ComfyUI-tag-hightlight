import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here =
    path.dirname(fileURLToPath(import.meta.url));

const source = fs.readFileSync(
    path.join(here, "../js/semantic_tag_highlighter.js"),
    "utf8"
);
const worker = fs.readFileSync(
    path.join(here, "../js/classifier_worker.js"),
    "utf8"
);

assert.match(source, /console\.table\(rows\)/);
assert.match(source, /cacheRejected/);
assert.match(source, /batchStartedAt/);
assert.match(source, /SemanticTagHighlighter\.DebugLogging/);

assert.match(worker, /feature-extraction/);
assert.match(worker, /pooling: "mean"/);
assert.match(worker, /normalize: true/);
assert.match(worker, /MiniLM inference start/);
assert.doesNotMatch(worker, /zero-shot-classification/);
assert.doesNotMatch(worker, /DeBERTa|deberta/);

assert.match(source, /contextmenu/);
assert.match(source, /Semantic tags/);
assert.match(source, /Enable highlighting for this field/);
assert.match(source, /Disable highlighting for this field/);
assert.match(source, /Edit override/);
assert.match(source, /Remove override/);
assert.match(source, /Shift\+right-click/);
assert.doesNotMatch(source, /benchmark classifier configs/);
assert.doesNotMatch(source, /run real model self-test/);
assert.doesNotMatch(source, /sth-enable-button/);
assert.doesNotMatch(source, /getNodeMenuItems\(/);

assert.match(source, /querySelectorAll\("textarea"\)/);
assert.doesNotMatch(source, /querySelector\("textarea"\)/);

console.log("diagnostics/context-menu wiring tests: OK");
