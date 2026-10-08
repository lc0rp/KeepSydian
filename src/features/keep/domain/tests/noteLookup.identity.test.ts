import type { App } from "obsidian";
import { createMockPlugin } from "@test-utils/mocks/plugin";
import { createHash, webcrypto } from "crypto";
import { TextEncoder } from "util";
import { handleDuplicateNotes } from "../compare";
import { normalizeNote } from "../note";
import { buildExistingKeepNoteIndex, findExistingKeepNotePath, updateExistingKeepNoteIndex } from "../noteLookup";

const URL = "https://keep.google.com/u/0/#NOTE/identity.123";
const CANONICAL_URL = "https://keep.google.com/#NOTE/identity.123";
const ORIGINAL_PATH = "Keep/Renamed.md";
const CONFLICT_PATH = "Keep/Original-conflict-2024-01-03.md";
const CONTENT = `---\nGoogleKeepUrl: ${URL}\n---\nBody`;
const note = normalizeNote({ id: "identity.123", title: "Original", text: "Body" });

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterAll(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
	if (encoderDescriptor) Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor);
});

function fixture(reverse = false) {
	const plugin = createMockPlugin();
	const paths = [ORIGINAL_PATH, CONFLICT_PATH];
	if (reverse) paths.reverse();
	plugin.app.vault.adapter.list.mockResolvedValue({ files: paths, folders: [] });
	plugin.app.vault.adapter.read.mockResolvedValue(CONTENT);
	return plugin.app;
}

