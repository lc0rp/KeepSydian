process.env.TZ = 'UTC';
// Existing suites exercise the explicitly selected legacy compatibility path.
// accessV1Wiring tests remove this override to exercise the branch default.
process.env.KEEPSIDIAN_ACCESS_V1 = 'false';
