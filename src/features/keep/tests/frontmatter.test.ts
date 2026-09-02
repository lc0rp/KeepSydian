import { buildFrontmatterWithSyncDate } from "../frontmatter";

describe("buildFrontmatterWithSyncDate", () => {
	it("preserves existing Keep metadata when incoming frontmatter omits it", () => {
		const result = buildFrontmatterWithSyncDate(
			"Existing: true\nGoogleKeepColor: YELLOW\nGoogleKeepPinned: true",
			"2024-03-03T12:34:56.000Z",
			"GoogleKeepCreatedDate: 2024-01-01T00:00:00.000Z"
		);

		expect(result).toContain("Existing: true");
		expect(result).toContain("GoogleKeepColor: YELLOW");
		expect(result).toContain("GoogleKeepPinned: true");
		expect(result).toContain("GoogleKeepCreatedDate: 2024-01-01T00:00:00.000Z");
		expect(result).toContain("KeepSidianLastSyncedDate: 2024-03-03T12:34:56.000Z");
	});

	it("updates Keep-managed metadata when incoming frontmatter provides it", () => {
		const result = buildFrontmatterWithSyncDate(
			"GoogleKeepColor: YELLOW\nGoogleKeepPinned: false\nGoogleKeepArchived: false",
			"2024-03-03T12:34:56.000Z",
			"GoogleKeepColor: BLUE\nGoogleKeepPinned: true\nGoogleKeepArchived: true"
		);

		expect(result).toContain("GoogleKeepColor: BLUE");
		expect(result).toContain("GoogleKeepPinned: true");
		expect(result).toContain("GoogleKeepArchived: true");
		expect(result).toContain("KeepSidianLastSyncedDate: 2024-03-03T12:34:56.000Z");
	});

	it("preserves comments and YAML formatting while refreshing managed metadata", () => {
		const existingFrontmatter = [
			"# supporter comment",
			"Custom:",
			"  nested: value",
			'Quoted: "01:02"',
			"KeepSidianLastSyncedDate: 2025-01-01T00:00:00.000Z",
		].join("\n");

		const result = buildFrontmatterWithSyncDate(
			existingFrontmatter,
			"2026-09-01T12:00:00.000Z",
			"GoogleKeepColor: BLUE\nIncomingCustom: should-not-replace-user-frontmatter"
		);

		expect(result).toBe(
			[
				"# supporter comment",
				"Custom:",
				"  nested: value",
				'Quoted: "01:02"',
				"KeepSidianLastSyncedDate: 2026-09-01T12:00:00.000Z",
				"GoogleKeepColor: BLUE",
			].join("\n")
		);
	});
});
