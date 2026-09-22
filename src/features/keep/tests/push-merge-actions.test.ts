jest.mock("obsidian");
jest.mock("@integrations/server/keepApi", () => ({ fetchNotes: jest.fn(), pushNotes: jest.fn() }));
jest.mock("@app/logging", () => ({ logSync: jest.fn().mockResolvedValue(undefined), flushLogSync: jest.fn().mockResolvedValue(undefined) }));

import type KeepSidianPlugin from "@app/main";
import { fetchNotes, pushNotes } from "@integrations/server/keepApi";
import type { PushNotePayload } from "@integrations/server/keepApi";
import { buildPushSyncPlan, pushGoogleKeepNotes } from "../push";
import type { MergeAction } from "@types";

function fixture(body = "shared\nlocal edit", remoteBody = "shared\nremote edit") {
	const content = `---\nGoogleKeepUrl: https://keep.google.com/u/0/#NOTE/one\nKeepSidianLastSyncedDate: 2024-01-01T00:00:00.000Z\n---\n${body}`;
	const files = new Map<string, string>([["Keep/note.md", content]]);
	const remote = { id: "one", title: "note", text: remoteBody, updated: "2024-01-06T00:00:00.000Z" };
	const adapter = {
		list: jest.fn(async () => ({ files: Array.from(files.keys()).filter((path) => path.endsWith(".md")), folders: [] })),
		read: jest.fn(async (path: string) => {
			if (!files.has(path)) throw new Error("Missing test file");
			return files.get(path)!;
		}),
		write: jest.fn(async (path: string, text: string) => { files.set(path, text); }),
		exists: jest.fn(async (path: string) => files.has(path) || path === "Keep" || path === "Keep/media"),
		stat: jest.fn(async () => ({ mtime: Date.parse("2024-01-05T00:00:00Z") })),
		readBinary: jest.fn(async () => new ArrayBuffer(0)),
		writeBinary: jest.fn(async () => {}),
	};
	const plugin = {
		settings: { saveLocation: "Keep", email: "test@example.com", token: "test-token", frontmatterPascalCaseFixApplied: true },
		app: { vault: { adapter, createFolder: jest.fn(async () => {}) } },
		throwIfSyncCancelled: jest.fn(),
	} as unknown as KeepSidianPlugin;
	(fetchNotes as jest.Mock).mockImplementation(async () => ({ notes: [remote] }));
	(pushNotes as jest.Mock).mockImplementation(async (_email: string, _token: string, notes: PushNotePayload[]) => ({ results: notes.map((note) => ({ path: note.path, success: true })) }));
	const build = () => buildPushSyncPlan(plugin, true, undefined, { reviewMerges: true });
	return { plugin, files, content, remote, adapter, build };
}

beforeEach(() => jest.clearAllMocks());

