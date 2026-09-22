jest.mock("obsidian");
jest.mock("@app/sync-ui");

import { TFile } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { buildManualSyncPlan, runPreparedSyncPlan, runImportNotesFlow } from "@app/main-sync-flows";
import { DEFAULT_SETTINGS } from "../../types/keepsidian-plugin-settings";
import { createMockPlugin } from "@test-utils/mocks/plugin";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";
import * as imports from "@features/keep/sync";
import * as pushes from "@features/keep/push";
import * as deletionsApi from "@integrations/server/keepDeletions";
import type { NoteForPush } from "@features/keep/push/collectNotes";

const checkpoint = "2026-08-01T00:00:00.000Z";
const completionDate = "2026-09-22T12:00:00.000Z";
const url = "https://keep.google.com/#NOTE/gone";

function setup() {
	const mock = createMockPlugin();
	const stored = new Map<string, string>();
	const folders = new Set<string>();
	mock.app.vault.adapter.exists.mockImplementation(async (path) => stored.has(path) || folders.has(path));
	mock.app.vault.adapter.read.mockImplementation(async (path) => stored.get(path) ?? "");
	mock.app.vault.adapter.write.mockImplementation(async (path, content) => { stored.set(path, content); });
	mock.app.vault.createFolder.mockImplementation(async (path) => { folders.add(path); });
	const file = Object.assign(new TFile("Keep/Gone.md"), { path: "Keep/Gone.md", basename: "Gone", extension: "md" });
	const vault = Object.assign(mock.app.vault, {
		getMarkdownFiles: jest.fn(() => [file]),
		getAbstractFileByPath: jest.fn(() => file),
		read: jest.fn(async () => `---\nGoogleKeepUrl: "${url}"\nKeepSidianLastSyncedDate: "${checkpoint}"\n---\nOriginal`),
		trash: jest.fn(async (_file: TFile, _system: boolean) => undefined),
	});
	const plugin = Object.assign(mock, {
		settings: { ...DEFAULT_SETTINGS, email: "test@example.com", token: "token", saveLocation: "Keep",
			keepSidianLastSuccessfulSyncDate: checkpoint, frontmatterPascalCaseFixApplied: true },
		subscriptionService: { isSubscriptionActive: jest.fn().mockResolvedValue(false) },
		processedNotes: 0,
		throwIfSyncCancelled: jest.fn(),
		requireTwoWaySafeguards: jest.fn().mockResolvedValue({ allowed: true }),
		showTwoWaySafeguardNotice: jest.fn(),
	}) as unknown as KeepSidianPlugin;
	const entries = [
		createSyncPlanEntryFixture("create", "Create", { id: "import:0", path: "Keep/New.md", selectionLocked: true }),
		createSyncPlanEntryFixture("overwrite", "Overwrite", { id: "import:1", path: file.path }),
	];
	const notes = [{ title: "New", text: "new" }, { title: "Gone", text: "stale" }];
	jest.spyOn(imports, "buildImportSyncPlan").mockResolvedValue({
		plan: createPreparedSyncPlanFixture("import", "import", entries).plan,
		notes, noteEntryIds: entries.map((entry) => entry.id), completionDate,
	});
	const importSelected = jest.spyOn(imports, "importSelectedGoogleKeepNotes").mockResolvedValue(1);
	const fetchDeleted = jest.spyOn(deletionsApi, "fetchDeletedKeepUrls").mockResolvedValue(new Set([url]));
	return { plugin, vault, notes, importSelected, fetchDeleted };
}

beforeEach(() => jest.restoreAllMocks());

