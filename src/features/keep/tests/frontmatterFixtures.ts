/** Valid YAML shapes from independent MIGRATION-REVIEW-1 reproductions. */
export const ambiguousMigrationCases = [
	{ kind: "top-level alias plus nested flow mapping", body: "google-keep-url: https://keep.google.com/#NOTE/n1\nmetadata: {\ngoogle-keep-url: null\n}" },
	{ kind: "nested flow mapping", body: "metadata: {\ngoogle-keep-url: null\n}" },
	{ kind: "multiline double quoted scalar", body: 'metadata:\n  label: "first\ngoogle-keep-url: literal text\nlast"' },
	{ kind: "linked nested date mapping", body: 'GoogleKeepUrl: https://keep.google.com/#NOTE/n1\nmetadata: {\ngoogle-keep-created-date: "nested date text"\n}' },
	{ kind: "linked multiline single quoted scalar", body: "GoogleKeepUrl: https://keep.google.com/#NOTE/n1\nmetadata:\n  label: 'first\ngoogle-keep-updated-date: literal text\nlast'" },
];
