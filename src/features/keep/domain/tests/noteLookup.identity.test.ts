import { createMockPlugin } from "@test-utils/mocks/plugin";
import { normalizeNote } from "../note";
import { buildExistingKeepNoteIndex, findExistingKeepNotePath, updateExistingKeepNoteIndex } from "../noteLookup";

const URL = "https://keep.google.com/u/0/#NOTE/identity.123";
const CANONICAL_URL = "https://keep.google.com/#NOTE/identity.123";
const ORIGINAL_PATH = "Keep/Renamed.md";
const CONFLICT_PATH = "Keep/Original-conflict-2024-01-03.md";
const CONTENT = `---\nGoogleKeepUrl: ${URL}\n---\nBody`;
const note = normalizeNote({ id: "identity.123", title: "Original", text: "Body" });

function fixture(reverse = false) {
	const plugin = createMockPlugin();
	const paths = [ORIGINAL_PATH, CONFLICT_PATH];
	if (reverse) paths.reverse();
	plugin.app.vault.adapter.list.mockResolvedValue({ files: paths, folders: [] });
	plugin.app.vault.adapter.read.mockResolvedValue(CONTENT);
	return plugin.app;
}

describe("canonical Keep identity lookup", () => {
	it.each([false, true])("finds the renamed original regardless of conflict-copy order (reverse=%s)", async (reverse) => {
		const app = fixture(reverse);
		const index = await buildExistingKeepNoteIndex(app, "Keep");
		expect(index.existingPaths.has(CONFLICT_PATH)).toBe(true);
		expect(index.pathByKeepUrl.get(CANONICAL_URL)).toBe(ORIGINAL_PATH);
		expect(await findExistingKeepNotePath(app, note, "Keep/Original.md", index, "Keep")).toBe(ORIGINAL_PATH);
	});

	it("also canonicalizes a lazily built index", async () => {
		const app = fixture();
		expect(await findExistingKeepNotePath(app, note, "Keep/Original.md", undefined, "Keep")).toBe(ORIGINAL_PATH);
	});

	it("does not replace the original mapping after writing a conflict copy", async () => {
		const app = fixture();
		const index = await buildExistingKeepNoteIndex(app, "Keep");
		updateExistingKeepNoteIndex(index, "Keep/New-conflict-2024-02-03.md", note);
		expect(index.pathByKeepUrl.get(CANONICAL_URL)).toBe(ORIGINAL_PATH);
		updateExistingKeepNoteIndex(index, "Keep/Another rename.md", note);
		expect(index.pathByKeepUrl.get(CANONICAL_URL)).toBe("Keep/Another rename.md");
	});

	it("applies the same rules to metadata-cache-backed root-vault lookup", async () => {
		const base = fixture();
		const app = {
			...base,
			vault: {
				...base.vault,
				getMarkdownFiles: () => [{ path: ORIGINAL_PATH }, { path: CONFLICT_PATH }],
			},
			metadataCache: { getFileCache: () => ({ frontmatter: { GoogleKeepUrl: URL } }) },
		};
		const index = await buildExistingKeepNoteIndex(app);
		expect(index.pathByKeepUrl.get(CANONICAL_URL)).toBe(ORIGINAL_PATH);
		expect(app.vault.adapter.read).not.toHaveBeenCalled();
	});
});
