const tests = [
    "./parser.test.mjs",
    "./classifier_schema.test.mjs",
    "./model_behavior_cases.test.mjs",
];

for (const test of tests) {
    await import(test);
}

console.log("all offline tests: OK");
