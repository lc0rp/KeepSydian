import type KeepSidianPlugin from "@app/main";
import { buildManualSyncPlan, runPreparedSyncPlan } from "@app/main-sync-flows";
import { createMockPlugin, type MockVaultAdapter } from "@test-utils/mocks/plugin";
import { DEFAULT_SETTINGS } from "../../../types/keepsidian-plugin-settings";
import type { PreNormalizedNote } from "../domain/note";
import { normalizeNote } from "../domain/note";
import { getArchivedNoteUpdate } from "../domain/archive";
import { collectNotesToPush } from "../push/collectNotes";
import { importSelectedGoogleKeepNotes } from "../sync";
import * as api from "@integrations/server/keepApi";
import * as merge from "../domain/merge";

jest.mock("@app/sync-ui");

const ID = "archive-fixture.123";
const URL = `https://keep.google.com/#NOTE/${ID}`;
const ACCOUNT_URL = `https://keep.google.com/u/0/#NOTE/${ID}`;
const PATH = "Keep/Archive fixture.md";
const RENAMED = "Keep/Renamed fixture.md";
const LAST_SYNC = "2024-01-02T00:00:00.000Z";
const ORIGINAL_MTIME = Date.parse("2024-01-01T12:00:00.000Z");
const BODY = "# Archive fixture\n\nKeep this body.";
const ORIGINAL = [
	"---",
	`GoogleKeepUrl: ${ACCOUNT_URL}`,
	"GoogleKeepArchived: false",
	"GoogleKeepUpdatedDate: 2024-01-01T00:00:00.000Z",
	`KeepSidianLastSyncedDate: ${LAST_SYNC}`,
	"custom: preserve-me",
	"---",
	BODY,
].join("\n");
const ARCHIVED = ORIGINAL.replace("GoogleKeepArchived: false", "GoogleKeepArchived: true");
const remote = (overrides: Partial<PreNormalizedNote> = {}): PreNormalizedNote => ({
	id: ID,
	title: "Archive fixture",
	archived: true,
	updated: "2024-01-04T00:00:00.000Z",
	text: `---\nGoogleKeepUrl: ${ACCOUNT_URL}\n---\n${BODY}`,
	...overrides,
});

describe("archive Keep identity variants", () => {
	it.each([URL, ACCOUNT_URL, `https://keep.google.com/u/3/#NOTE/${ID}`])(
		"matches an ID-only response to %s",
		(url) => {
			const existing = ORIGINAL.replace(ACCOUNT_URL, url);
			expect(getArchivedNoteUpdate(remote({ text: BODY }), existing, "all")).toBe(
				existing.replace("GoogleKeepArchived: false", "GoogleKeepArchived: true")
			);
		}
	);

	it("matches rendered URLs across account prefixes", () => {
		expect(getArchivedNoteUpdate(remote({ text: `---\nGoogleKeepUrl: ${URL}\n---\n${BODY}` }), ORIGINAL, "all")).toBe(
			ARCHIVED
		);
	});

	it("provides the ID-only identity to lookup and future downloads", () => {
		const normalized = normalizeNote(remote({ text: BODY }));
		expect(normalized.frontmatterDict.GoogleKeepUrl).toBe(URL);
		expect(normalized.frontmatter).toContain(`GoogleKeepUrl: ${URL}`);
		expect(normalized.textWithoutFrontmatter).toBe(BODY);
	});

	it("does not collapse different IDs or unrelated hosts", () => {
		expect(getArchivedNoteUpdate(remote({ text: BODY, id: `${ID}-other` }), ORIGINAL, "all")).toBeUndefined();
		const unrelatedHost = ORIGINAL.replace("https://keep.google.com", "https://example.com");
		expect(getArchivedNoteUpdate(remote({ text: BODY }), unrelatedHost, "all")).toBeUndefined();
	});

	it("does not inject malformed ID values into YAML", () => {
		const normalized = normalizeNote(remote({ text: BODY, id: "bad\nGoogleKeepArchived: true" }));
		expect(normalized.frontmatterDict.GoogleKeepUrl).toBeUndefined();
		expect(normalized.frontmatter).toBe("");
	});
});

