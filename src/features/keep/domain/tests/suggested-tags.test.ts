import { getSuggestedTagUpdate, mergeSuggestedTags, normalizeNote } from "../note";

describe("suggested tags", () => {
	it("unions additions without removing manual tags or nested properties", () => {
		const frontmatter = "tags:\n  - manual\n  - auto-work\nmeta:\n  tags: [nested]\nowner: Luke";
		const merged = mergeSuggestedTags(frontmatter, ["auto-work", "auto-project"]);
		expect(merged).toBe('tags: ["manual","auto-work","auto-project"]\nmeta:\n  tags: [nested]\nowner: Luke');
		expect(mergeSuggestedTags(merged, ["auto-project"])).toBe(merged);
	});

	it("normalizes API tags into frontmatter without altering note body", () => {
		const result = normalizeNote({
			title: "Title",
			text: "---\ntags: [manual]\ncustom: keep\n---\nBody",
			tags: ["auto-work"],
		});
		expect(result.frontmatterDict.tags).toEqual(["manual", "auto-work"]);
		expect(result.textWithoutFrontmatter).toBe("Body");
		expect(result.frontmatter).toContain("custom: keep");
	});

	it("makes metadata-only updates while retaining body bytes and sync state", () => {
		const markdown =
			"---\ntags: [manual]\nKeepSidianPendingUpload: true\nKeepSidianLastSyncedDate: unchanged\n---\nLocal edit  \n";
		const updated = getSuggestedTagUpdate({ title: "Remote", tags: ["auto-work"] }, markdown);
		expect(updated).toBe(markdown.replace("tags: [manual]", 'tags: ["manual","auto-work"]'));
		expect(getSuggestedTagUpdate({ title: "Remote", tags: ["auto-work"] }, updated!)).toBeUndefined();
	});
});

it("keeps generated tags when injecting a missing Keep URL from the API id", () => {
	const normalized = normalizeNote({ id: "synthetic-id", title: "Title", text: "Body", tags: ["auto-work"] });
	expect(normalized.frontmatter).toContain('tags: ["auto-work"]');
	expect(normalized.frontmatter).toContain("GoogleKeepUrl: https://keep.google.com/#NOTE/synthetic-id");
});

it("updates spaced and quoted manual tags without creating duplicate YAML keys", () => {
	for (const key of ["tags ", '\"tags\" ', "'tags' "]) {
		const merged = mergeSuggestedTags(`${key}: [manual]\ncustom: preserved`, ["auto-work"]);
		expect(merged).toBe('tags: ["manual","auto-work"]\ncustom: preserved');
	}
});
