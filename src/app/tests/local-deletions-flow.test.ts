jest.mock("obsidian");
jest.mock("@app/sync-ui");

import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import { Notice } from "obsidian";
import { buildManualSyncPlan, runPreparedSyncPlan, runImportNotesFlow } from "@app/main-sync-flows";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";
import * as imports from "@features/keep/sync";
import * as collector from "@features/keep/push/collectNotes";
import * as trashApi from "@integrations/server/keepTrash";
import * as inboundApi from "@integrations/server/keepDeletions";
import * as downloadApi from "@integrations/server/keepApi";
import { deletionFixture, keepUrl, noteText, REVISION } from "@features/keep/local-deletions/tests/support";

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
const completionDate = "2026-09-22T12:00:00.000Z";
let fixture: Awaited<ReturnType<typeof deletionFixture>>;

beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterAll(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
	if (encoderDescriptor) Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor);
});
beforeEach(async () => {
	fixture = await deletionFixture();
	jest.spyOn(collector, "collectNotesToPush").mockResolvedValue({ notesToPush: [], skippedNotes: [] });
	jest.spyOn(inboundApi, "fetchDeletedKeepUrls").mockResolvedValue(new Set());
	jest.spyOn(trashApi, "requestKeepTrash").mockImplementation(async (_email, _token, notes, apply) => notes.map((note) => ({
		keep_url: note.keep_url, status: apply ? "trashed" as const : "ready" as const,
	})));
});
afterEach(() => { fixture.cleanup(); jest.restoreAllMocks(); });

async function prepareTwoWay() {
	await fixture.download("a", "b");
	fixture.remove("Keep/a.md"); fixture.remove("Keep/b.md");
	const entries = ["a", "b"].map((id, index) => createSyncPlanEntryFixture("create", "Create", {
		id: `import:${index}`, path: `Keep/${id}.md`,
	}));
	jest.spyOn(imports, "buildImportSyncPlan").mockResolvedValue({
		plan: createPreparedSyncPlanFixture("import", "import", entries).plan,
		notes: ["a", "b"].map((id) => ({ title: id, text: noteText(id) })),
		noteEntryIds: entries.map((entry) => entry.id), completionDate,
	});
	const save = jest.spyOn(imports, "importSelectedGoogleKeepNotes").mockResolvedValue(0);
	const prepared = (await buildManualSyncPlan(fixture.plugin, "two-way"))!;
	return { prepared, save };
}

it("manual Push counts individual removals and honors an unchecked row", async () => {
	await fixture.download("a", "b");
	fixture.remove("Keep/a.md"); fixture.remove("Keep/b.md");
	const prepared = (await buildManualSyncPlan(fixture.plugin, "push"))!;
	expect(prepared.plan).toMatchObject({ counts: { "No longer in sync folder": 2 }, actionableCount: 2, selectedCount: 2 });
	prepared.plan.entries.find((entry) => entry.path === "Keep/b.md")!.selected = false;
	const settled = jest.fn();
	await expect(runPreparedSyncPlan(fixture.plugin, prepared, String, jest.fn(), { onEntrySettled: settled })).resolves.toEqual({});
	const applications = jest.mocked(trashApi.requestKeepTrash).mock.calls.filter((call) => call[3] === true);
	expect(applications).toHaveLength(1);
	expect(applications[0][2]).toEqual([expect.objectContaining({ keep_url: keepUrl("a") })]);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("b")]);
	expect(settled).toHaveBeenCalledWith(prepared.plan.entries[0].id, true, "delete");
});

it("protects offline removals before two-way download and presents upload review", async () => {
	const { prepared, save } = await prepareTwoWay();
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	expect(prepared.plan.entries.every((entry) => !entry.selectable && entry.label === "Preserved local removal")).toBe(true);
	const success = jest.fn();
	const result = await runPreparedSyncPlan(fixture.plugin, prepared, String, success);
	expect(result.nextPlan?.plan).toMatchObject({ stage: "upload", counts: { "No longer in sync folder": 2 } });
	expect(save).toHaveBeenCalledWith(fixture.plugin, [], expect.any(Object), undefined, []);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	expect(success).not.toHaveBeenCalled();
	result.nextPlan!.plan.entries[1].selected = false;
	await expect(runPreparedSyncPlan(fixture.plugin, result.nextPlan!, String, success)).resolves.toEqual({});
	expect(success).toHaveBeenCalledTimes(1);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(completionDate);
	expect(fixture.stored.has("Keep/b.md")).toBe(false);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("b")]);
});