describe("canonical Keep identity lookup", () => {
	it.each(["other-identity", undefined])(
		"allocates a separate path when a same-title file has identity %s",
		async (identity) => {
			const plugin = createMockPlugin();
			const preferred = "Keep/Original.md";
			const content = identity ? `---\nGoogleKeepUrl: https://keep.google.com/#NOTE/${identity}\n---\nBody` : "Body";
			const stored = new Map([[preferred, content]]);
			plugin.app.vault.adapter.list.mockResolvedValue({ files: [preferred], folders: [] });
			plugin.app.vault.adapter.exists.mockImplementation(async (path) => stored.has(path));
			plugin.app.vault.adapter.read.mockImplementation(async (path) => {
				if (!stored.has(path)) throw new Error("Absent fixture");
				return stored.get(path)!;
			});
			const index = await buildExistingKeepNoteIndex(plugin.app, "Keep");
			const resolved = await findExistingKeepNotePath(plugin.app, note, preferred, index, "Keep");
			expect(resolved).not.toBe(preferred);
			expect(resolved).toMatch(/^Keep\/Original--keep-[a-f0-9]{64}\.md$/);
			expect(await findExistingKeepNotePath(plugin.app, note, preferred, index, "Keep")).toBe(resolved);
			expect(stored.get(preferred)).toBe(content);
			expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
		}
	);

	it("classifies an absent allocated path as a create for direct duplicate checks", async () => {
		const plugin = createMockPlugin();
		const preferred = "Keep/Original.md";
		plugin.app.vault.adapter.list.mockResolvedValue({ files: [preferred], folders: [] });
		plugin.app.vault.adapter.exists.mockImplementation(async (path) => path === preferred);
		plugin.app.vault.adapter.read.mockImplementation(async (path) => {
			if (path !== preferred) throw new Error("Absent fixture");
			return "---\nGoogleKeepUrl: https://keep.google.com/#NOTE/other\n---\nBody";
		});
		await expect(handleDuplicateNotes("Keep", note, plugin.app as unknown as App)).resolves.toBe("create");
		expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
	});

	it.each([false, true])("reserves distinct concurrent destinations (existing collision=%s)", async (occupied) => {
		const plugin = createMockPlugin();
		const preferred = "Keep/Original.md";
		const suffix = createHash("sha256").update(CANONICAL_URL).digest("hex");
		const secondPreferred = occupied ? `Keep/Original--keep-${suffix}.md` : preferred;
		const other = normalizeNote({ id: "different", title: "Other", text: "Body" });
		plugin.app.vault.adapter.list.mockResolvedValue({ files: occupied ? [preferred] : [], folders: [] });
		plugin.app.vault.adapter.exists.mockImplementation(async (path) => occupied && path === preferred);
		plugin.app.vault.adapter.read.mockResolvedValue(
			"---\nGoogleKeepUrl: https://keep.google.com/#NOTE/foreign\n---\nBody"
		);
		const index = await buildExistingKeepNoteIndex(plugin.app, "Keep");
		const targets = await Promise.all([
			findExistingKeepNotePath(plugin.app, note, preferred, index, "Keep"),
			findExistingKeepNotePath(plugin.app, other, secondPreferred, index, "Keep"),
		]);
		expect(new Set(targets).size).toBe(2);
		for (const path of targets) expect(index.existingPaths.has(path!)).toBe(false);
		expect(await findExistingKeepNotePath(plugin.app, note, preferred, index, "Keep")).toBe(targets[0]);
		expect(await findExistingKeepNotePath(plugin.app, other, secondPreferred, index, "Keep")).toBe(targets[1]);
		expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
	});

	it("does not reuse a foreign file occupying the deterministic collision path", async () => {
		const plugin = createMockPlugin();
		const preferred = "Keep/Original.md";
		const suffix = createHash("sha256").update(CANONICAL_URL).digest("hex");
		const occupied = `Keep/Original--keep-${suffix}.md`;
		const foreign = "---\nGoogleKeepUrl: https://keep.google.com/#NOTE/other\n---\nBody";
		const stored = new Map([
			[preferred, foreign],
			[occupied, foreign],
		]);
		plugin.app.vault.adapter.list.mockResolvedValue({ files: [...stored.keys()], folders: [] });
		plugin.app.vault.adapter.exists.mockImplementation(async (path) => stored.has(path));
		plugin.app.vault.adapter.read.mockImplementation(async (path) => stored.get(path)!);
		const index = await buildExistingKeepNoteIndex(plugin.app, "Keep");
		expect(await findExistingKeepNotePath(plugin.app, note, preferred, index, "Keep")).toBe(
			`Keep/Original--keep-${suffix}-2.md`
		);
	});

	it("bounds UTF-8 filename length when adding an identity suffix", async () => {
		const plugin = createMockPlugin();
		const preferred = `Keep/${"界".repeat(80)}.md`;
		plugin.app.vault.adapter.list.mockResolvedValue({ files: [preferred], folders: [] });
		plugin.app.vault.adapter.exists.mockImplementation(async (path) => path === preferred);
		plugin.app.vault.adapter.read.mockResolvedValue(
			"---\nGoogleKeepUrl: https://keep.google.com/#NOTE/other\n---\nBody"
		);
		const index = await buildExistingKeepNoteIndex(plugin.app, "Keep");
		const resolved = await findExistingKeepNotePath(plugin.app, note, preferred, index, "Keep");
		expect(resolved).not.toBe(preferred);
		expect(Buffer.byteLength(resolved!.split("/").pop()!, "utf8")).toBeLessThanOrEqual(255);
	});
	it.each([false, true])(
		"finds the renamed original regardless of conflict-copy order (reverse=%s)",
		async (reverse) => {
			const app = fixture(reverse);
			const index = await buildExistingKeepNoteIndex(app, "Keep");
			expect(index.existingPaths.has(CONFLICT_PATH)).toBe(true);
			expect(index.pathByKeepUrl.get(CANONICAL_URL)).toBe(ORIGINAL_PATH);
			expect(await findExistingKeepNotePath(app, note, "Keep/Original.md", index, "Keep")).toBe(ORIGINAL_PATH);
		}
	);

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

	it("reads current identities at the vault root even when metadata is populated", async () => {
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
		expect(app.vault.adapter.read).toHaveBeenCalledWith(ORIGINAL_PATH);
		expect(app.vault.adapter.read).not.toHaveBeenCalledWith(CONFLICT_PATH);
	});
});
