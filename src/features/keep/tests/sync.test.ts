jest.mock("obsidian", () => ({
	requestUrl: jest.fn(),
	normalizePath: jest.fn((path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/")),
	Notice: jest.fn(),
}));
import { requestUrl, RequestUrlResponse, Notice } from "obsidian";
import * as obsidian from "obsidian";
import {
	buildImportSyncPlan,
	importGoogleKeepNotes,
	importGoogleKeepNotesWithOptions,
	convertOptionsToFeatureFlags,
	processAndSaveNotes,
} from "../sync";
import { handleDuplicateNotes } from "../domain/compare";
import KeepSidianPlugin from "main";
import { NoteImportOptions } from "ui/modals/NoteImportOptionsModal";
import * as noteModule from "../domain/note";
import * as compareModule from "../domain/compare";
import * as syncModule from "../sync";
import * as loggingModule from "@app/logging";
import * as pathsModule from "@services/paths";
import * as attachmentsModule from "../../../features/keep/io/attachments";
import { parseResponse } from "../../../integrations/server/keepApi";
import { NetworkError } from "@services/errors";

// Mock the external modules
jest.mock("../domain/compare");
jest.mock("main");

describe("Google Keep Import Functions", () => {
	let mockPlugin: jest.Mocked<KeepSidianPlugin>;
	let getVaultConfigMock: jest.Mock;
	let setVaultConfigMock: jest.Mock;

	beforeEach(() => {
		jest.restoreAllMocks();
		// Reset all mocks before each test
		jest.clearAllMocks();
		(obsidian.normalizePath as jest.Mock).mockImplementation((path: string) =>
			path.replace(/\\/g, "/").replace(/\/+/g, "/")
		);

		getVaultConfigMock = jest.fn().mockReturnValue(undefined);
		setVaultConfigMock = jest.fn();

		// Setup mock plugin
		mockPlugin = {
			settings: {
				email: "test@example.com",
				token: "test-token",
				saveLocation: "Test Folder",
				saveLocationMode: "custom",
				noteFileNamePattern: "{title}",
				keepSidianLastSuccessfulSyncDate: null,
				frontmatterPascalCaseFixApplied: false,
				embedImportedImages: false,
			},
			app: {
				vault: {
					getConfig: getVaultConfigMock,
					setConfig: setVaultConfigMock,
					adapter: {
						exists: jest.fn().mockImplementation(() => Promise.resolve(false)),
						list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
						write: jest.fn(),
						writeBinary: jest.fn(),
						read: jest.fn(),
					},
					createFolder: jest.fn(),
				},
			},
			saveSettings: jest.fn().mockResolvedValue(undefined),
		} as unknown as jest.Mocked<KeepSidianPlugin>;

		// Mock requestUrl default success response
		(requestUrl as jest.Mock).mockResolvedValue({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: () => ({ notes: [] }),
			text: '{"notes": []}',
		} as RequestUrlResponse);
	});

	describe("importGoogleKeepNotes", () => {
		it("should successfully import notes", async () => {
			await expect(importGoogleKeepNotes(mockPlugin)).resolves.toBe(0);
			expect(requestUrl).toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith("Imported Google Keep notes.");
		});

		it("should handle errors during import", async () => {
			(requestUrl as jest.Mock).mockRejectedValue(new Error("Network error"));
			await expect(importGoogleKeepNotes(mockPlugin)).rejects.toThrow("Network error");
			expect(Notice).toHaveBeenCalledWith("Failed to import notes.");
			expect(mockPlugin.settings.keepSidianLastSuccessfulSyncDate).toBeNull();
			expect(setVaultConfigMock).not.toHaveBeenCalled();
		});

		it("uses last successful sync date from settings to filter requests", async () => {
			mockPlugin.settings.keepSidianLastSuccessfulSyncDate = "2024-01-01T00:00:00.000Z";

			await importGoogleKeepNotes(mockPlugin);

			const [[requestParams]] = (requestUrl as jest.Mock).mock.calls;
			expect(requestParams.url).toContain("changed_gt=2024-01-01T00%3A00%3A00.000Z");
			expect(requestParams.url).not.toContain("created_gt=");
			expect(requestParams.url).not.toContain("updated_gt=");
		});

		it("uses vault config when settings sync date is unavailable", async () => {
			mockPlugin.settings.keepSidianLastSuccessfulSyncDate = null;
			getVaultConfigMock.mockReturnValue("2024-02-02T00:00:00.000Z");

			await importGoogleKeepNotes(mockPlugin);

			const [[requestParams]] = (requestUrl as jest.Mock).mock.calls;
			expect(requestParams.url).toContain("changed_gt=2024-02-02T00%3A00%3A00.000Z");
			expect(requestParams.url).not.toContain("created_gt=");
			expect(requestParams.url).not.toContain("updated_gt=");
		});

		it("omits sync date filters for one-off all-notes downloads", async () => {
			mockPlugin.settings.keepSidianLastSuccessfulSyncDate = "2024-01-01T00:00:00.000Z";

			await importGoogleKeepNotes(mockPlugin, undefined, { kind: "all" });

			const [[requestParams]] = (requestUrl as jest.Mock).mock.calls;
			expect(requestParams.url).not.toContain("changed_gt=");
			expect(requestParams.url).not.toContain("created_gt=");
			expect(requestParams.url).not.toContain("updated_gt=");
		});

		it("uses a one-off custom sync date when requested", async () => {
			await importGoogleKeepNotes(mockPlugin, undefined, {
				kind: "custom-since",
				since: "2024-03-15T14:30:00.000Z",
			});

			const [[requestParams]] = (requestUrl as jest.Mock).mock.calls;
			expect(requestParams.url).toContain("changed_gt=2024-03-15T14%3A30%3A00.000Z");
		});

		it("treats last-sync scope as all-notes when there is no saved sync date", async () => {
			mockPlugin.settings.keepSidianLastSuccessfulSyncDate = null;
			getVaultConfigMock.mockReturnValue(undefined);

			await importGoogleKeepNotes(mockPlugin, undefined, { kind: "last-sync" });

			const [[requestParams]] = (requestUrl as jest.Mock).mock.calls;
			expect(requestParams.url).not.toContain("changed_gt=");
		});

		it("persists the last successful sync date after import", async () => {
			jest.useFakeTimers().setSystemTime(new Date("2024-03-03T12:34:56.000Z"));

			try {
				await importGoogleKeepNotes(mockPlugin);

				const expected = "2024-03-03T12:34:56.000Z";
				expect(mockPlugin.settings.keepSidianLastSuccessfulSyncDate).toBe(expected);
				expect(setVaultConfigMock).toHaveBeenCalledWith("KeepSidianLastSuccessfulSyncDate", expected);
			} finally {
				jest.useRealTimers();
			}
		});

		it("uses cursor pagination when next_cursor is returned", async () => {
			(handleDuplicateNotes as jest.Mock).mockResolvedValue("create");
			const setTotalNotes = jest.fn();
			const firstPage = {
				notes: [{ title: "First page note", text: "body-1" }],
				total_notes: 2,
				next_cursor: "cursor-1",
			};
			const secondPage = {
				notes: [{ title: "Second page note", text: "body-2" }],
				total_notes: 2,
			};

			(requestUrl as jest.Mock)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => firstPage,
					text: JSON.stringify(firstPage),
				} as RequestUrlResponse)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => secondPage,
					text: JSON.stringify(secondPage),
				} as RequestUrlResponse);

			await importGoogleKeepNotes(mockPlugin, { setTotalNotes });

			expect(requestUrl).toHaveBeenCalledTimes(2);
			const firstRequest = (requestUrl as jest.Mock).mock.calls[0][0];
			const secondRequest = (requestUrl as jest.Mock).mock.calls[1][0];
			expect(firstRequest.url).toContain("offset=0");
			expect(secondRequest.url).toContain("cursor=cursor-1");
			expect(secondRequest.url).not.toContain("offset=");
			expect(setTotalNotes).toHaveBeenCalledTimes(1);
			expect(setTotalNotes).toHaveBeenCalledWith(2);
		});

		it("uses the larger sync page size for fetches", async () => {
			await importGoogleKeepNotes(mockPlugin);

			const [[requestParams]] = (requestUrl as jest.Mock).mock.calls;
			expect(requestParams.url).toContain("limit=100");
		});

		it("retries after a rate-limited fetch response", async () => {
			jest.useFakeTimers();
			const emptyPage = { notes: [] };

			(requestUrl as jest.Mock)
				.mockRejectedValueOnce(new NetworkError("Too many requests", 429))
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => emptyPage,
					text: JSON.stringify(emptyPage),
				} as RequestUrlResponse);

			try {
				const importPromise = importGoogleKeepNotes(mockPlugin);
				await jest.runOnlyPendingTimersAsync();
				await expect(importPromise).resolves.toBe(0);
				expect(requestUrl).toHaveBeenCalledTimes(2);
			} finally {
				jest.useRealTimers();
			}
		});
	});

	describe("importGoogleKeepNotesWithOptions", () => {
		const mockOptions: NoteImportOptions = {
			includeNotesTerms: ["important"],
			excludeNotesTerms: ["draft"],
			includeColors: [],
			pinnedStatus: "all",
			archivedStatus: "active-only",
			updateTitle: true,
			suggestTags: true,
			maxTags: 3,
			limitToExistingTags: true,
			tagPrefix: "auto-",
		};

		it("should import notes with premium features", async () => {
			await importGoogleKeepNotesWithOptions(mockPlugin, mockOptions);
			expect(requestUrl).toHaveBeenCalledWith(
				expect.objectContaining({
					url: expect.stringContaining("/premium"),
					method: "POST",
				})
			);
		});

		it("should handle errors with premium features", async () => {
			(requestUrl as jest.Mock).mockRejectedValue(new Error("Premium feature error"));
			await expect(importGoogleKeepNotesWithOptions(mockPlugin, mockOptions)).rejects.toThrow("Premium feature error");
			expect(Notice).toHaveBeenCalledWith("Failed to import notes.");
		});
	});

	describe("buildImportSyncPlan", () => {
		it("builds actionable and informational review rows", async () => {
			const response = {
				notes: [
					{ title: "Create note", text: "body-1" },
					{ title: "Skip note", text: "body-2" },
				],
			};
			(requestUrl as jest.Mock)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => response,
					text: JSON.stringify(response),
				} as RequestUrlResponse)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => ({ notes: [] }),
					text: JSON.stringify({ notes: [] }),
				} as RequestUrlResponse);
			(handleDuplicateNotes as jest.Mock).mockResolvedValueOnce("create").mockResolvedValueOnce("skip");

			const builtPlan = await buildImportSyncPlan(mockPlugin);

			expect(builtPlan.plan.entries).toEqual([
				expect.objectContaining({
					label: "Create",
					selectable: true,
					selectionLocked: false,
				}),
				expect.objectContaining({
					label: "Skipped: identical",
					selectable: false,
				}),
			]);
		});

		it("locks actionable review rows for non-supporters", async () => {
			const response = {
				notes: [{ title: "Create note", text: "body-1" }],
			};
			(requestUrl as jest.Mock)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => response,
					text: JSON.stringify(response),
				} as RequestUrlResponse)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => ({ notes: [] }),
					text: JSON.stringify({ notes: [] }),
				} as RequestUrlResponse);
			(handleDuplicateNotes as jest.Mock).mockResolvedValueOnce("overwrite");

			const builtPlan = await buildImportSyncPlan(mockPlugin, undefined, false, "Available to project supporters");

			expect(builtPlan.plan.entries[0]).toEqual(
				expect.objectContaining({
					label: "Overwrite",
					selectionLocked: true,
					selectionLockedReason: "Available to project supporters",
				})
			);
		});

		it("uses a custom download scope when building the review plan", async () => {
			const response = {
				notes: [{ title: "Create note", text: "body-1" }],
			};
			(requestUrl as jest.Mock)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => response,
					text: JSON.stringify(response),
				} as RequestUrlResponse)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => ({ notes: [] }),
					text: JSON.stringify({ notes: [] }),
				} as RequestUrlResponse);
			(handleDuplicateNotes as jest.Mock).mockResolvedValueOnce("create");

			await buildImportSyncPlan(mockPlugin, undefined, true, undefined, undefined, {
				kind: "custom-since",
				since: "2024-04-01T08:45:00.000Z",
			});

			const [[requestParams]] = (requestUrl as jest.Mock).mock.calls;
			expect(requestParams.url).toContain("changed_gt=2024-04-01T08%3A45%3A00.000Z");
		});

		it("scopes duplicate lookup to saveLocation when building the review plan", async () => {
			const response = {
				notes: [{ title: "Create note", text: "body-1" }],
			};
			(mockPlugin.app.vault.adapter.list as jest.Mock).mockImplementation(async (path: string) => {
				if (path === "Test Folder") {
					return { files: [], folders: [] };
				}
				throw new Error(`Unexpected duplicate lookup scope: ${path}`);
			});
			(requestUrl as jest.Mock)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => response,
					text: JSON.stringify(response),
				} as RequestUrlResponse)
				.mockResolvedValueOnce({
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: () => ({ notes: [] }),
					text: JSON.stringify({ notes: [] }),
				} as RequestUrlResponse);
			(handleDuplicateNotes as jest.Mock).mockResolvedValueOnce("create");

			await buildImportSyncPlan(mockPlugin);

			expect(mockPlugin.app.vault.adapter.list).toHaveBeenCalledWith("Test Folder");
		});
	});

	describe("convertOptionsToFeatureFlags", () => {
		it("should convert all options correctly", () => {
			const options: NoteImportOptions = {
				includeNotesTerms: ["term1", "term2"],
				excludeNotesTerms: ["exclude1"],
				includeColors: ["YELLOW", "BLUE"],
				pinnedStatus: "pinned",
				archivedStatus: "all",
				updateTitle: true,
				suggestTags: true,
				maxTags: 10,
				limitToExistingTags: true,
				tagPrefix: "tag-",
			};
			const featureFlags = convertOptionsToFeatureFlags(options);
			expect(featureFlags).toEqual({
				filter_notes: { terms: ["term1", "term2"] },
				skip_notes: { terms: ["exclude1"] },
				keep_state_filter: {
					colors: ["YELLOW", "BLUE"],
					pinned: "pinned",
					archived: "all",
				},
				suggest_title: {},
				suggest_tags: {
					max_tags: 10,
					restrict_tags: true,
					prefix: "tag-",
				},
			});
		});

		it("should handle empty options", () => {
			const options: NoteImportOptions = {};
			const flags = convertOptionsToFeatureFlags(options);
			expect(flags).toEqual({});
		});

		it("should handle partial options", () => {
			const options: NoteImportOptions = {
				updateTitle: true,
			};
			const featureFlags = convertOptionsToFeatureFlags(options);
			expect(featureFlags).toEqual({
				suggest_title: {},
			});
		});

		it("omits keep-state filters when options are at their defaults", () => {
			const options: NoteImportOptions = {
				includeColors: [],
				pinnedStatus: "all",
				archivedStatus: "active-only",
			};

			expect(convertOptionsToFeatureFlags(options)).toEqual({});
		});
	});

	describe("processAndSaveNotes", () => {
		const mockNotes = [
			{
				title: "Test Note",
				textContent: "Test content",
				labels: ["test"],
				color: "WHITE",
				isArchived: false,
				isPinned: false,
				isTrashed: false,
				lastModified: new Date().toISOString(),
			},
		];

		it("should create folders if they don't exist", async () => {
			await processAndSaveNotes(mockPlugin, mockNotes);

			expect(mockPlugin.app.vault.adapter.exists).toHaveBeenCalledWith("Test Folder");
			expect(mockPlugin.app.vault.adapter.exists).toHaveBeenCalledWith("Test Folder/media");
			// saveLocation and media folder; logging may also ensure parent exists
			const createFolderMock = mockPlugin.app.vault.createFolder as unknown as jest.Mock<Promise<void>, [string]>;
			expect(createFolderMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		});

		it("should process each note", async () => {
			(handleDuplicateNotes as jest.Mock).mockResolvedValue("create");

			await processAndSaveNotes(mockPlugin, mockNotes);

			expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalled();
		});

		it("reuses ensured parent folders during note writes instead of re-checking them", async () => {
			jest.spyOn(loggingModule, "logSync").mockResolvedValue(undefined);
			jest.spyOn(loggingModule, "flushLogSync").mockResolvedValue(undefined);
			const ensureFolderSpy = jest.spyOn(pathsModule, "ensureFolder");

			await processAndSaveNotes(mockPlugin, mockNotes);

			expect(ensureFolderSpy).toHaveBeenCalledTimes(2);
			expect(ensureFolderSpy.mock.calls.map(([, path]) => path)).toEqual(["Test Folder", "Test Folder/media"]);
		});

		it("reuses ensured media folders for attachment notes", async () => {
			const noteWithAttachment = [
				{
					...mockNotes[0],
					blob_urls: ["https://example.com/blob-1"],
				},
			];
			jest.spyOn(loggingModule, "logSync").mockResolvedValue(undefined);
			jest.spyOn(loggingModule, "flushLogSync").mockResolvedValue(undefined);
			jest.spyOn(attachmentsModule, "processAttachments").mockResolvedValue({
				downloaded: 1,
				skippedIdentical: 0,
				totalDurationMs: 0,
				fetchDurationMs: 0,
				compareDurationMs: 0,
				writeDurationMs: 0,
				fileNames: ["blob-1.png"],
			});
			const ensureFolderSpy = jest.spyOn(pathsModule, "ensureFolder");

			await processAndSaveNotes(mockPlugin, noteWithAttachment);

			expect(ensureFolderSpy).toHaveBeenCalledTimes(2);
			expect(ensureFolderSpy.mock.calls.map(([, path]) => path)).toEqual(["Test Folder", "Test Folder/media"]);
		});
	});

	describe("processAndSaveNote", () => {
		const note: noteModule.PreNormalizedNote = {
			title: "Note 1",
			text: "Content 1",
			frontmatterDict: {},
		};
		const normalizedNote: noteModule.NormalizedNote = {
			title: "Note 1",
			text: "Content 1",
			frontmatterDict: {},
			created: null,
			updated: null,
			color: null,
			pinned: false,
			frontmatter: "",
			archived: false,
			trashed: false,
			labels: [],
			blobs: [],
			blob_urls: [],
			blob_names: [],
			media: [],
			header: "",
			textWithoutFrontmatter: "Content 1",
		};

		it("should skip notes without a title", async () => {
			const normalizedWithoutTitle: noteModule.NormalizedNote = {
				...normalizedNote,
				title: "",
				text: "",
			};
			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(normalizedWithoutTitle);
			const logSpy = jest.spyOn(loggingModule, "logSync").mockResolvedValue(undefined);

			await syncModule.processAndSaveNote(mockPlugin, note, mockPlugin.settings.saveLocation);

			expect(compareModule.handleDuplicateNotes).not.toHaveBeenCalled();
			expect(mockPlugin.app.vault.adapter.write).not.toHaveBeenCalled();
			expect(logSpy).toHaveBeenCalledWith(
				mockPlugin,
				"Skipped note without a title",
				expect.objectContaining({
					batchKey: "sync:notes",
					batchSize: 50,
				})
			);
			logSpy.mockRestore();
		});

		it("should process and save note without duplicates or attachments", async () => {
			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(normalizedNote);
			jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("create");
			jest.spyOn(mockPlugin.app.vault.adapter, "write").mockResolvedValue(undefined);
			jest.spyOn(Date.prototype, "toISOString").mockReturnValue("2023-01-01T00:00:00.000Z");
			jest.spyOn(obsidian, "normalizePath").mockReturnValue(`${mockPlugin.settings.saveLocation}/${note.title}.md`);
			const ensureParentSpy = jest.spyOn(pathsModule, "ensureParentFolderForFile").mockResolvedValue(undefined);
			await syncModule.processAndSaveNote(mockPlugin, note, mockPlugin.settings.saveLocation);

			expect(noteModule.normalizeNote).toHaveBeenCalledWith(note);
			expect(compareModule.handleDuplicateNotes).toHaveBeenCalledWith(
				mockPlugin.settings.saveLocation,
				normalizedNote,
				mockPlugin.app,
				`${mockPlugin.settings.saveLocation}/${note.title}.md`,
				undefined
			);
			expect(mockPlugin.app.vault.adapter.read).not.toHaveBeenCalled();
			expect(ensureParentSpy).toHaveBeenCalledWith(
				mockPlugin.app,
				`${mockPlugin.settings.saveLocation}/${note.title}.md`
			);
			expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledWith(
				`${mockPlugin.settings.saveLocation}/${note.title}.md`,
				expect.any(String)
			);
			ensureParentSpy.mockRestore();
		});

		it("fast-paths create when the scoped index shows no matching file", async () => {
			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(normalizedNote);
			const duplicateSpy = jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("create");
			const ensureParentSpy = jest.spyOn(pathsModule, "ensureParentFolderForFile").mockResolvedValue(undefined);

			await syncModule.processAndSaveNote(mockPlugin, note, mockPlugin.settings.saveLocation, normalizedNote, {
				existingPaths: new Set(),
				pathByKeepUrl: new Map(),
			});

			expect(duplicateSpy).not.toHaveBeenCalled();
			expect(mockPlugin.app.vault.adapter.exists).not.toHaveBeenCalled();
			expect(ensureParentSpy).toHaveBeenCalledWith(
				mockPlugin.app,
				`${mockPlugin.settings.saveLocation}/${note.title}.md`
			);
			expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledWith(
				`${mockPlugin.settings.saveLocation}/${note.title}.md`,
				expect.any(String)
			);
			ensureParentSpy.mockRestore();
		});

		it("resolves note paths from save-location and filename patterns", async () => {
			mockPlugin.settings.saveLocation = "KeepSidian/{note.year}/{note.month}";
			mockPlugin.settings.noteFileNamePattern = "{note.date}-{title}";
			const datedNote: noteModule.NormalizedNote = {
				...normalizedNote,
				created: new Date("2024-03-20T14:30:45.000Z"),
			};

			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(datedNote);
			jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("create");
			const ensureParentSpy = jest.spyOn(pathsModule, "ensureParentFolderForFile").mockResolvedValue(undefined);

			await syncModule.processAndSaveNote(mockPlugin, note, mockPlugin.settings.saveLocation);

			expect(ensureParentSpy).toHaveBeenCalledWith(mockPlugin.app, "KeepSidian/2024/03/2024-03-20-Note 1.md");
			expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledWith(
				"KeepSidian/2024/03/2024-03-20-Note 1.md",
				expect.any(String)
			);
			ensureParentSpy.mockRestore();
		});

		it("should skip note if duplicate action is skip", async () => {
			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(normalizedNote);
			jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("skip");

			await syncModule.processAndSaveNote(mockPlugin, note, mockPlugin.settings.saveLocation);

			const expectedNotePath = `${mockPlugin.settings.saveLocation}/${note.title}.md`;
			// No write to note file when skipped; logging may still write to log file
			expect((mockPlugin.app.vault.adapter.write as jest.Mock).mock.calls.some((c) => c[0] === expectedNotePath)).toBe(
				false
			);
		});

		it("should merge note file if duplicate action is merge and merge succeeds", async () => {
			const existingContent = `---\nExisting: true\n---\nLine 1`;
			const incomingNote: noteModule.PreNormalizedNote = {
				title: "Note 1",
				text: "Line 1\nLine 2",
				frontmatterDict: { Incoming: "true" },
			};
			const incomingNormalized: noteModule.NormalizedNote = {
				...normalizedNote,
				text: "Line 1\nLine 2",
				textWithoutFrontmatter: "Line 1\nLine 2",
				frontmatterDict: { Incoming: "true" },
			};

			(mockPlugin.app.vault.adapter.exists as jest.Mock).mockResolvedValueOnce(true);
			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(incomingNormalized);
			jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("merge");
			jest.spyOn(mockPlugin.app.vault.adapter, "read").mockResolvedValue(existingContent);
			jest.spyOn(Date.prototype, "toISOString").mockReturnValue("2023-01-01T00:00:00.000Z");
			jest
				.spyOn(obsidian, "normalizePath")
				.mockReturnValue(`${mockPlugin.settings.saveLocation}/${incomingNote.title}.md`);

			await syncModule.processAndSaveNote(mockPlugin, incomingNote, mockPlugin.settings.saveLocation);

			const expectedFilePath = `${mockPlugin.settings.saveLocation}/${incomingNote.title}.md`;
			const expectedContent = `---\nExisting: true\nKeepSidianLastSyncedDate: 2023-01-01T00:00:00.000Z\n---\nLine 1\nLine 2`;
			expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledWith(expectedFilePath, expectedContent);
		});

		it("should rename note file if merge has conflicts", async () => {
			const existingContent = `---\nExisting: true\n---\nLine 1\nLine A`;
			const incomingNote: noteModule.PreNormalizedNote = {
				title: "Note 1",
				text: "Line 1\nLine B",
				frontmatterDict: { Incoming: "true" },
			};
			const incomingNormalized: noteModule.NormalizedNote = {
				...normalizedNote,
				text: "Line 1\nLine B",
				frontmatterDict: { Incoming: "true" },
			};

			(mockPlugin.app.vault.adapter.exists as jest.Mock).mockResolvedValueOnce(true);
			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(incomingNormalized);
			jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("merge");
			jest.spyOn(mockPlugin.app.vault.adapter, "read").mockResolvedValue(existingContent);
			jest.spyOn(Date.prototype, "toISOString").mockReturnValue("2023-01-01T00:00:00.000Z");
			jest
				.spyOn(obsidian, "normalizePath")
				.mockReturnValue(`${mockPlugin.settings.saveLocation}/${incomingNote.title}.md`);

			await syncModule.processAndSaveNote(mockPlugin, incomingNote, mockPlugin.settings.saveLocation);

			const expectedFilePath = `${mockPlugin.settings.saveLocation}/${incomingNote.title}-conflict-2023-01-01T00:00:00.000Z.md`;
			expect(mockPlugin.app.vault.adapter.write).toHaveBeenCalledWith(expectedFilePath, expect.any(String));
		});

		it("should process attachments if present", async () => {
			const preNormalizedNote: noteModule.PreNormalizedNote = {
				title: "Note 1",
				text: "Content 1",
				frontmatterDict: {},
				blob_urls: ["http://example.com/blob1", "http://example.com/blob2"],
			};
			const normalizedNoteWithAttachments = {
				...normalizedNote,
				blob_urls: ["http://example.com/blob1", "http://example.com/blob2"],
			};

			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(normalizedNoteWithAttachments);
			jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("overwrite");
			const processAttachmentsSpy = jest.spyOn(attachmentsModule, "processAttachments").mockResolvedValue({
				downloaded: 2,
				skippedIdentical: 0,
				totalDurationMs: 24,
				fetchDurationMs: 12,
				compareDurationMs: 6,
				writeDurationMs: 6,
				fileNames: ["blob1.png", "blob2.jpg"],
			});
			const logSpy = jest.spyOn(loggingModule, "logSync").mockResolvedValue(undefined);

			await syncModule.processAndSaveNote(mockPlugin, preNormalizedNote, mockPlugin.settings.saveLocation);

			expect(processAttachmentsSpy).toHaveBeenCalledWith(
				mockPlugin.app,
				preNormalizedNote.blob_urls,
				mockPlugin.settings.saveLocation,
				normalizedNoteWithAttachments.blob_names,
				{
					email: mockPlugin.settings.email,
					token: mockPlugin.settings.token,
				}
			);
			expect(logSpy).toHaveBeenCalledWith(
				mockPlugin,
				expect.stringContaining("downloaded 2 attachments"),
				expect.objectContaining({
					batchKey: "sync:notes",
					batchSize: 50,
				})
			);
			processAttachmentsSpy.mockRestore();
			logSpy.mockRestore();
		});

		it("adds downloaded images to the note when inline display is enabled", async () => {
			mockPlugin.settings.embedImportedImages = true;
			const incomingNote: noteModule.PreNormalizedNote = {
				title: "Note 1",
				text: "Content 1",
				frontmatterDict: {},
				blob_urls: ["http://example.com/blob1", "http://example.com/blob2"],
			};
			const normalizedWithAttachments = {
				...normalizedNote,
				blob_urls: incomingNote.blob_urls as string[],
			};
			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(normalizedWithAttachments);
			jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("create");
			jest.spyOn(attachmentsModule, "processAttachments").mockResolvedValue({
				downloaded: 2,
				skippedIdentical: 0,
				totalDurationMs: 0,
				fetchDurationMs: 0,
				compareDurationMs: 0,
				writeDurationMs: 0,
				fileNames: ["photo one.png", "audio.mp3"],
			});
			(mockPlugin.app.vault.adapter.read as jest.Mock).mockResolvedValue(
				"---\nKeepSidianLastSyncedDate: 2026-07-12T19:10:55.015Z\n---\nContent 1"
			);

			await syncModule.processAndSaveNote(mockPlugin, incomingNote, mockPlugin.settings.saveLocation);

			const noteWrites = (mockPlugin.app.vault.adapter.write as jest.Mock).mock.calls.filter(
				([path]) => path === "Test Folder/Note 1.md"
			);
			expect(noteWrites.at(-1)?.[1]).toContain("![[media/photo one.png]]");
			expect(noteWrites.at(-1)?.[1]).not.toContain("audio.mp3");
		});

		it("should download attachments even when note is skipped", async () => {
			const preNormalizedNote: noteModule.PreNormalizedNote = {
				title: "Note 1",
				text: "Content 1",
				frontmatterDict: {},
				blob_urls: ["http://example.com/blob1"],
			};
			const normalizedNoteWithAttachments = {
				...normalizedNote,
				blob_urls: ["http://example.com/blob1"],
			};

			jest.spyOn(noteModule, "normalizeNote").mockReturnValue(normalizedNoteWithAttachments);
			jest.spyOn(compareModule, "handleDuplicateNotes").mockResolvedValue("skip");
			const processAttachmentsSpy = jest.spyOn(attachmentsModule, "processAttachments").mockResolvedValue({
				downloaded: 0,
				skippedIdentical: 1,
				totalDurationMs: 18,
				fetchDurationMs: 8,
				compareDurationMs: 6,
				writeDurationMs: 4,
				fileNames: ["blob1.png"],
			});
			const logSpy = jest.spyOn(loggingModule, "logSync").mockResolvedValue(undefined);

			await syncModule.processAndSaveNote(mockPlugin, preNormalizedNote, mockPlugin.settings.saveLocation);

			expect(processAttachmentsSpy).toHaveBeenCalledWith(
				mockPlugin.app,
				preNormalizedNote.blob_urls,
				mockPlugin.settings.saveLocation,
				normalizedNoteWithAttachments.blob_names,
				{
					email: mockPlugin.settings.email,
					token: mockPlugin.settings.token,
				}
			);
			expect(logSpy).toHaveBeenCalledWith(
				mockPlugin,
				expect.stringContaining("identical (skipped)"),
				expect.objectContaining({
					batchKey: "sync:notes",
					batchSize: 50,
				})
			);
			expect(logSpy).toHaveBeenCalledWith(
				mockPlugin,
				expect.stringContaining("attachments up to date"),
				expect.objectContaining({
					batchKey: "sync:notes",
					batchSize: 50,
				})
			);
			processAttachmentsSpy.mockRestore();
			logSpy.mockRestore();
		});
	});

	describe("parseResponse", () => {
		it("should parse JSON response using json() method", async () => {
			const mockResponse: Partial<RequestUrlResponse> = {
				status: 200,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: () => ({ notes: ["note1", "note2"] }),
				text: "",
			};

			const result = parseResponse(mockResponse as RequestUrlResponse);
			expect(result).toEqual({ notes: ["note1", "note2"] });
		});

		it("should parse response with json function", () => {
			const response = {
				status: 200,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: () => ({ notes: [{ title: "Note 1" }] }),
				text: "",
			} satisfies Partial<RequestUrlResponse>;
			const result = parseResponse(response as RequestUrlResponse);
			expect(result).toEqual({ notes: [{ title: "Note 1" }] });
		});

		it("should parse response with text property", () => {
			const response = {
				status: 200,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: undefined,
				text: JSON.stringify({ notes: [{ title: "Note 1" }] }),
			} satisfies Partial<RequestUrlResponse>;
			const result = parseResponse(response as RequestUrlResponse);
			expect(result).toEqual({ notes: [{ title: "Note 1" }] });
		});

		it("should return response if json and text are not present", () => {
			const response = {
				status: 200,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: { notes: [{ title: "Note 1" }] },
				text: "",
			} satisfies Partial<RequestUrlResponse>;
			const result = parseResponse(response as RequestUrlResponse);
			expect(result).toEqual(response.json);
		});
	});
});