it("counts a deletion, suppresses its stale import, and respects non-supporter deselection", async () => {
	const { plugin, vault, notes, importSelected, fetchDeleted } = setup();
	const prepared = (await buildManualSyncPlan(plugin, "import"))!;
	expect(prepared.plan).toMatchObject({ selectedCount: 2, actionableCount: 2,
		counts: { Create: 1, "Delete from Obsidian": 1 } });
	expect(prepared.plan.entries.map((entry) => entry.action)).toEqual(["create", "delete"]);
	expect(prepared.plan.entries[1].selectionLocked).toBe(false);
	expect(vault.trash).not.toHaveBeenCalled();
	expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	prepared.plan.entries[1].selected = false;
	await expect(runPreparedSyncPlan(plugin, prepared, String, jest.fn())).resolves.toEqual({});
	expect(vault.trash).not.toHaveBeenCalled();
	expect(fetchDeleted).toHaveBeenCalledTimes(1);
	expect(importSelected).toHaveBeenCalledWith(plugin, [notes[0]], expect.any(Object), undefined, ["import:0"]);
	expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(completionDate);
});

it("executes a reviewed deletion with the right ID, without importing its stale snapshot", async () => {
	const { plugin, vault, notes, importSelected } = setup();
	const prepared = (await buildManualSyncPlan(plugin, "import"))!;
	const onEntrySettled = jest.fn();
	await runPreparedSyncPlan(plugin, prepared, String, jest.fn(), { onEntrySettled });
	expect(vault.trash).toHaveBeenCalledWith(expect.objectContaining({ path: "Keep/Gone.md" }), false);
	expect(onEntrySettled).toHaveBeenCalledWith("delete:Keep/Gone.md", true);
	expect(importSelected).toHaveBeenCalledWith(plugin, [notes[0]], expect.any(Object), undefined, ["import:0"]);
});

it("retains the checkpoint and performs no writes when remote deletion revalidation fails", async () => {
	const { plugin, vault, importSelected, fetchDeleted } = setup();
	const prepared = (await buildManualSyncPlan(plugin, "import"))!;
	fetchDeleted.mockResolvedValue(new Set());
	await expect(runPreparedSyncPlan(plugin, prepared, String, jest.fn())).resolves.toEqual({ failed: true });
	expect(vault.trash).not.toHaveBeenCalled();
	expect(importSelected).not.toHaveBeenCalled();
	expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
});

it("does not check or delete notes during scheduled unreviewed downloads", async () => {
	const { plugin, vault, fetchDeleted } = setup();
	jest.spyOn(imports, "importGoogleKeepNotes").mockResolvedValue(undefined);
	await runImportNotesFlow(plugin, true, String);
	expect(fetchDeleted).not.toHaveBeenCalled();
	expect(vault.trash).not.toHaveBeenCalled();
});

it("preserves opt-outs and upload indices through both halves of a two-way run", async () => {
	const { plugin } = setup();
	const prepared = (await buildManualSyncPlan(plugin, "two-way"))!;
	prepared.plan.entries.find((entry) => entry.action === "delete")!.selected = false;
	const notes: NoteForPush[] = ["Gone", "New"].map((title) => ({
		fullPath: `Keep/${title}.md`, relativePath: `${title}.md`, title,
		content: "body", body: "body", frontmatter: "", lastSyncedDate: null,
		modifiedSinceLastSync: true, attachments: [], updatedAttachmentNames: [], missingAttachments: [],
	}));
	jest.spyOn(pushes, "buildPushSyncPlan").mockResolvedValue({
		plan: createPreparedSyncPlanFixture("push", "upload", notes.map((note, index) =>
			createSyncPlanEntryFixture("upload", "Upload", { id: `upload:${index}:${note.fullPath}`, path: note.fullPath })
		)).plan,
		notesToPush: notes,
	});
	const push = jest.spyOn(pushes, "pushGoogleKeepNotes").mockResolvedValue(undefined);
	const result = await runPreparedSyncPlan(plugin, prepared, String, jest.fn());
	expect(result.nextPlan?.plan.entries.map((entry) => entry.id)).toEqual(["upload:1:Keep/New.md"]);
	expect(result.nextPlan?.deletions).toBe(prepared.deletions);
	expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	await runPreparedSyncPlan(plugin, result.nextPlan!, String, jest.fn());
	expect(push).toHaveBeenCalledWith(plugin, expect.any(Object), [notes[1]]);
	expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(completionDate);
});
