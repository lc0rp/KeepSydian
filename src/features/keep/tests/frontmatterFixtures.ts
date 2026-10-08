/** Valid YAML shapes from independent MIGRATION-REVIEW-1 reproductions. */
export const ambiguousMigrationCases = [
	{ kind: "top-level alias plus nested flow mapping", body: "google-keep-url: https://keep.google.com/#NOTE/n1\nmetadata: {\ngoogle-keep-url: null\n}" },
	{ kind: "nested flow mapping", body: "metadata: {\ngoogle-keep-url: null\n}" },
	{ kind: "multiline double quoted scalar", body: 'metadata:\n  label: "first\ngoogle-keep-url: literal text\nlast"' },
	{ kind: "linked nested date mapping", body: 'GoogleKeepUrl: https://keep.google.com/#NOTE/n1\nmetadata: {\ngoogle-keep-created-date: "nested date text"\n}' },
	{ kind: "linked multiline single quoted scalar", body: "GoogleKeepUrl: https://keep.google.com/#NOTE/n1\nmetadata:\n  label: 'first\ngoogle-keep-updated-date: literal text\nlast'" },
	{ kind: "shadowed nested URL merge key", body: "google-keep-url: https://keep.google.com/#NOTE/n1\nmetadata:\n  <<: {\ngoogle-keep-url: old nested value\n}\n  google-keep-url: manual nested value\n  GoogleKeepUrl: canonical nested value" },
	{ kind: "shadowed nested date merge key", body: "google-keep-created-date: 2024-01-01\nmetadata:\n  <<: {\ngoogle-keep-created-date: old nested value\n}\n  google-keep-created-date: manual nested value\n  GoogleKeepCreatedDate: canonical nested value" },
	{ kind: "shadowed nested updated-date sequence merge key", body: "GoogleKeepUrl: https://keep.google.com/#NOTE/n1\ngoogle-keep-updated-date: 2024-01-01\nmetadata:\n  <<: [{\ngoogle-keep-updated-date: old nested value\n}]\n  google-keep-updated-date: manual nested value\n  GoogleKeepUpdatedDate: canonical nested value" },
];

export const mixedNewlineMigrationCases = [
	"---\r\ngoogle-keep-url: https://keep.google.com/#NOTE/n1\n---\nBody\r\n",
	"---\ngoogle-keep-url: https://keep.google.com/#NOTE/n1\r\nmetadata: [manual]\n---\nBody\n",
];
