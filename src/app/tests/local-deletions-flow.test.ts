jest.mock("obsidian");
jest.mock("@app/sync-ui");

import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import { buildManualSyncPlan, runPreparedSyncPlan, runImportNotesFlow } from "@app/main-sync-flows";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";
import * as imports from "@features/keep/sync";
import * as collector from "@features/keep/push/collectNotes";
import * as trashApi from "@integrations/server/keepTrash";
import * as inboundApi from "@integrations/server/keepDeletions";
import { deletionFixture, keepUrl, noteText } from "@features/keep/local-deletions/tests/support";

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
	await fixture.trash("a");
	await fixture.trash("b");
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

it("manual Push counts individual deletions and honors an unchecked row", async () => {
	await fixture.download("a", "b");
	await fixture.trash("a"); await fixture.trash("b");
	const prepared = (await buildManualSyncPlan(fixture.plugin, "push"))!;
	expect(prepared.plan).toMatchObject({ counts: { "Delete from Google Keep": 2 }, actionableCount: 2, selectedCount: 2 });
	prepared.plan.entries.find((entry) => entry.path === "Keep/b.md")!.selected = false;
	const settled = jest.fn();
	await expect(runPreparedSyncPlan(fixture.plugin, prepared, String, jest.fn(), { onEntrySettled: settled })).resolves.toEqual({});
	const applications = jest.mocked(trashApi.requestKeepTrash).mock.calls.filter((call) => call[3] === true);
	expect(applications).toHaveLength(1);
	expect(applications[0][2]).toEqual([expect.objectContaining({ keep_url: keepUrl("a") })]);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("b")]);
	expect(settled).toHaveBeenCalledWith(prepared.plan.entries[0].id, true, "delete");
});

it("protects local removals before two-way download and presents them in upload review", async () => {
	const { prepared, save } = await prepareTwoWay();
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	expect(prepared.plan.entries.every((entry) => !entry.selectable && entry.label === "Preserved local removal")).toBe(true);
	const success = jest.fn();
	const result = await runPreparedSyncPlan(fixture.plugin, prepared, String, success);
	expect(result.nextPlan?.plan).toMatchObject({ stage: "upload", counts: { "Delete from Google Keep": 2 } });
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

it("stops an automatic download rather than recreating an unchecked local removal", async () => {
	await fixture.download("a"); await fixture.trash("a");
	const download = jest.spyOn(imports, "importGoogleKeepNotes").mockResolvedValue(1);
	const checkpoint = fixture.plugin.settings.keepSidianLastSuccessfulSyncDate;
	await runImportNotesFlow(fixture.plugin, true, String);
	expect(download).not.toHaveBeenCalled();
	expect(trashApi.requestKeepTrash).not.toHaveBeenCalled();
	expect(fixture.stored.has("Keep/a.md")).toBe(false);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
});
