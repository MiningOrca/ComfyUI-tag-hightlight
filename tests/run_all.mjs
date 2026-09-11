const tests = [
    "./parser.test.mjs",
    "./classifier_schema.test.mjs",
    "./diagnostics_wiring.test.mjs",
];

for (const test of tests) {
    await import(test);
}

console.log("all offline tests: OK");
