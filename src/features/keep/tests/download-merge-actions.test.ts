jest.mock("obsidian");
jest.mock("@features/keep/domain/compare", () => ({ handleDuplicateNotes: jest.fn(async () => "merge") }));
jest.mock("@features/keep/domain/noteLookup", () => ({
	findExistingKeepNotePath: jest.fn(async () => "Keep/note.md"),
	buildExistingKeepNoteIndex: jest.fn(), updateExistingKeepNoteIndex: jest.fn(),
}));
jest.mock("@services/note-path-resolver", () => ({ resolveNotePath: () => "Keep/note.md", resolveNoteFolder: () => "Keep" }));
jest.mock("@app/logging", () => ({ logSync: jest.fn(async () => {}), flushLogSync: jest.fn(async () => {}) }));
jest.mock("@features/keep/io/attachments", () => ({ processAttachments: jest.fn(async () => ({ downloaded: 0, skippedIdentical: 0 })) }));

import type KeepSidianPlugin from "@app/main";
import type { MergeAction } from "@types";
import { processAndSaveNote } from "../sync";
import { processAttachments } from "../io/attachments";

beforeEach(() => jest.clearAllMocks());

it.each<MergeAction>(["merge-save-conflicts", "merge-skip-conflicts", "merge-overwrite-conflicts", "overwrite-all"])("applies %s to download I/O and attachment handling", async (action) => {
	const original = "---\nKeepSidianLastSyncedDate: 2024-01-01T00:00:00.000Z\n---\nshared\nlocal edit";
	const files = new Map([["Keep/note.md", original]]);
	const write = jest.fn(async (path: string, content: string) => { files.set(path, content); });
	const plugin = {
		settings: { saveLocation: "Keep", email: "test@example.com", token: "test-token" },
		app: { vault: {
			adapter: { read: jest.fn(async (path: string) => files.get(path) ?? ""), write, exists: jest.fn(async () => true) },
			createFolder: jest.fn(async () => {}),
		} },
		throwIfSyncCancelled: jest.fn(),
	} as unknown as KeepSidianPlugin;
	const conflict = jest.fn();
	const result = await processAndSaveNote(plugin, { title: "note", text: "shared\nremote edit", blob_urls: ["https://example.invalid/test.png"] }, "Keep", undefined, undefined, undefined, undefined, undefined, undefined, action, conflict);
	if (action === "merge-skip-conflicts") {
		expect(result.action).toBe("skipped-conflict");
		expect(write).not.toHaveBeenCalled();
		expect(processAttachments).not.toHaveBeenCalled();
		expect(files.get("Keep/note.md")).toBe(original);
		expect(conflict).toHaveBeenCalledWith("Keep/note.md");
	} else if (action === "merge-save-conflicts") {
		expect(result.action).toBe("conflict");
		expect(files.get("Keep/note.md")).toBe(original);
		const copy = Array.from(files.entries()).find(([path]) => path.includes("-conflict-"));
		expect(copy?.[1]).toContain("<<<<<<< existing");
		expect(copy?.[1]).toContain("remote edit");
		expect(conflict).toHaveBeenCalledWith("Keep/note.md");
	} else {
		expect(result.action).toBe("overwritten");
		expect(files.get("Keep/note.md")).toContain("shared\nremote edit");
		expect(files.get("Keep/note.md")).not.toContain("local edit");
		expect(files.get("Keep/note.md")).not.toContain("<<<<<<<");
		expect(conflict).not.toHaveBeenCalled();
	}
});
