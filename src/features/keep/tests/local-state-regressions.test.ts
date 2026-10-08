jest.mock("obsidian");
jest.mock("@integrations/server/keepApi", () => ({ pushNotes: jest.fn() }));
jest.mock("@app/logging", () => ({ logSync: jest.fn().mockResolvedValue(undefined), flushLogSync: jest.fn().mockResolvedValue(undefined) }));
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import type KeepSidianPlugin from "@app/main";
import { collectNotesToPush } from "../push/collectNotes";
import { pushGoogleKeepNotes } from "../push";
import { pushNotes } from "@integrations/server/keepApi";
import { digest, localStateBaseline, stampLocalBaseline, storedLocalBaseline } from "../domain/local-state";
import { stripSyncState } from "../domain/sync-state";
import { getExistingFileInfo, checkForDuplicateData } from "../domain/compare";

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
// Node 18 Jest retains global bindings; mutate one installed provider instead.
const cryptoProvider: { subtle: typeof webcrypto.subtle | undefined } = { subtle: webcrypto.subtle };
beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoProvider });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterAll(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
	else Reflect.deleteProperty(globalThis, "crypto");
	if (encoderDescriptor) Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor);
	else Reflect.deleteProperty(globalThis, "TextEncoder");
});
beforeEach(() => jest.clearAllMocks());

