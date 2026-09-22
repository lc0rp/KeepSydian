import type KeepSidianPlugin from "@app/main";
import { buildManualSyncPlan, runPreparedSyncPlan } from "@app/main-sync-flows";
import { SyncCancellationError } from "@app/sync-cancel";
import { createMockPlugin, type MockVaultAdapter } from "@test-utils/mocks/plugin";
import { DEFAULT_SETTINGS } from "../../../types/keepsidian-plugin-settings";
import type { KeepArchivedStatus } from "../../../types/subscription";
import type { PreNormalizedNote } from "../domain/note";
import { getArchivedNoteUpdate, getDownloadFrontmatter } from "../domain/archive";
import { buildImportSyncPlan, importGoogleKeepNotes, importGoogleKeepNotesWithOptions, importSelectedGoogleKeepNotes } from "../sync";
import * as api from "@integrations/server/keepApi";
import * as merge from "../domain/merge";

jest.mock("@app/sync-ui");

const KEEP_URL = "https://keep.google.com/#NOTE/archive-fixture";
const NOTE_PATH = "Keep/Archive fixture.md";
const LAST_SYNC = "2024-01-02T00:00:00.000Z";
const ORIGINAL = [
	"---",
	`GoogleKeepUrl: ${KEEP_URL}`,
	"GoogleKeepArchived: false",
	"GoogleKeepUpdatedDate: 2024-01-01T00:00:00.000Z",
	`KeepSidianLastSyncedDate: ${LAST_SYNC}`,
	"tags: [personal, keep]",
	"custom: preserve-me",
	"---",
	"",
	"# Archive fixture",
	"",
	"Keep this body.  ",
	"",
].join("\n");
const ARCHIVED = ORIGINAL.replace("GoogleKeepArchived: false", "GoogleKeepArchived: true");
const remoteNote = (overrides: Partial<PreNormalizedNote> = {}): PreNormalizedNote => ({
	id: "archive-fixture",
	title: "Archive fixture",
	archived: true,
	updated: "2024-01-04T00:00:00.000Z",
	text: `---\nGoogleKeepUrl: ${KEEP_URL}\n---\n# Archive fixture\n\nKeep this body.`,
	...overrides,
});

// These are metadata-only edits: even whitespace and the body-sync timestamp must remain unchanged.
describe("archive metadata reconciliation", () => {
	it.each<KeepArchivedStatus>(["archived-only", "all"])("marks previously synced notes for %s", (status) => {
		expect(getArchivedNoteUpdate(remoteNote(), ORIGINAL, status)).toBe(ARCHIVED);
	});

	it.each<KeepArchivedStatus | undefined>(["active-only", undefined])("does nothing for %s", (status) => {
		expect(getArchivedNoteUpdate(remoteNote(), ORIGINAL, status)).toBeUndefined();
		const note = remoteNote({ text: remoteNote().text?.replace("---\n#", "GoogleKeepArchived: true\n---\n#") });
		expect(getDownloadFrontmatter(note, status)).not.toContain("GoogleKeepArchived");
	});

	it("is idempotent and never unarchives a local note", () => {
		expect(getArchivedNoteUpdate(remoteNote(), ARCHIVED, "all")).toBeUndefined();
		expect(getArchivedNoteUpdate(remoteNote({ archived: false }), ARCHIVED, "all")).toBeUndefined();
	});

	it("does not treat missing archive metadata as an archive", () => {
		expect(getArchivedNoteUpdate(remoteNote({ archived: undefined }), ORIGINAL, "all")).toBeUndefined();
	});

	it("uses rendered archive metadata when the separate flag is missing", () => {
		const note = remoteNote({ archived: undefined, text: ARCHIVED });
		expect(getArchivedNoteUpdate(note, ORIGINAL, "all")).toBe(ARCHIVED);
	});

	it("honors an explicit false over stale rendered archive metadata", () => {
		expect(getArchivedNoteUpdate(remoteNote({ archived: false, text: ARCHIVED }), ORIGINAL, "all")).toBeUndefined();
	});

	it("ignores trashed notes", () => {
		expect(getArchivedNoteUpdate(remoteNote({ trashed: true }), ORIGINAL, "all")).toBeUndefined();
	});

	it("requires the existing Google Keep identity, not just the title", () => {
		expect(getArchivedNoteUpdate(remoteNote(), ORIGINAL.replace(KEEP_URL, `${KEEP_URL}-other`), "all")).toBeUndefined();
		expect(getArchivedNoteUpdate(remoteNote(), "# Archive fixture", "all")).toBeUndefined();
	});

	it("can match an explicit Keep ID when the response has no rendered URL", () => {
		expect(getArchivedNoteUpdate(remoteNote({ text: "body" }), ORIGINAL, "all")).toBe(ARCHIVED);
	});

	it("adds a missing archive property without changing body or unrelated metadata", () => {
		const original = ORIGINAL.replace("GoogleKeepArchived: false\n", "");
		const updated = getArchivedNoteUpdate(remoteNote(), original, "all");
		expect(updated).toBe(original.replace("custom: preserve-me\n---", "custom: preserve-me\nGoogleKeepArchived: true\n---"));
	});

	it("preserves CRLF and legacy property casing without duplicating the archive key", () => {
		const original = ORIGINAL.replace("GoogleKeepArchived", "google-keep-archived").replace(/\n/g, "\r\n");
		expect(getArchivedNoteUpdate(remoteNote(), original, "all")).toBe(ARCHIVED.replace(/\n/g, "\r\n"));
	});

	it("supplies archive frontmatter for a top-level-only flag", () => {
		expect(getDownloadFrontmatter(remoteNote(), "all")).toContain("GoogleKeepArchived: true");
	});
});

