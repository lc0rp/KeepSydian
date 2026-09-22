jest.mock("obsidian");
jest.mock("@app/sync-ui", () => ({ startSyncUI: jest.fn(), finishSyncUI: jest.fn(), setTotalNotes: jest.fn(), reportSyncProgress: jest.fn() }));
jest.mock("@app/logging", () => ({ prepareSyncLog: jest.fn(async () => true), logSync: jest.fn(async () => {}), flushLogSync: jest.fn(async () => {}) }));
jest.mock("@services/paths", () => ({ ensureFolder: jest.fn(async () => {}), normalizePathSafe: (path: string) => path }));
jest.mock("@services/note-path-resolver", () => ({ resolveLogBaseFolder: () => "Keep" }));
jest.mock("@features/keep/sync", () => ({
	buildImportSyncPlan: jest.fn(), importGoogleKeepNotes: jest.fn(), importGoogleKeepNotesWithOptions: jest.fn(),
	importSelectedGoogleKeepNotes: jest.fn(), persistLastSuccessfulSyncDate: jest.fn(),
}));
jest.mock("@features/keep/push", () => ({ buildPushSyncPlan: jest.fn(), pushGoogleKeepNotes: jest.fn() }));

import type KeepSidianPlugin from "@app/main";
import type { SyncAttempt } from "@app/sync-attempt";
import type { SyncCallbacks } from "@features/keep/sync";
import type { NoteForPush } from "@features/keep/push/collectNotes";
import { runPreparedSyncPlan } from "@app/main-sync-flows";
import { importSelectedGoogleKeepNotes, persistLastSuccessfulSyncDate } from "@features/keep/sync";
import { buildPushSyncPlan, pushGoogleKeepNotes } from "@features/keep/push";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";

function setup() {
	const plugin = {
		settings: { saveLocation: "Keep" },
		subscriptionService: { isSubscriptionActive: jest.fn(async () => true) },
		throwIfSyncCancelled: jest.fn(),
	} as unknown as KeepSidianPlugin;
	const attempt = {
		id: "test-attempt", mode: "two-way", finished: false,
		start: jest.fn(async () => {}), transition: jest.fn(async () => {}),
		finish: jest.fn(async () => {}), fail: jest.fn(async () => {}),
	} as unknown as SyncAttempt;
	const prepared = createPreparedSyncPlanFixture("two-way", "import", [
		createSyncPlanEntryFixture("merge", "Merge", { id: "download-entry", path: "Keep/note.md" }),
	]);
	prepared.attempt = attempt;
	prepared.importNotes = [{ title: "note", text: "source" }];
	prepared.importEntryIds = ["download-entry"];
	prepared.completionDate = "2024-02-01T00:00:00.000Z";
	const next = createPreparedSyncPlanFixture("two-way", "upload", [
		createSyncPlanEntryFixture("upload", "Upload", { id: "upload:0:Keep/other.md", path: "Keep/other.md", stage: "upload" }),
	]);
	const pushNote = { fullPath: "Keep/other.md" } as NoteForPush;
	(buildPushSyncPlan as jest.Mock).mockResolvedValue({ plan: next.plan, notesToPush: [pushNote] });
	(pushGoogleKeepNotes as jest.Mock).mockResolvedValue(1);
	const onSuccess = jest.fn();
	return { plugin, attempt, prepared, onSuccess };
}

beforeEach(() => jest.clearAllMocks());