it("hashes only the requested byte view with the installed crypto implementation", async () => {
	const bytes = new Uint8Array([0, 1, 2, 3, 4]);
	expect(await digest(bytes.subarray(1, 4))).toBe("sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
});

it("returns an unknown baseline when asynchronous hashing fails", async () => {
	const f = await fixture();
	const hash = jest.spyOn(webcrypto.subtle, "digest").mockRejectedValueOnce(new Error("Synthetic crypto failure"));
	try {
		expect(await localStateBaseline(f.adapter, f.path, f.content)).toBeUndefined();
		expect(storedLocalBaseline(f.content)).toMatch(/^sha256:/);
	} finally { hash.mockRestore(); }
});

async function fixture(media = false) {
	const path = "Keep/note.md";
	let content = `---\nGoogleKeepUrl: https://keep.google.com/#NOTE/one\nGoogleKeepUpdatedDate: 2020-01-01T00:00:00.000Z\nKeepSidianLastSyncedDate: 2024-01-01T00:00:00.100Z\ntags: [manual]\n---\nOriginal${media ? "\n![[media/image.png]]" : ""}`;
	let mediaBytes = new Uint8Array([1, 2, 3]).buffer;
	let mtime = Date.parse("2024-01-01T00:00:01.500Z"); // natural own write AFTER sync stamp
	const adapter = {
		read: jest.fn(async () => content),
		write: jest.fn(async (_path: string, value: string) => { content = value; }),
		readBinary: jest.fn(async () => mediaBytes),
		exists: jest.fn(async () => true),
		list: jest.fn(async () => ({ files: [path], folders: [] })),
		stat: jest.fn(async () => ({ ctime: mtime, mtime, size: content.length, type: "file" })),
	};
	content = await stampLocalBaseline(adapter, path, content);
	const plugin = { settings: { saveLocation: "Keep", frontmatterPascalCaseFixApplied: true, email: "fixture@example.invalid", token: "synthetic" }, app: { vault: { adapter } }, throwIfSyncCancelled: jest.fn() } as unknown as KeepSidianPlugin;
	return { plugin, adapter, path, get content() { return content; }, edit(value: string) { content = value; mtime = Date.parse("2024-01-01T00:00:00.101Z"); }, mediaEdit() { mediaBytes = new Uint8Array([4, 5, 6]).buffer; } };
}

it("skips clean own writes despite later natural mtime; detects same-second body/title/properties edits", async () => {
	for (const change of ["body", "title", "property"] as const) {
		const f = await fixture();
		expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(0);
		f.edit(change === "body" ? f.content + "\nEdited" : f.content.replace("tags: [manual]", change === "title" ? "tags: [manual]\nTitle: Changed" : "tags: [manual, extra]"));
		expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(1);
	}
});

it("detects media byte edits even when media mtime and size are unchanged", async () => {
	const f = await fixture(true);
	expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(0);
	f.mediaEdit();
	const notes = (await collectNotesToPush(f.plugin)).notesToPush;
	expect(notes).toHaveLength(1);
	expect(notes[0].attachments).toHaveLength(1);
});

it("allows incoming remote changes to replace a confirmed clean local body despite later mtime", async () => {
	const f = await fixture();
	const existing = await getExistingFileInfo(f.path, f.plugin.app);
	expect(checkForDuplicateData({ textWithoutFrontmatter: "Remote change", createdDate: null, updatedDate: new Date("2024-01-01T00:00:00.102Z") }, existing)).toBe("overwrite");
});

it("strips local hashes and remote receipts from public note properties", () => {
	expect(stripSyncState(`tags: [manual]\nKeepSidianLocalBaseline: sha256:${"a".repeat(64)}\nKeepSidianRemoteRevision: keep-v1:${"b".repeat(64)}`)).toBe("tags: [manual]");
});

it("preserves a legacy note edited while its upload is in flight and leaves it eligible", async () => {
	const f = await fixture(); f.edit(f.content + "\nBefore request");
	(pushNotes as jest.Mock).mockImplementation(async () => {
		f.edit(f.content + "\nIn flight edit");
		return { results: [{ path: "note.md", success: true }] };
	});
	expect(await pushGoogleKeepNotes(f.plugin)).toBe(0);
	expect(f.content).toContain("In flight edit");
	expect(f.adapter.write).not.toHaveBeenCalled();
	expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(1);
});

it("falls back at millisecond precision when crypto is unavailable; never invents a hash", async () => {
	const f = await fixture();
	cryptoProvider.subtle = undefined;
	try {
		f.edit(f.content + "\nNew edit");
		expect(await localStateBaseline(f.adapter, f.path, f.content)).toBeUndefined();
		expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(1);
	} finally { cryptoProvider.subtle = webcrypto.subtle; }
	expect(storedLocalBaseline(f.content)).toMatch(/^sha256:/);
});

it("does not acknowledge missing direct-upload results", async () => {
	const f = await fixture(); f.edit(f.content + "\nNew edit");
	(pushNotes as jest.Mock).mockResolvedValue({ results: [] });
	expect(await pushGoogleKeepNotes(f.plugin)).toBe(0);
	expect(f.adapter.write).not.toHaveBeenCalled();
	expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(1);
});

it("keeps an edit made between media revalidation and acknowledgement eligible", async () => {
	const f = await fixture(true); f.edit(f.content + "\nNew edit");
	let readsAfterResponse = 0;
	const originalRead = f.adapter.read.getMockImplementation()!;
	(pushNotes as jest.Mock).mockImplementation(async () => {
		f.adapter.read.mockImplementation(async () => {
			readsAfterResponse += 1;
			if (readsAfterResponse === 2) f.mediaEdit(); // immediately before acknowledged write
			return originalRead();
		});
		return { results: [{ path: "note.md", success: true }] };
	});
	expect(await pushGoogleKeepNotes(f.plugin)).toBe(1);
	expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(1);
});

it("an empty Title uses the filename in the baseline, so renames remain local edits", async () => {
	const f = await fixture(); f.edit(f.content.replace("tags: [manual]", "tags: [manual]\nTitle: ''"));
	const stamped = await stampLocalBaseline(f.adapter, f.path, f.content);
	expect(await localStateBaseline(f.adapter, "Keep/renamed.md", stamped)).not.toBe(storedLocalBaseline(stamped));
});

it("older and undated remote snapshots cannot replace a clean acknowledged body", async () => {
	const f = await fixture();
	const existing = await getExistingFileInfo(f.path, f.plugin.app);
	expect(checkForDuplicateData({ textWithoutFrontmatter: "Stale", createdDate: null, updatedDate: new Date("2019-01-01T00:00:00Z") }, existing)).not.toBe("overwrite");
	expect(checkForDuplicateData({ textWithoutFrontmatter: "Unknown", createdDate: null, updatedDate: null }, existing)).not.toBe("overwrite");
});

it("known local edits force download merge even when filesystem time is unchanged", async () => {
	const f = await fixture(); f.edit(f.content + "\nLocal addition");
	f.adapter.stat.mockResolvedValue({ ctime: 0, mtime: 0, size: 0, type: "file" });
	const existing = await getExistingFileInfo(f.path, f.plugin.app);
	expect(existing.localChanged).toBe(true);
	expect(checkForDuplicateData({ textWithoutFrontmatter: "Remote change", createdDate: null, updatedDate: new Date("2024-01-01T00:00:00.102Z") }, existing)).toBe("merge");
});

it.each([false, true])("retains a newly created Keep identity when in-flight %s edits prevent acknowledgement", async (media) => {
	const f = await fixture(media);
	f.edit(f.content.replace(/^GoogleKeepUrl:.*\n/m, "") + "\nNew local note");
	(pushNotes as jest.Mock).mockImplementation(async () => {
		if (media) f.mediaEdit();
		else f.edit(f.content + "\nIn flight edit");
		return { results: [{ path: "note.md", success: true, keep_url: "https://keep.google.com/#NOTE/new-id", remote_revision: `keep-v1:${"a".repeat(64)}` }] };
	});
	expect(await pushGoogleKeepNotes(f.plugin)).toBe(0);
	expect(f.content).toContain("GoogleKeepUrl: https://keep.google.com/#NOTE/new-id");
	expect(f.content).toContain("KeepSidianPendingUpload: true");
	if (!media) expect(f.content).toContain("In flight edit");
	expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(1);
});

it("unknown hashing/media state stays eligible even if its timestamp is preserved", async () => {
	const f = await fixture();
	cryptoProvider.subtle = undefined;
	try {
		f.adapter.stat.mockResolvedValue({ ctime: 0, mtime: Date.parse("2024-01-01T00:00:00.100Z"), size: 0, type: "file" });
		expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(1);
	} finally { cryptoProvider.subtle = webcrypto.subtle; }
});

it("keeps locally edited Keep state pending while merging a newer remote body", async () => {
	const { processAndSaveNote } = await import("../sync");
	const f = await fixture();
	f.edit(f.content.replace("tags: [manual]", "tags: [manual]\nGoogleKeepPinned: true\nGoogleKeepColor: BLUE\nGoogleKeepArchived: false"));
	await processAndSaveNote(f.plugin, { id: "one", title: "note", text: "Original\nRemote addition", updated: "2024-01-02T00:00:00Z", pinned: false, color: "RED", archived: true }, "Keep", undefined, undefined, async () => {}, async () => {}, undefined, undefined, "archived-only", "merge-save-conflicts");
	expect(f.content).toContain("GoogleKeepPinned: true");
	expect(f.content).toContain("GoogleKeepColor: BLUE");
	expect(f.content).toContain("GoogleKeepArchived: false");
	expect(f.content).toContain("Remote addition");
	expect(f.content).toContain("KeepSidianPendingUpload: true");
});

it("preserves a local unarchive when the remote body is unchanged", async () => {
	const { processAndSaveNote } = await import("../sync");
	const f = await fixture();
	f.edit(f.content.replace("tags: [manual]", "tags: [manual]\nGoogleKeepArchived: false"));
	await processAndSaveNote(f.plugin, { id: "one", title: "note", text: "Original", updated: "2024-01-02T00:00:00Z", archived: true }, "Keep", undefined, undefined, async () => {}, async () => {}, undefined, undefined, "archived-only", "merge-save-conflicts");
	expect(f.content).toContain("GoogleKeepArchived: false");
	expect((await collectNotesToPush(f.plugin)).notesToPush).toHaveLength(1);
});

it("preserves an edit arriving between duplicate comparison and body write", async () => {
	const { processAndSaveNote } = await import("../sync");
	const f = await fixture();
	const original = f.content;
	let once = false;
	f.adapter.stat.mockImplementation(async () => {
		if (!once) { once = true; f.edit(original + "\nEdit during comparison"); }
		return { ctime: 0, mtime: 0, size: 0, type: "file" };
	});
	await expect(processAndSaveNote(f.plugin, { id: "one", title: "note", text: "New remote body", updated: "2024-01-02T00:00:00Z" }, "Keep", undefined, undefined, async () => {}, async () => {})).rejects.toThrow(/changed after download comparison/);
	expect(f.content).toContain("Edit during comparison");
	expect(f.adapter.write).not.toHaveBeenCalled();
});