describe("archive writes and subsequent upload planning", () => {
	let plugin: KeepSidianPlugin;
	let adapter: MockVaultAdapter;
	let files: Map<string, string>;
	let times: Map<string, { ctime: number; mtime: number }>;

	beforeEach(() => {
		jest.restoreAllMocks();
		files = new Map([[PATH, ORIGINAL]]);
		times = new Map([[PATH, { ctime: ORIGINAL_MTIME, mtime: ORIGINAL_MTIME }]]);
		const folders = new Set(["Keep"]);
		const mock = createMockPlugin();
		adapter = mock.app.vault.adapter;
		adapter.exists.mockImplementation(async (path) => files.has(path) || folders.has(path));
		adapter.read.mockImplementation(async (path) => {
			const content = files.get(path);
			if (content === undefined) throw new Error("Missing test fixture");
			return content;
		});
		// Model the real adapter: an ordinary write changes mtime unless explicit write options preserve it.
		adapter.write.mockImplementation(async (path, content, options?: { ctime?: number; mtime?: number }) => {
			files.set(path, content);
			times.set(path, {
				ctime: options?.ctime ?? times.get(path)?.ctime ?? Date.now(),
				mtime: options?.mtime ?? Date.now(),
			});
		});
		adapter.stat.mockImplementation(async (path) => times.get(path) ?? null);
		adapter.list.mockImplementation(async (path) => ({
			files: [...files.keys()].filter((file) => file.slice(0, file.lastIndexOf("/")) === path),
			folders: [],
		}));
		mock.app.vault.createFolder.mockImplementation(async (path) => {
			folders.add(path);
		});
		plugin = Object.assign(mock, {
			settings: {
				...DEFAULT_SETTINGS,
				email: "archive-fixture@example.com",
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
		jest.spyOn(api, "fetchNotesWithPremiumFeatures").mockResolvedValueOnce({ notes: [remote()] }).mockResolvedValue({ notes: [] });
	});

	const run = (plan: NonNullable<Awaited<ReturnType<typeof buildManualSyncPlan>>>) =>
		runPreparedSyncPlan(plugin, plan, () => "unused", () => undefined);

	it.each(["archived-only", "all"] as const)("does not create an upload after an archive-only %s download", async (status) => {
		plugin.settings.premiumFeatures.archivedStatus = status;
		const plan = await buildManualSyncPlan(plugin, "two-way");
		expect(plan?.plan.entries[0].label).toBe("Archive");
		const result = await run(plan!);
		expect(files.get(PATH)).toBe(ARCHIVED);
		expect(times.get(PATH)?.mtime).toBe(ORIGINAL_MTIME);
		expect(result.nextPlan?.stage).toBe("upload");
		expect(result.nextPlan?.plan.entries.filter((entry) => entry.selectable)).toHaveLength(0);
		expect((await collectNotesToPush(plugin)).notesToPush).toHaveLength(0);
	});

	it("finds an account-qualified renamed file from an ID-only response", async () => {
		files.delete(PATH);
		files.set(RENAMED, ORIGINAL);
		times.set(RENAMED, { ctime: ORIGINAL_MTIME, mtime: ORIGINAL_MTIME });
		jest.mocked(api.fetchNotesWithPremiumFeatures).mockReset().mockResolvedValueOnce({ notes: [remote({ text: BODY })] }).mockResolvedValue({ notes: [] });
		const plan = await buildManualSyncPlan(plugin, "import");
		expect(plan?.plan.entries[0]).toMatchObject({ path: RENAMED, label: "Archive", selectable: true });
		expect(await run(plan!)).toEqual({});
		expect(files.get(RENAMED)).toBe(ARCHIVED);
		expect(files.has(PATH)).toBe(false);
	});

	it("prefers the matching Keep identity over another note at the expected filename", async () => {
		const unrelated = ORIGINAL.replace(ACCOUNT_URL, `${ACCOUNT_URL}-other`);
		files.set(PATH, unrelated);
		files.set(RENAMED, ORIGINAL);
		times.set(RENAMED, { ctime: ORIGINAL_MTIME, mtime: ORIGINAL_MTIME });
		const plan = await buildManualSyncPlan(plugin, "import");
		expect(plan?.plan.entries[0]).toMatchObject({ path: RENAMED, label: "Archive" });
		expect(await run(plan!)).toEqual({});
		expect(files.get(PATH)).toBe(unrelated);
		expect(files.get(RENAMED)).toBe(ARCHIVED);
	});

	it("keeps unsynced local edits eligible for upload when archiving a conflicted original", async () => {
		const local = ORIGINAL.replace("Keep this body.", "Unsynced local edit.");
		const localMtime = Date.parse("2024-01-03T00:00:00.000Z");
		files.set(PATH, local);
		times.set(PATH, { ctime: ORIGINAL_MTIME, mtime: localMtime });
		jest.spyOn(merge, "mergeNoteText").mockReturnValue({ mergedText: "conflicting content", hasConflict: true });
		await importSelectedGoogleKeepNotes(plugin, [remote()], { archivedStatus: "all" });
		expect(files.get(PATH)).toBe(local.replace("GoogleKeepArchived: false", "GoogleKeepArchived: true"));
		expect(times.get(PATH)?.mtime).toBe(localMtime);
		const upload = await collectNotesToPush(plugin);
		expect(upload.notesToPush).toHaveLength(1);
		expect(upload.notesToPush[0]).toMatchObject({ fullPath: PATH, modifiedSinceLastSync: true });
		expect(upload.notesToPush[0].body).toContain("Unsynced local edit.");
	});

	it("still detects edits made after archive reconciliation", async () => {
		await importSelectedGoogleKeepNotes(plugin, [remote()], { archivedStatus: "all" });
		expect((await collectNotesToPush(plugin)).notesToPush).toHaveLength(0);
		await adapter.write(PATH, ARCHIVED.replace("Keep this body.", "Later local edit."));
		const upload = await collectNotesToPush(plugin);
		expect(upload.notesToPush).toHaveLength(1);
		expect(upload.notesToPush[0].body).toContain("Later local edit.");
	});

	it("fails without mutating the note or checkpoint when its timestamp cannot be preserved", async () => {
		times.delete(PATH);
		await expect(
			importSelectedGoogleKeepNotes(plugin, [remote()], { archivedStatus: "all" }, "2024-02-01T00:00:00.000Z")
		).rejects.toThrow();
		expect(files.get(PATH)).toBe(ORIGINAL);
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(LAST_SYNC);
	});
});