it.each([false, true])("finishes an unchecked upload review without writes and preserves conflict checkpoint gating (%s)", async (conflict) => {
	const { prepared } = await prepareTwoWay();
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	const success = jest.fn();
	const { nextPlan } = await runPreparedSyncPlan(fixture.plugin, prepared, String, success);
	const path = "Keep/unchecked.md";
	const content = "Unlinked synthetic upload";
	fixture.put(path, content);
	nextPlan!.pushNotes = [{ fullPath: path, relativePath: "unchecked.md", title: "Unchecked", content,
		body: content, frontmatter: "", lastSyncedDate: null, modifiedSinceLastSync: true,
		attachments: [], updatedAttachmentNames: [], missingAttachments: [] }];
	nextPlan!.plan.entries.push(createSyncPlanEntryFixture("upload", "Upload", {
		id: `upload:0:${path}`, mode: "two-way", stage: "upload", path,
	}));
	for (const entry of nextPlan!.plan.entries) entry.selected = false;
	if (conflict) nextPlan!.unresolvedConflictPaths = ["Keep/conflict.md"];
	const push = jest.spyOn(downloadApi, "pushNotes");
	jest.mocked(trashApi.requestKeepTrash).mockClear();
	fixture.vault.adapter.write.mockClear();

	await expect(runPreparedSyncPlan(fixture.plugin, nextPlan!, String, success)).resolves.toEqual({});
	expect(nextPlan!.attempt?.outcome).toBe("success");
	expect(push).not.toHaveBeenCalled();
	expect(trashApi.requestKeepTrash).not.toHaveBeenCalled();
	expect(fixture.vault.trash).not.toHaveBeenCalled();
	expect(fixture.vault.adapter.write.mock.calls.some(([writtenPath]) => ["Keep/a.md", "Keep/b.md", path].includes(writtenPath))).toBe(false);
	expect(fixture.stored.get(path)).toBe(content);
	expect(fixture.stored.has("Keep/a.md")).toBe(false);
	expect(fixture.stored.has("Keep/b.md")).toBe(false);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("a"), keepUrl("b")]);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(conflict ? checkpoint : completionDate);
	expect(success).toHaveBeenCalledTimes(conflict ? 0 : 1);
});

it("does not advance a two-way checkpoint after partial trash failure", async () => {
	const { prepared } = await prepareTwoWay();
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	const success = jest.fn();
	const { nextPlan } = await runPreparedSyncPlan(fixture.plugin, prepared, String, success);
	jest.mocked(trashApi.requestKeepTrash).mockImplementation(async (_email, _token, notes, apply) => notes.map((note) => ({
		keep_url: note.keep_url, status: apply && note.keep_url === keepUrl("b") ? "failed" : apply ? "trashed" : "ready",
	})));
	await expect(runPreparedSyncPlan(fixture.plugin, nextPlan!, String, success)).resolves.toEqual({ failed: true });
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	expect(success).not.toHaveBeenCalled();
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("b")]);
});

it("shows a late remote conflict and retains the original checkpoint", async () => {
	const { prepared } = await prepareTwoWay();
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	const success = jest.fn();
	const { nextPlan } = await runPreparedSyncPlan(fixture.plugin, prepared, String, success);
	jest.mocked(trashApi.requestKeepTrash).mockImplementation(async (_email, _token, notes) => notes.map((note) => ({ keep_url: note.keep_url, status: "conflict" })));
	const settled = jest.fn();
	await expect(runPreparedSyncPlan(fixture.plugin, nextPlan!, String, success, { onEntrySettled: settled })).resolves.toEqual({ failed: true });
	expect(settled).toHaveBeenCalledWith(nextPlan!.plan.entries[0].id, false, "skipped-conflict");
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	expect((await fixture.ledger.records())).toHaveLength(2);
	expect(success).not.toHaveBeenCalled();
});