describe("archive download planning and execution", () => {
	let plugin: KeepSidianPlugin;
	let files: Map<string, string>;
	let adapter: MockVaultAdapter;

	beforeEach(() => {
		jest.restoreAllMocks();
		files = new Map([[NOTE_PATH, ORIGINAL]]);
		const folders = new Set(["Keep"]);
		const mock = createMockPlugin();
		adapter = mock.app.vault.adapter;
		adapter.exists.mockImplementation(async (path) => files.has(path) || folders.has(path));
		adapter.read.mockImplementation(async (path) => {
			const text = files.get(path);
			if (text === undefined) throw new Error(`Missing fixture: ${path}`);
			return text;
		});
		adapter.write.mockImplementation(async (path, text) => {
			files.set(path, text);
		});
		adapter.list.mockImplementation(async (path) => ({
			files: [...files.keys()].filter((file) => file.slice(0, file.lastIndexOf("/")) === path),
			folders: [],
		}));
		adapter.stat.mockResolvedValue({ ctime: Date.parse("2024-01-01"), mtime: Date.parse("2024-01-01") });
		mock.app.vault.createFolder.mockImplementation(async (path) => {
			folders.add(path);
		});
		plugin = Object.assign(mock, {
			settings: {
				...DEFAULT_SETTINGS,
				email: "archive-test@example.com",
				token: "fixture-token",
				saveLocation: "Keep",
				saveLocationMode: "custom",
				noteFileNamePattern: "{title}",
				keepSidianLastSuccessfulSyncDate: LAST_SYNC,
				frontmatterPascalCaseFixApplied: true,
				embedImportedImages: false,
				premiumFeatures: { ...DEFAULT_SETTINGS.premiumFeatures, archivedStatus: "all" },
			},
			subscriptionService: { isSubscriptionActive: jest.fn().mockResolvedValue(true) },
			processedNotes: 0,
			throwIfSyncCancelled: jest.fn(),
			requireTwoWaySafeguards: jest.fn().mockResolvedValue({ allowed: true }),
			showTwoWaySafeguardNotice: jest.fn(),
		}) as unknown as KeepSidianPlugin;
		jest.spyOn(api, "getReplayEpoch").mockResolvedValue(undefined);
		jest.spyOn(api, "fetchNotesWithPremiumFeatures").mockResolvedValueOnce({ notes: [remoteNote()] }).mockResolvedValue({ notes: [] });
		jest.spyOn(api, "fetchNotes").mockResolvedValueOnce({ notes: [remoteNote()] }).mockResolvedValue({ notes: [] });
	});

	const run = (plan: NonNullable<Awaited<ReturnType<typeof buildManualSyncPlan>>>) =>
		runPreparedSyncPlan(plugin, plan, () => "unused", () => undefined);
	const noteWrites = () => adapter.write.mock.calls.filter(([path]) => path === NOTE_PATH);

	it.each<KeepArchivedStatus>(["archived-only", "all"])("offers and applies an archive-only plan with %s", async (status) => {
		plugin.settings.premiumFeatures.archivedStatus = status;
		const plan = await buildManualSyncPlan(plugin, "import");
		expect(plan?.archivedStatus).toBe(status);
		expect(plan?.plan.entries[0]).toMatchObject({ label: "Archive", selected: true, selectable: true, path: NOTE_PATH });
		expect(plan?.plan.counts.Archive).toBe(1);
		expect(files.get(NOTE_PATH)).toBe(ORIGINAL);
		expect(await run(plan!)).toEqual({});
		expect(files.get(NOTE_PATH)).toBe(ARCHIVED);
		expect(noteWrites()).toHaveLength(1);
	});

	it("keeps the reviewed filter even if settings change before execution", async () => {
		const plan = await buildManualSyncPlan(plugin, "import");
		plugin.settings.premiumFeatures.archivedStatus = "active-only";
		expect(await run(plan!)).toEqual({});
		expect(files.get(NOTE_PATH)).toBe(ARCHIVED);
	});

	it("does not update an unchecked archive entry", async () => {
		const plan = await buildManualSyncPlan(plugin, "import");
		plan!.plan.entries[0].selected = false;
		expect(await run(plan!)).toEqual({});
		expect(files.get(NOTE_PATH)).toBe(ORIGINAL);
		expect(noteWrites()).toHaveLength(0);
	});

	it("leaves identical notes skipped with the active-only filter", async () => {
		plugin.settings.premiumFeatures.archivedStatus = "active-only";
		const plan = await buildManualSyncPlan(plugin, "import");
		expect(plan?.plan.entries[0]).toMatchObject({ action: "skipped-identical", selectable: false });
		expect(await run(plan!)).toEqual({});
		expect(files.get(NOTE_PATH)).toBe(ORIGINAL);
	});

	it("does not use a saved supporter filter for a non-supporter download", async () => {
		jest.spyOn(plugin.subscriptionService, "isSubscriptionActive").mockResolvedValue(false);
		const plan = await buildManualSyncPlan(plugin, "import");
		expect(plan?.archivedStatus).toBe("active-only");
		expect(plan?.plan.entries[0].selectable).toBe(false);
		expect(await run(plan!)).toEqual({});
		expect(files.get(NOTE_PATH)).toBe(ORIGINAL);
	});

	it("finds a renamed existing file by its Keep URL rather than creating another note", async () => {
		const renamed = "Keep/My renamed note.md";
		files.delete(NOTE_PATH);
		files.set(renamed, ORIGINAL);
		const plan = await buildManualSyncPlan(plugin, "import");
		expect(plan?.plan.entries[0]).toMatchObject({ label: "Archive", path: renamed });
		expect(await run(plan!)).toEqual({});
		expect(files.get(renamed)).toBe(ARCHIVED);
		expect(files.has(NOTE_PATH)).toBe(false);
	});

	it("does not offer a second archive update for an already archived note", async () => {
		files.set(NOTE_PATH, ARCHIVED);
		const built = await buildImportSyncPlan(plugin, plugin.settings.premiumFeatures);
		expect(built.plan.entries[0]).toMatchObject({ action: "skipped-identical", selectable: false });
	});

	it("also propagates the selected filter through direct downloads", async () => {
		await importGoogleKeepNotesWithOptions(plugin, plugin.settings.premiumFeatures);
		expect(files.get(NOTE_PATH)).toBe(ARCHIVED);
	});

	it("ignores a stale archive callback on a default download", async () => {
		await importGoogleKeepNotes(plugin, { archivedStatus: "all" });
		expect(files.get(NOTE_PATH)).toBe(ORIGINAL);
	});

	it.each<KeepArchivedStatus>(["active-only", "all"])("gates archive metadata during content overwrites with %s", async (status) => {
		const changed = remoteNote({ text: remoteNote().text?.replace("Keep this body.", "Updated remote body.") });
		await importSelectedGoogleKeepNotes(plugin, [changed], { archivedStatus: status });
		expect(files.get(NOTE_PATH)).toContain("Updated remote body.");
		expect(files.get(NOTE_PATH)).toContain(`GoogleKeepArchived: ${status === "all" ? "true" : "false"}`);
	});

	it("archives the original while preserving local edits when a conflict copy is created", async () => {
		const local = ORIGINAL.replace("Keep this body.", "Unsynced local edit.");
		files.set(NOTE_PATH, local);
		adapter.stat.mockResolvedValue({ ctime: Date.parse("2024-01-01"), mtime: Date.parse("2024-01-03") });
		jest.spyOn(merge, "mergeNoteText").mockReturnValue({ mergedText: "conflicting content", hasConflict: true });
		await importSelectedGoogleKeepNotes(plugin, [remoteNote()], { archivedStatus: "all" });
		expect(files.get(NOTE_PATH)).toBe(local.replace("GoogleKeepArchived: false", "GoogleKeepArchived: true"));
		expect([...files.keys()].some((path) => path.includes("-conflict-"))).toBe(true);
	});

	it("reports write failure and does not advance the successful download checkpoint", async () => {
		adapter.write.mockImplementation(async (path, text) => {
			if (path === NOTE_PATH) throw new Error("Archive write failed");
			files.set(path, text);
		});
		const settled = jest.fn();
		await expect(importSelectedGoogleKeepNotes(plugin, [remoteNote()], { archivedStatus: "all", onEntrySettled: settled }, "2024-02-01T00:00:00.000Z", ["archive-entry"])).rejects.toThrow("Archive write failed");
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(LAST_SYNC);
		expect(settled).toHaveBeenCalledWith("archive-entry", false);
		expect(files.get(NOTE_PATH)).toBe(ORIGINAL);
	});

	it("cancels without changing the note or checkpoint", async () => {
		jest.spyOn(plugin, "throwIfSyncCancelled").mockImplementation(() => { throw new SyncCancellationError(); });
		await expect(importSelectedGoogleKeepNotes(plugin, [remoteNote()], { archivedStatus: "all" }, "2024-02-01T00:00:00.000Z")).rejects.toBeInstanceOf(SyncCancellationError);
		expect(files.get(NOTE_PATH)).toBe(ORIGINAL);
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(LAST_SYNC);
	});
});
