jest.mock("obsidian");
jest.mock("@app/sync-ui", () => ({ startSyncUI: jest.fn(), finishSyncUI: jest.fn(), setTotalNotes: jest.fn(), reportSyncProgress: jest.fn() }));
jest.mock("@integrations/server/keepApi", () => ({ fetchNotesWithPremiumFeatures: jest.fn(), pushNotes: jest.fn() }));
jest.mock("@app/logging", () => ({ prepareSyncLog: jest.fn(async () => true), logSync: jest.fn().mockResolvedValue(undefined), flushLogSync: jest.fn().mockResolvedValue(undefined) }));

import type KeepSidianPlugin from "@app/main";
import { fetchNotesWithPremiumFeatures, pushNotes } from "@integrations/server/keepApi";
import type { PushNotePayload } from "@integrations/server/keepApi";
import { buildPushSyncPlan, pushGoogleKeepNotes } from "../push";
import { runPreparedSyncPlan } from "@app/main-sync-flows";
import { excludeDeletionUploads } from "../deletion-upload-exclusions";
import type { PreparedDeletions } from "../deletions";
import { NetworkError } from "@services/errors";
import type { SyncAttempt } from "@app/sync-attempt";
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
	(fetchNotesWithPremiumFeatures as jest.Mock).mockImplementation(async () => ({ notes: [remote], total_notes: 1, upload_review_scope: "all-nontrashed" }));
	(pushNotes as jest.Mock).mockImplementation(async (_email: string, _token: string, notes: PushNotePayload[]) => ({ results: notes.map((note) => ({ path: note.path, success: true })) }));
	const build = () => buildPushSyncPlan(plugin, true, undefined, { reviewMerges: true });
	return { plugin, files, content, remote, adapter, build };
}

beforeEach(() => jest.clearAllMocks());