it("stops automatic download instead of recreating offline folder removals", async () => {
	await fixture.download("a"); fixture.remove("Keep/a.md");
	const download = jest.spyOn(imports, "importGoogleKeepNotes").mockResolvedValue(1);
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	await runImportNotesFlow(fixture.plugin, true, String);
	expect(download).not.toHaveBeenCalled();
	expect(trashApi.requestKeepTrash).not.toHaveBeenCalled();
	expect(fixture.stored.has("Keep/a.md")).toBe(false);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
});

it("rejects a prepared download after a folder change and return", async () => {
	const { prepared, save } = await prepareTwoWay();
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	fixture.plugin.settings.saveLocation = "Other"; await fixture.ledger.refreshContext();
	fixture.plugin.settings.saveLocation = "Keep"; await fixture.ledger.refreshContext();
	await expect(runPreparedSyncPlan(fixture.plugin, prepared, String, jest.fn())).resolves.toEqual({ failed: true });
	expect(save).not.toHaveBeenCalled();
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	expect(jest.mocked(trashApi.requestKeepTrash).mock.calls.filter((call) => call[3])).toEqual([]);
});

it("enrolls only the selected download with 124 unchecked actionable rows", async () => {
	const ids = Array.from({ length: 125 }, (_, index) => `fixture-${index}`);
	const entries = ids.map((id, index) => createSyncPlanEntryFixture("create", "Create", {
		id: `import:${index}`, path: `Keep/${id}.md`, selected: index === 0,
	}));
	jest.spyOn(imports, "buildImportSyncPlan").mockResolvedValue({
		plan: createPreparedSyncPlanFixture("import", "import", entries).plan,
		notes: ids.map((id) => ({ title: id, text: noteText(id), remote_revision: REVISION })),
		noteEntryIds: entries.map((entry) => entry.id), completionDate,
	});
	const prepared = (await buildManualSyncPlan(fixture.plugin, "import"))!;
	await expect(runPreparedSyncPlan(fixture.plugin, prepared, String, jest.fn())).resolves.toEqual({});
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl(ids[0])]);
	expect(fixture.stored.has(`Keep/${ids[1]}.md`)).toBe(false);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(completionDate);
});

it.each(["plain", "managed-image"] as const)("enrolls an identical-only completed download review without rewriting the note (%s)", async (kind) => {
	const path = "Keep/a.md";
	fixture.put(path, noteText("a") + (kind === "managed-image" ? "\n\n![[media/image.png]]" : ""));
	const entry = createSyncPlanEntryFixture("skipped-identical", "Already up to date", {
		id: "import:0", path, selectable: false, selected: false,
	});
	jest.spyOn(imports, "buildImportSyncPlan").mockResolvedValue({
		plan: createPreparedSyncPlanFixture("import", "import", [entry]).plan,
		notes: [{ title: "a", text: noteText("a"), remote_revision: REVISION }],
		noteEntryIds: [entry.id], completionDate,
	});
	const before = fixture.stored.get(path);
	const prepared = (await buildManualSyncPlan(fixture.plugin, "import"))!;
	expect(await fixture.ledger.records()).toEqual([]);
	await expect(runPreparedSyncPlan(fixture.plugin, prepared, String, jest.fn())).resolves.toEqual({});
	expect(await fixture.ledger.records()).toEqual([
		expect.objectContaining({ keepUrl: keepUrl("a"), path, revision: REVISION, baseline: "synced" }),
	]);
	expect(fixture.stored.get(path)).toBe(before);
	expect(fixture.vault.adapter.write.mock.calls.some(([writtenPath]) => writtenPath === path)).toBe(false);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(completionDate);
});

