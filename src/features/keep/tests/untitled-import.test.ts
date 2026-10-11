jest.mock("obsidian");
jest.mock("@app/logging", () => ({ logSync: jest.fn().mockResolvedValue(undefined), flushLogSync: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../io/attachments", () => ({ processAttachments: jest.fn().mockResolvedValue({ downloaded: 1, skippedIdentical: 0, fileNames: [] }) }));
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import type KeepSidianPlugin from "@app/main";
import { processAndSaveNote } from "../sync";
import { processAttachments } from "../io/attachments";
import { collectNotesToPush } from "../push/collectNotes";
import { extractFrontmatter } from "../domain/note";

const priorCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const priorEncoder = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterAll(() => {
	if (priorCrypto) Object.defineProperty(globalThis, "crypto", priorCrypto);
	else Reflect.deleteProperty(globalThis, "crypto");
	if (priorEncoder) Object.defineProperty(globalThis, "TextEncoder", priorEncoder);
	else Reflect.deleteProperty(globalThis, "TextEncoder");
});

it("imports empty, body-only and image-only notes separately, preserves collisions and repeats without uploads", async () => {
	const occupied = "Keep/Untitled KeepSidian Note.md";
	const files = new Map([[occupied, "User-owned file: preserve byte for byte."]]);
	const adapter = {
		read: jest.fn(async (path: string) => files.get(path) ?? ""),
		write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
		exists: jest.fn(async (path: string) => files.has(path)),
		list: jest.fn(async () => ({ files: [...files.keys()], folders: [] })),
		stat: jest.fn(async () => ({ ctime: 0, mtime: Date.now(), size: 0, type: "file" })),
	};
	const plugin = { settings: { saveLocation: "Keep", saveLocationMode: "custom", noteFileNamePattern: "{title}", frontmatterPascalCaseFixApplied: true, email: "fixture@example.invalid", token: "synthetic", embedImportedImages: false }, app: { vault: { adapter } }, throwIfSyncCancelled: jest.fn() } as unknown as KeepSidianPlugin;
	const notes = [
		{ id: "empty", title: "", text: "" },
		{ id: "body-only", title: "  ", text: "Body-only note" },
		{ id: "image-only", title: "", text: "", blob_urls: ["/keep/media/image-only/image"], blob_names: ["image.png"] },
	];
	const paths: string[] = [];
	for (const note of notes) {
		const result = await processAndSaveNote(plugin, note, "Keep", undefined, undefined, async () => {}, async () => {});
		expect(result.action).toBe("created");
		paths.push(result.notePath!);
		expect(extractFrontmatter(files.get(result.notePath!)!)[1]).toBe(note.text);
	}
	expect(new Set(paths).size).toBe(3);
	expect(files.get(occupied)).toBe("User-owned file: preserve byte for byte.");
	expect(processAttachments).toHaveBeenCalledTimes(1);
	expect((await collectNotesToPush(plugin)).notesToPush).toHaveLength(0);
	for (const [index, note] of notes.entries()) {
		const result = await processAndSaveNote(plugin, note, "Keep", undefined, undefined, async () => {}, async () => {});
		expect(result.notePath).toBe(paths[index]);
	}
	expect(files.size).toBe(4);
	expect((await collectNotesToPush(plugin)).notesToPush).toHaveLength(0);
});