describe("reviewed upload merge actions", () => {
	it.each<MergeAction>(["merge-save-conflicts", "merge-skip-conflicts", "merge-overwrite-conflicts", "overwrite-all"])("applies %s to an actual conflicting upload", async (action) => {
		const f = fixture();
		const built = await f.build();
		expect(built.plan.entries[0].action).toBe("conflict-copy");
		const settled = jest.fn(), conflict = jest.fn();
		const count = await pushGoogleKeepNotes(f.plugin, { mergeAction: action, onEntrySettled: settled, onMergeConflict: conflict }, built.notesToPush);
		if (action === "merge-save-conflicts" || action === "merge-skip-conflicts") {
			expect(count).toBe(0);
			expect(pushNotes).not.toHaveBeenCalled();
			expect(f.files.get("Keep/note.md")).toBe(f.content);
			expect(conflict).toHaveBeenCalledWith("Keep/note.md");
			expect(settled).toHaveBeenCalledWith(built.plan.entries[0].id, true, action === "merge-save-conflicts" ? "conflict-copy" : "skipped-conflict");
			const copies = Array.from(f.files.keys()).filter((path) => path.includes("-conflict-"));
			expect(copies).toHaveLength(action === "merge-save-conflicts" ? 1 : 0);
			if (copies.length) {
				expect(f.files.get(copies[0])).toContain("<<<<<<< existing");
				expect(f.files.get(copies[0])).toContain("local edit");
				expect(f.files.get(copies[0])).toContain("remote edit");
			}
		} else {
			expect(count).toBe(1);
			expect(pushNotes).toHaveBeenCalledTimes(1);
			const payload = (pushNotes as jest.Mock).mock.calls[0][2] as PushNotePayload[];
			expect(payload[0].content).toContain("local edit");
			expect(payload[0].content).not.toContain("remote edit");
			expect(payload[0].content).not.toContain("<<<<<<<");
			expect(conflict).not.toHaveBeenCalled();
			expect(settled).toHaveBeenCalledWith(built.plan.entries[0].id, true, "overwrite");
		}
	});

	it.each<MergeAction>(["merge-save-conflicts", "merge-skip-conflicts", "merge-overwrite-conflicts"])("preserves clean changes on both sides under %s", async (action) => {
		const f = fixture("common\nlocal addition", "remote addition\ncommon");
		const built = await f.build();
		expect(built.plan.entries[0].action).toBe("merge");
		await pushGoogleKeepNotes(f.plugin, { mergeAction: action }, built.notesToPush);
		const payload = (pushNotes as jest.Mock).mock.calls[0][2] as PushNotePayload[];
		expect(payload[0].content).toContain("remote addition\ncommon\nlocal addition");
		expect(f.files.get("Keep/note.md")).toContain("remote addition\ncommon\nlocal addition");
	});

	it("overwrite all discards remote-only additions instead of merging them", async () => {
		const f = fixture("common\nlocal addition", "remote addition\ncommon");
		const built = await f.build();
		await pushGoogleKeepNotes(f.plugin, { mergeAction: "overwrite-all" }, built.notesToPush);
		expect(f.files.get("Keep/note.md")).not.toContain("remote addition");
	});

	it.each(["local", "remote"])("aborts before any writes when %s changed after review", async (side) => {
		const f = fixture();
		const built = await f.build();
		if (side === "local") f.files.set("Keep/note.md", `${f.content}\nnew edit`);
		else f.remote.text += "\nnew edit";
		await expect(pushGoogleKeepNotes(f.plugin, { mergeAction: "overwrite-all" }, built.notesToPush)).rejects.toThrow(/changed after review/);
		expect(pushNotes).not.toHaveBeenCalled();
		expect(f.adapter.write).not.toHaveBeenCalled();
	});

	it("requires an explicit success before stamping the local note", async () => {
		const f = fixture();
		const built = await f.build();
		(pushNotes as jest.Mock).mockResolvedValue({ results: [] });
		await expect(pushGoogleKeepNotes(f.plugin, { mergeAction: "overwrite-all" }, built.notesToPush)).rejects.toThrow();
		expect(f.files.get("Keep/note.md")).toBe(f.content);
	});

	it("preserves local edits made while an upload is in flight", async () => {
		const f = fixture();
		const built = await f.build();
		(pushNotes as jest.Mock).mockImplementation(async () => {
			f.files.set("Keep/note.md", `${f.content}\nin-flight edit`);
			return { results: [{ path: "note.md", success: true }] };
		});
		await expect(pushGoogleKeepNotes(f.plugin, { mergeAction: "overwrite-all" }, built.notesToPush)).rejects.toThrow(/in flight/);
		expect(f.files.get("Keep/note.md")).toContain("in-flight edit");
		expect(f.adapter.write).not.toHaveBeenCalled();
	});

	it("fails safely when a linked remote note cannot be found", async () => {
		const f = fixture();
		(fetchNotes as jest.Mock).mockResolvedValue({ notes: [] });
		await expect(f.build()).rejects.toThrow(/linked Keep note is unavailable/);
		expect(pushNotes).not.toHaveBeenCalled();
	});

	it("keeps preserved download conflicts out of the upload plan", async () => {
		const f = fixture();
		const built = await buildPushSyncPlan(f.plugin, true, undefined, { reviewMerges: true, protectedPaths: ["Keep/note.md"] });
		expect(built.notesToPush).toHaveLength(0);
		expect(built.plan.entries[0].action).toBe("skipped-conflict");
		expect(built.plan.entries[0].selectable).toBe(false);
		expect(fetchNotes).not.toHaveBeenCalled();
	});

	it("includes a clean two-way merge even after download stamped it as synced", async () => {
		const f = fixture("common\nlocal addition", "common");
		f.files.set("Keep/note.md", f.content.replace("2024-01-01", "2024-01-10"));
		const ordinary = await f.build();
		expect(ordinary.notesToPush).toHaveLength(0);
		const forced = await buildPushSyncPlan(f.plugin, true, undefined, { reviewMerges: true, forcePaths: ["Keep/note.md"] });
		expect(forced.notesToPush).toHaveLength(1);
		await pushGoogleKeepNotes(f.plugin, { mergeAction: "merge-save-conflicts" }, forced.notesToPush);
		expect(pushNotes).toHaveBeenCalledTimes(1);
	});

	it("keeps a plan entry ID when a subset is executed", async () => {
		const f = fixture();
		const built = await f.build();
		built.notesToPush[0].planEntryId = "upload:9:Keep/note.md";
		const settled = jest.fn();
		await pushGoogleKeepNotes(f.plugin, { mergeAction: "overwrite-all", onEntrySettled: settled }, built.notesToPush);
		expect(settled).toHaveBeenCalledWith("upload:9:Keep/note.md", true, "overwrite");
	});

	it("retains local-only deletions when Keep has not changed since the baseline", async () => {
		const f = fixture("common", "common\nold line");
		f.remote.updated = "2023-12-31T00:00:00.000Z";
		const built = await f.build();
		expect(built.plan.entries[0].action).toBe("upload");
		await pushGoogleKeepNotes(f.plugin, { mergeAction: "merge-save-conflicts" }, built.notesToPush);
		const payload = (pushNotes as jest.Mock).mock.calls[0][2] as PushNotePayload[];
		expect(payload[0].content).not.toContain("old line");
	});
});
