jest.mock("obsidian");
jest.mock("@features/keep/domain/compare", () => ({ handleDuplicateNotes: jest.fn(async () => "merge") }));
jest.mock("@features/keep/domain/noteLookup", () => ({
	findExistingKeepNotePath: jest.fn(async () => "Keep/note.md"),
	buildExistingKeepNoteIndex: jest.fn(), updateExistingKeepNoteIndex: jest.fn(),
}));
jest.mock("@services/note-path-resolver", () => ({ resolveNotePath: () => "Keep/note.md", resolveNoteFolder: () => "Keep" }));
jest.mock("@app/logging", () => ({ logSync: jest.fn(async () => {}), flushLogSync: jest.fn(async () => {}) }));
jest.mock("@features/keep/io/attachments", () => ({ processAttachments: jest.fn(async () => ({ downloaded: 0, skippedIdentical: 0 })) }));

import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import { bodyBaseline, withSyncState } from "../domain/sync-state";
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
	const result = await processAndSaveNote(plugin, { title: "note", text: "shared\nremote edit", blob_urls: ["https://example.invalid/test.png"] }, "Keep", undefined, undefined, undefined, undefined, undefined, undefined, undefined, action, conflict);
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

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
// Node 18's Jest VM can retain the installed global despite redefinition.
// Mutate one shared provider so the production module sees unavailable crypto.
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

it.each(["unchanged", "edited", "pending", "missing", "malformed", "wrong-identity", "crypto-unavailable", "local-image", "managed-image", "older-remote", "missing-remote-time", "invalid-remote-time"] as const)(
	"uses the acknowledged body rather than post-upload metadata writes to resolve a remote edit (%s)",
	async (scenario) => {
		const localBody = scenario === "edited" ? "Local edit after upload" : "Synthetic marker A" +
		(scenario === "local-image" ? "\n![[media/local.png]]" : scenario === "managed-image" ? "\n<!-- keepsidian-embedded-images:start -->\n![[media/local.png]]\n<!-- keepsidian-embedded-images:end -->" : "");
		const baseline =
			scenario === "missing"
				? undefined
				: scenario === "malformed"
					? "sha256:bad"
					: await bodyBaseline("assigned-server-id", "Synthetic marker A");
		const header = withSyncState(
			"GoogleKeepUrl: https://keep.google.com/#NOTE/assigned-server-id\nKeepSidianLastSyncedDate: 2026-10-05T18:24:42.000Z",
			scenario === "pending",
			baseline
		);
		const original = `---\n${header}${scenario === "malformed" ? "\nKeepSidianRemoteBaseline: sha256:bad" : ""}\n---\n${localBody}`;
		const files = new Map([["Keep/note.md", original]]);
		const write = jest.fn(async (path: string, content: string) => {
			files.set(path, content);
		});
		const plugin = {
			settings: { saveLocation: "Keep", email: "test@example.com", token: "test-token" },
			app: {
				vault: {
					adapter: {
						read: jest.fn(async (path: string) => files.get(path) ?? ""),
						write,
						exists: jest.fn(async () => true),
					},
					createFolder: jest.fn(async () => {}),
				},
			},
			throwIfSyncCancelled: jest.fn(),
		} as unknown as KeepSidianPlugin;
		const conflict = jest.fn();
		const remote = {
			updated: scenario === "older-remote" ? "2026-10-05T18:00:00.000Z" : scenario === "missing-remote-time" ? undefined : scenario === "invalid-remote-time" ? "invalid" : "2026-10-05T18:28:00.000Z",
			id: scenario === "wrong-identity" ? "another-server-id" : "assigned-server-id",
			title: "note",
			text: "Synthetic marker B",
		};
		if (scenario === "crypto-unavailable") {
			cryptoProvider.subtle = undefined;
		}
		let result: Awaited<ReturnType<typeof processAndSaveNote>>;
		try {
			if (scenario === "crypto-unavailable") {
				expect(globalThis.crypto?.subtle).toBeUndefined();
				expect(await bodyBaseline("assigned-server-id", "Synthetic marker A")).toBeUndefined();
			}
			result = await processAndSaveNote(
				plugin,
				remote,
				"Keep",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"merge-save-conflicts",
				conflict
			);
		} finally {
			cryptoProvider.subtle = webcrypto.subtle;
		}
		if (scenario === "unchanged") {
			expect(result.action).toBe("overwritten");
			expect(Array.from(files.keys())).toEqual(["Keep/note.md"]);
			expect(files.get("Keep/note.md")).toContain("Synthetic marker B");
			expect(files.get("Keep/note.md")).not.toContain("Synthetic marker A");
			expect(files.get("Keep/note.md")).not.toContain("KeepSidianPendingUpload");
			expect(conflict).not.toHaveBeenCalled();
		} else {
			expect(result.action).toBe("conflict");
			expect(files.get("Keep/note.md")).toBe(original);
			expect(conflict).toHaveBeenCalledWith("Keep/note.md");
		}
	}
);