it.each(["merge-save-conflicts", "merge-skip-conflicts"] as const)("carries %s and protected originals into the second phase without advancing the checkpoint", async (action) => {
	const f = setup();
	f.prepared.plan.mergeAction = action;
	(importSelectedGoogleKeepNotes as jest.Mock).mockImplementation(async (_plugin: unknown, _notes: unknown, callbacks: SyncCallbacks) => {
		expect(callbacks.mergeAction).toBe(action);
		callbacks.onMergeConflict?.("Keep/note.md");
		callbacks.onEntrySettled?.("download-entry", true, action === "merge-save-conflicts" ? "conflict-copy" : "skipped-conflict");
		return 1;
	});
	const result = await runPreparedSyncPlan(f.plugin, f.prepared, String, f.onSuccess);
	expect(result.nextPlan?.plan.mergeAction).toBe(action);
	expect(result.nextPlan?.unresolvedConflictPaths).toEqual(["Keep/note.md"]);
	expect(buildPushSyncPlan).toHaveBeenCalledWith(f.plugin, true, undefined, expect.objectContaining({ protectedPaths: ["Keep/note.md"], reviewMerges: true }));
	expect(persistLastSuccessfulSyncDate).not.toHaveBeenCalled();
	await runPreparedSyncPlan(f.plugin, result.nextPlan!, String, f.onSuccess);
	expect(persistLastSuccessfulSyncDate).not.toHaveBeenCalled();
	expect(f.onSuccess).not.toHaveBeenCalled();
});

it("forces a clean downloaded merge into upload even though its download timestamp is current", async () => {
	const f = setup();
	(importSelectedGoogleKeepNotes as jest.Mock).mockImplementation(async (_plugin: unknown, _notes: unknown, callbacks: SyncCallbacks) => {
		callbacks.onEntrySettled?.("download-entry", true, "merge"); return 1;
	});
	const result = await runPreparedSyncPlan(f.plugin, f.prepared, String, f.onSuccess);
	expect(result.nextPlan?.forceUploadPaths).toEqual(["Keep/note.md"]);
	expect(buildPushSyncPlan).toHaveBeenCalledWith(f.plugin, true, undefined, expect.objectContaining({ forcePaths: ["Keep/note.md"] }));
	await runPreparedSyncPlan(f.plugin, result.nextPlan!, String, f.onSuccess);
	expect(persistLastSuccessfulSyncDate).toHaveBeenCalledTimes(1);
	expect(persistLastSuccessfulSyncDate).toHaveBeenCalledWith(f.plugin, f.prepared.completionDate);
});

it("does not advance the checkpoint if the second phase fails", async () => {
	const f = setup();
	(importSelectedGoogleKeepNotes as jest.Mock).mockResolvedValue(1);
	const result = await runPreparedSyncPlan(f.plugin, f.prepared, String, f.onSuccess);
	(pushGoogleKeepNotes as jest.Mock).mockRejectedValue(new Error("test upload failed"));
	const failed = await runPreparedSyncPlan(f.plugin, result.nextPlan!, String, f.onSuccess);
	expect(failed.failed).toBe(true);
	expect(persistLastSuccessfulSyncDate).not.toHaveBeenCalled();
});

it("finishes a two-way run with no upload work", async () => {
	const f = setup();
	(importSelectedGoogleKeepNotes as jest.Mock).mockResolvedValue(1);
	const empty = createPreparedSyncPlanFixture("two-way", "upload", []);
	(buildPushSyncPlan as jest.Mock).mockResolvedValue({ plan: empty.plan, notesToPush: [] });
	const result = await runPreparedSyncPlan(f.plugin, f.prepared, String, f.onSuccess);
	expect(result.nextPlan).toBeUndefined();
	expect(persistLastSuccessfulSyncDate).toHaveBeenCalledWith(f.plugin, f.prepared.completionDate);
	expect(f.onSuccess).toHaveBeenCalledTimes(1);
});

it("keeps download-only skipped conflicts eligible for a future download", async () => {
	const f = setup();
	f.prepared.mode = "import";
	f.prepared.plan.mode = "import";
	f.prepared.plan.mergeAction = "merge-skip-conflicts";
	(importSelectedGoogleKeepNotes as jest.Mock).mockImplementation(async (_plugin: unknown, _notes: unknown, callbacks: SyncCallbacks) => {
		callbacks.onMergeConflict?.("Keep/note.md"); return 1;
	});
	await runPreparedSyncPlan(f.plugin, f.prepared, String, f.onSuccess);
	expect(buildPushSyncPlan).not.toHaveBeenCalled();
	expect(persistLastSuccessfulSyncDate).not.toHaveBeenCalled();
});