it.each(["missing-version", "duplicate-identity", "mixed"] as const)("reports incomplete %s receipts without advancing the checkpoint", async (scenario) => {
	const ids = scenario === "mixed" ? ["valid", "missing", "duplicate"] : [scenario === "missing-version" ? "missing" : "duplicate"];
	const entries = ids.map((id, index) => {
		fixture.put(`Keep/${id}.md`, noteText(id));
		return createSyncPlanEntryFixture("skipped-identical", "Already up to date", {
			id: `import:${index}`, path: `Keep/${id}.md`, selectable: false, selected: false,
		});
	});
	if (ids.includes("duplicate")) fixture.put("Keep/copy.md", noteText("duplicate"));
	jest.spyOn(imports, "buildImportSyncPlan").mockResolvedValue({
		plan: createPreparedSyncPlanFixture("import", "import", entries).plan,
		notes: ids.map((id) => ({ title: id, text: noteText(id), remote_revision: id === "missing" ? undefined : REVISION })),
		noteEntryIds: entries.map((entry) => entry.id), completionDate,
	});
	const finish = jest.spyOn(fixture.ledger, "finishReceipts");
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	jest.mocked(Notice).mockClear();
	const prepared = (await buildManualSyncPlan(fixture.plugin, "import"))!;
	await expect(runPreparedSyncPlan(fixture.plugin, prepared, String, jest.fn())).resolves.toEqual({});
	await expect(finish.mock.results[0].value).resolves.toBe(false);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual(scenario === "mixed" ? [keepUrl("valid")] : []);
	expect(Notice).toHaveBeenCalledWith(expect.stringContaining("tracking is incomplete"));
	expect(Notice).toHaveBeenCalledWith(expect.stringContaining("Confirmed notes remain tracked. The last successful sync checkpoint has not advanced."));
	if (ids.includes("missing")) expect(Notice).toHaveBeenCalledWith(expect.stringContaining("missing Google Keep version (1)"));
	if (ids.includes("duplicate")) expect(Notice).toHaveBeenCalledWith(expect.stringContaining("missing or duplicate folder identity (1)"));
});

it.each(["body", "body-preserved-time", "identity", "removed"] as const)("rejects a stale identical review (%s)", async (change) => {
	const path = "Keep/a.md";
	fixture.put(path, noteText("a"));
	const response = { notes: [{ title: "a", text: noteText("a"), remote_revision: REVISION,
		updated: change === "body-preserved-time" ? "2026-08-01T00:00:00.000Z" : undefined }], total_notes: 1 };
	jest.spyOn(downloadApi, "getReplayEpoch").mockResolvedValue(undefined);
	jest.spyOn(downloadApi, "fetchNotes").mockResolvedValueOnce(response).mockResolvedValue({ notes: [] });
	jest.spyOn(downloadApi, "fetchNotesWithPremiumFeatures").mockResolvedValueOnce(response).mockResolvedValue({ notes: [] });
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	const prepared = (await buildManualSyncPlan(fixture.plugin, "import"))!;
	expect(prepared.plan.entries).toEqual([expect.objectContaining({ action: "skipped-identical", selectable: false })]);
	const priorMtime = (await fixture.vault.adapter.stat(path))?.mtime;
	if (change === "removed") fixture.remove(path);
	else fixture.put(path, change === "body" || change === "body-preserved-time" ? noteText("a") + "\nLocal edit" : noteText("different-identity"));
	if (change === "body-preserved-time") expect((await fixture.vault.adapter.stat(path))?.mtime).toBe(priorMtime);
	const editedContent = fixture.stored.get(path);
	jest.mocked(Notice).mockClear();
	fixture.vault.adapter.write.mockClear();
	await expect(runPreparedSyncPlan(fixture.plugin, prepared, String, jest.fn())).resolves.toEqual({ failed: true });
	expect(await fixture.ledger.records()).toEqual([]);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	expect(fixture.stored.get(path)).toBe(editedContent);
	expect(fixture.vault.adapter.write.mock.calls.some(([writtenPath]) => writtenPath === path)).toBe(false);
	expect(Notice).toHaveBeenCalledWith(expect.stringContaining("Refresh the download review before completing it"));
});