describe("reviewed upload merge actions", () => {
	it("reviews archived linked notes across pages using only the authorized archive filter", async () => {
		const f = fixture();
		f.plugin.settings.supporterKeyConfigured = true;
		f.plugin.settings.supporterKey = "synthetic-supporter";
		(fetchNotesWithPremiumFeatures as jest.Mock)
			.mockResolvedValueOnce({ notes: [{ id: "other", text: "active" }], next_cursor: "page-two", total_notes: 2, upload_review_scope: "all-nontrashed" })
			.mockResolvedValueOnce({ notes: [{ ...f.remote, archived: true }], total_notes: 2, upload_review_scope: "all-nontrashed" });
		const built = await f.build();
		expect(built.notesToPush).toHaveLength(1);
		expect(fetchNotesWithPremiumFeatures).toHaveBeenNthCalledWith(1, "test@example.com", "test-token", { keep_state_filter: { archived: "all" } }, 0, 100, undefined, undefined, "synthetic-supporter", undefined, true);
		expect(fetchNotesWithPremiumFeatures).toHaveBeenNthCalledWith(2, "test@example.com", "test-token", { keep_state_filter: { archived: "all" } }, 0, 100, undefined, "page-two", "synthetic-supporter", undefined, true);
		expect(f.adapter.write).not.toHaveBeenCalled();
		expect(pushNotes).not.toHaveBeenCalled();
	});

	it("does not bypass a denied archive lookup or write locally", async () => {
		const f = fixture();
		(fetchNotesWithPremiumFeatures as jest.Mock).mockRejectedValueOnce(new Error("synthetic denied response"));
		await expect(f.build()).rejects.toMatchObject({ code: "upload_review_failed" });
		expect(fetchNotesWithPremiumFeatures).toHaveBeenCalledTimes(1);
		expect(f.adapter.write).not.toHaveBeenCalled();
		expect(pushNotes).not.toHaveBeenCalled();
	});

    it("offers eligible notes alongside blocked links only for a complete verified index", async () => {
        const f = fixture();
        f.files.set("Keep/missing.md", f.content.replace("#NOTE/one", "#NOTE/missing"));
        (fetchNotesWithPremiumFeatures as jest.Mock).mockResolvedValue({ notes: [f.remote], total_notes: 1, upload_review_scope: "all-nontrashed" });
        const built = await f.build();
        expect(built.notesToPush).toHaveLength(1);
        expect(built.plan.blockedUploads).toBe(1);
        expect(built.plan.entries.find(e => e.path === "Keep/missing.md")).toMatchObject({ selectable: false, selected: false });
        expect(f.adapter.write).not.toHaveBeenCalled();
        expect(pushNotes).not.toHaveBeenCalled();
    });
    it("keeps an all-blocked plan visible without actionable uploads", async () => {
        const f = fixture();
        f.plugin.settings.frontmatterPascalCaseFixApplied = false;
        (fetchNotesWithPremiumFeatures as jest.Mock).mockResolvedValue({ notes: [], total_notes: 0, upload_review_scope: "all-nontrashed" });
        const built = await f.build();
        expect(built.plan).toMatchObject({ blockedUploads: 1, actionableCount: 0 });
        expect(built.notesToPush).toEqual([]);
        expect(f.adapter.write).not.toHaveBeenCalled();
    });
    it.each([
        { notes: [], total_notes: 0 },
        { notes: [], total_notes: 1, upload_review_scope: "all-nontrashed" },
    ])("fails the entire plan when scope or completeness is unverified", async response => {
        const f = fixture();
        (fetchNotesWithPremiumFeatures as jest.Mock).mockResolvedValue(response);
        await expect(f.build()).rejects.toMatchObject({ code: response.upload_review_scope ? "upload_review_failed" : "upload_review_scope_unconfirmed" });
        expect(f.adapter.write).not.toHaveBeenCalled();
        expect(pushNotes).not.toHaveBeenCalled();
    });

    it("uploads eligible notes without touching a blocked local note", async () => {
        const f = fixture("shared", "shared");
        const blocked = f.content.replace("#NOTE/one", "#NOTE/missing");
        f.files.set("Keep/missing.md", blocked);
        (fetchNotesWithPremiumFeatures as jest.Mock).mockResolvedValue({ notes: [f.remote], total_notes: 1, upload_review_scope: "all-nontrashed" });
        const built = await f.build();
        await pushGoogleKeepNotes(f.plugin, { mergeAction: "overwrite-all" }, built.notesToPush);
        expect(f.files.get("Keep/missing.md")).toBe(blocked);
        expect(pushNotes).toHaveBeenCalledTimes(1);
        expect((pushNotes as jest.Mock).mock.calls[0][2]).toHaveLength(1);
    });
    it("rejects an unconfirmed index even when the linked note is present", async () => {
        const f = fixture();
        (fetchNotesWithPremiumFeatures as jest.Mock).mockResolvedValue({ notes: [f.remote], total_notes: 1 });
        await expect(f.build()).rejects.toMatchObject({ code: "upload_review_scope_unconfirmed" });
        expect(f.adapter.write).not.toHaveBeenCalled();
    });
    it("revalidates scope before writing eligible notes", async () => {
        const f = fixture();
        const built = await f.build();
        (fetchNotesWithPremiumFeatures as jest.Mock).mockResolvedValue({ notes: [f.remote], total_notes: 1 });
        await expect(pushGoogleKeepNotes(f.plugin, { mergeAction: "overwrite-all" }, built.notesToPush)).rejects.toMatchObject({ code: "upload_review_scope_unconfirmed" });
        expect(f.adapter.write).not.toHaveBeenCalled();
        expect(pushNotes).not.toHaveBeenCalled();
    });

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
		(fetchNotesWithPremiumFeatures as jest.Mock).mockResolvedValue({ notes: [] });
		await expect(f.build()).rejects.toMatchObject({ code: "upload_review_scope_unconfirmed" });
		expect(pushNotes).not.toHaveBeenCalled();
	});

	it("keeps preserved download conflicts out of the upload plan", async () => {
		const f = fixture();
		const built = await buildPushSyncPlan(f.plugin, true, undefined, { reviewMerges: true, protectedPaths: ["Keep/note.md"] });
		expect(built.notesToPush).toHaveLength(0);
		expect(built.plan.entries[0].action).toBe("skipped-conflict");
		expect(built.plan.entries[0].selectable).toBe(false);
		expect(fetchNotesWithPremiumFeatures).not.toHaveBeenCalled();
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

	it("treats a local timestamp without a confirmed remote baseline conservatively", async () => {
		const f = fixture("common", "common\nold line");
		f.remote.updated = "2023-12-31T00:00:00.000Z";
		const built = await f.build();
		expect(built.plan.entries[0].action).toBe("merge");
		await pushGoogleKeepNotes(f.plugin, { mergeAction: "merge-save-conflicts" }, built.notesToPush);
		const payload = (pushNotes as jest.Mock).mock.calls[0][2] as PushNotePayload[];
		expect(payload[0].content).toContain("old line");
	});
});


describe("reviewed plan execution preserves selection identity", () => {
	it.each([true, false])("uploads the selected eligible note with blocked-first=%s", async (blockedFirst) => {
		const f = fixture("shared", "shared");
		f.files.clear();
		const blocked = f.content.replace("#NOTE/one", "#NOTE/missing");
		if (blockedFirst) f.files.set("Keep/blocked.md", blocked);
		f.files.set("Keep/eligible.md", f.content);
		f.files.set("Keep/unchecked.md", f.content);
		if (!blockedFirst) f.files.set("Keep/blocked.md", blocked);
		const built = await f.build();
		for (const entry of built.plan.entries) if (entry.path === "Keep/unchecked.md") entry.selected = false;
		built.plan.skipBlockedUploadsConfirmed = true;
		built.plan.mergeAction = "overwrite-all";
		const attempt = { id: "identity-regression", mode: "push", start: jest.fn(), transition: jest.fn(), finish: jest.fn(), fail: jest.fn() } as unknown as SyncAttempt;
		const settled = jest.fn();
		const result = await runPreparedSyncPlan(f.plugin, { mode: "push", stage: "upload", plan: built.plan, pushNotes: built.notesToPush, attempt }, String, jest.fn(), { onEntrySettled: settled });
		expect(result.failed).not.toBe(true);
		expect(pushNotes).toHaveBeenCalledTimes(1);
		expect((pushNotes as jest.Mock).mock.calls[0][2].map((n: PushNotePayload) => n.path)).toEqual(["eligible.md"]);
		const selected = built.plan.entries.find(e => e.path === "Keep/eligible.md")!;
		expect(settled).toHaveBeenCalledWith(selected.id, true, expect.anything());
		expect(f.files.get("Keep/blocked.md")).toBe(blocked);
		expect(f.files.get("Keep/unchecked.md")).toBe(f.content);
	});
});

it("explains denied archive entitlement without permitting partial uploads", async () => {
	const f = fixture();
	const error = new NetworkError("denied", 403);
	error.code = "sync_upload_review_requires_supporter";
	(fetchNotesWithPremiumFeatures as jest.Mock).mockRejectedValue(error);
	await expect(f.build()).rejects.toMatchObject({ code: "upload_review_requires_supporter" });
	expect(pushNotes).not.toHaveBeenCalled();
	expect(f.adapter.write).not.toHaveBeenCalled();
});

it.each(["missing", "duplicate", "wrong-path"])("rejects a %s selected candidate before writes", async kind => {
	const f = fixture("shared", "shared");
	const built = await f.build();
	if (kind === "missing") built.notesToPush = [];
	if (kind === "duplicate") built.notesToPush.push(built.notesToPush[0]);
	if (kind === "wrong-path") built.notesToPush[0].fullPath = "Keep/unreviewed.md";
	const attempt = { id: "mismatch", mode: "push", start: jest.fn(), transition: jest.fn(), finish: jest.fn(), fail: jest.fn() } as unknown as SyncAttempt;
	const result = await runPreparedSyncPlan(f.plugin, { mode: "push", stage: "upload", plan: built.plan, pushNotes: built.notesToPush, attempt }, String, jest.fn());
	expect(result.failed).toBe(true);
	expect(pushNotes).not.toHaveBeenCalled();
	expect(f.adapter.write).not.toHaveBeenCalled();
});

it.each(["googleKeepUrl", "google-keep-url"])("sends the reviewed identity for legacy %s without preparation writes", async alias => {
	const f = fixture("shared", "shared");
	f.files.set("Keep/note.md", f.content.replace("GoogleKeepUrl", alias));
	const built = await f.build();
	expect(f.adapter.write).not.toHaveBeenCalled();
	await pushGoogleKeepNotes(f.plugin, { mergeAction: "overwrite-all" }, built.notesToPush);
	const payload = (pushNotes as jest.Mock).mock.calls[0][2][0];
	expect(payload.content).toContain("GoogleKeepUrl: https://keep.google.com/#NOTE/one");
	expect(f.files.get("Keep/note.md")!.match(/^(?:googlekeepurl|google-keep-url):/gim)).toEqual(["GoogleKeepUrl:"]);
	expect((await f.build()).notesToPush).toHaveLength(0);
});

it("retains blocked consent metadata when deletion exclusions remove an eligible candidate", async () => {
	const f = fixture();
	f.files.set("Keep/blocked.md", f.content.replace("#NOTE/one", "#NOTE/missing"));
	const built = await f.build();
	const filtered = excludeDeletionUploads(built.plan, { candidates: [{ path: "Keep/note.md", file: { path: "Keep/note.md" } }] } as PreparedDeletions);
	expect(filtered.blockedUploads).toBe(1);
	expect(filtered.skipBlockedUploadsConfirmed).not.toBe(true);
	expect(filtered.entries.every(e => !e.selected)).toBe(true);
});
