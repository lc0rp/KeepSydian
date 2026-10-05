import { normalizeDate, handleDuplicateNotes, checkForDuplicateData } from "../compare";
import { NormalizedNote } from "../note";
import type { App } from "obsidian";
import { buildExistingKeepNoteIndex, findExistingKeepNotePath } from "../noteLookup";
import { createMockPlugin, type MockVaultAdapter } from "../../../../test-utils/mocks/plugin";

describe("normalizeDate", () => {
	it("should return null for undefined input", () => {
		expect(normalizeDate(undefined)).toBeNull();
	});

	it("should return a valid Date object for a valid date string", () => {
		const result = normalizeDate("2023-05-25T10:00:00Z");
		expect(result).toBeInstanceOf(Date);
		expect(result?.toISOString()).toBe("2023-05-25T10:00:00.000Z");
	});

	it("should return null for an invalid date string", () => {
		expect(normalizeDate("invalid-date")).toBeNull();
	});
});

describe("handleDuplicateNotes", () => {
	let mockApp: App;
	let adapter: MockVaultAdapter;

	beforeEach(() => {
		const plugin = createMockPlugin();
		adapter = plugin.app.vault.adapter;
		mockApp = plugin.app as unknown as App;
	});

	it('should return "create" when file does not exist', async () => {
		adapter.exists.mockResolvedValue(false);

		const note: NormalizedNote = {
			title: "Sample",
			text: "Sample",
			created: null,
			updated: null,
			color: null,
			pinned: false,
			frontmatter: "",
			frontmatterDict: {},
			archived: false,
			trashed: false,
			labels: [],
			blobs: [],
			blob_urls: [],
			blob_names: [],
			media: [],
			header: "",
			textWithoutFrontmatter: "",
		};

		const result = await handleDuplicateNotes("/save/location", note, mockApp);
		expect(result).toBe("create");
	});

	it("should call checkForDuplicateData when file exists", async () => {
		adapter.exists.mockResolvedValue(true);
		adapter.read.mockResolvedValue("---\nCreated: 2023-05-25\n---\nExisting content");
		adapter.stat.mockResolvedValue({
			ctime: Date.now(),
			mtime: Date.now(),
		});

		const incomingNote: NormalizedNote = {
			title: "Test Note",
			text: "Content",
			created: new Date("2023-05-25"),
			updated: new Date("2023-05-26"),
			color: null,
			pinned: false,
			frontmatter: "",
			frontmatterDict: {},
			archived: false,
			trashed: false,
			labels: [],
			blobs: [],
			blob_urls: [],
			blob_names: [],
			media: [],
			header: "",
			textWithoutFrontmatter: "New content",
		};

		const result = await handleDuplicateNotes("/save/location", incomingNote, mockApp);
		expect(["skip", "merge", "overwrite"]).toContain(result);
	});

	it("finds existing notes by GoogleKeepUrl when the filename no longer matches the title inside saveLocation", async () => {
		adapter.exists.mockImplementation(async (path) => path === "/save/location/old-name.md");
		adapter.list.mockResolvedValue({ files: ["/save/location/old-name.md"], folders: [] });
		adapter.read.mockResolvedValue("---\nGoogleKeepUrl: https://keep.google.com/u/0/#NOTE/123\n---\nExisting content");
		adapter.stat.mockResolvedValue({
			ctime: Date.now(),
			mtime: Date.now(),
		});

		const incomingNote: NormalizedNote = {
			title: "Renamed title",
			text: "Content",
			created: new Date("2023-05-25"),
			updated: new Date("2023-05-26"),
			color: null,
			pinned: false,
			frontmatter:
				"GoogleKeepUrl: https://keep.google.com/u/0/#NOTE/123\nGoogleKeepCreatedDate: 2023-05-25T00:00:00.000Z",
			frontmatterDict: {
				GoogleKeepUrl: "https://keep.google.com/u/0/#NOTE/123",
			},
			archived: false,
			trashed: false,
			labels: [],
			blobs: [],
			blob_urls: [],
			blob_names: [],
			media: [],
			header: "",
			textWithoutFrontmatter: "New content",
		};

		const result = await handleDuplicateNotes("/save/location", incomingNote, mockApp);
		expect(["skip", "merge", "overwrite"]).toContain(result);
		expect(adapter.list).toHaveBeenCalledWith("save/location");
		expect(adapter.stat).toHaveBeenCalledWith("/save/location/old-name.md");
	});

	it("reuses a prebuilt Keep-note index instead of rescanning saveLocation", async () => {
		adapter.exists.mockResolvedValue(false);
		adapter.list.mockResolvedValue({
			files: ["/save/location/old-name.md", "/save/location/unrelated.md"],
			folders: [],
		});
		adapter.read.mockImplementation(async (path: string) => {
			if (path === "/save/location/old-name.md") {
				return "---\nGoogleKeepUrl: https://keep.google.com/u/0/#NOTE/123\n---\nExisting";
			}
			return "---\n---\nOther";
		});

		const incomingNote: NormalizedNote = {
			title: "Renamed title",
			text: "Content",
			created: new Date("2023-05-25"),
			updated: new Date("2023-05-26"),
			color: null,
			pinned: false,
			frontmatter:
				"GoogleKeepUrl: https://keep.google.com/u/0/#NOTE/123\nGoogleKeepCreatedDate: 2023-05-25T00:00:00.000Z",
			frontmatterDict: {
				GoogleKeepUrl: "https://keep.google.com/u/0/#NOTE/123",
			},
			archived: false,
			trashed: false,
			labels: [],
			blobs: [],
			blob_urls: [],
			blob_names: [],
			media: [],
			header: "",
			textWithoutFrontmatter: "New content",
		};

		const index = await buildExistingKeepNoteIndex(mockApp, "/save/location");
		const readCallsAfterIndexBuild = adapter.read.mock.calls.length;

		const resolvedPath = await findExistingKeepNotePath(
			mockApp,
			incomingNote,
			"/save/location/Renamed title.md",
			index,
			"/save/location"
		);

		expect(resolvedPath).toBe("/save/location/old-name.md");
		expect(adapter.list).toHaveBeenCalledTimes(1);
		expect(adapter.read).toHaveBeenCalledTimes(readCallsAfterIndexBuild);
	});

	it("scans only the scoped saveLocation instead of the whole vault", async () => {
		const getMarkdownFiles = jest.fn(() => [{ path: "Archive/old-name.md" }, { path: "/save/location/unrelated.md" }]);
		(mockApp.vault as unknown as { getMarkdownFiles: typeof getMarkdownFiles }).getMarkdownFiles = getMarkdownFiles;
		adapter.list.mockResolvedValue({
			files: ["/save/location/unrelated.md"],
			folders: [],
		});
		adapter.read.mockResolvedValue("---\n---\nOther");

		const incomingNote: NormalizedNote = {
			title: "Renamed title",
			text: "Content",
			created: new Date("2023-05-25"),
			updated: new Date("2023-05-26"),
			color: null,
			pinned: false,
			frontmatter:
				"GoogleKeepUrl: https://keep.google.com/u/0/#NOTE/123\nGoogleKeepCreatedDate: 2023-05-25T00:00:00.000Z",
			frontmatterDict: {
				GoogleKeepUrl: "https://keep.google.com/u/0/#NOTE/123",
			},
			archived: false,
			trashed: false,
			labels: [],
			blobs: [],
			blob_urls: [],
			blob_names: [],
			media: [],
			header: "",
			textWithoutFrontmatter: "New content",
		};

		const index = await buildExistingKeepNoteIndex(mockApp, "/save/location");
		const resolvedPath = await findExistingKeepNotePath(
			mockApp,
			incomingNote,
			"/save/location/Renamed title.md",
			index,
			"/save/location"
		);

		expect(resolvedPath).toBe("/save/location/Renamed title.md");
		expect(getMarkdownFiles).not.toHaveBeenCalled();
		expect(adapter.list).toHaveBeenCalledWith("save/location");
		expect(adapter.read).toHaveBeenCalledWith("/save/location/unrelated.md");
	});
});

describe("checkForDuplicateData", () => {
	it('should return "skip" when contents are the same', () => {
		const incomingFile = {
			textWithoutFrontmatter: "Same content",
			createdDate: new Date("2023-05-25"),
			updatedDate: new Date("2023-05-26"),
		};
		const existingFile = {
			textWithoutFrontmatter: "Same content",
			createdDate: new Date("2023-05-24"),
			updatedDate: new Date("2023-05-25"),
			fsCreatedDate: new Date("2023-05-24"),
			fsUpdatedDate: new Date("2023-05-25"),
			lastSyncedDate: new Date("2023-05-25"),
		};

		expect(checkForDuplicateData(incomingFile, existingFile)).toBe("skip");
	});

	it('should return "merge" when both files have been modified since last sync', () => {
		const incomingFile = {
			textWithoutFrontmatter: "New content",
			createdDate: new Date("2023-05-25"),
			updatedDate: new Date("2023-05-27"),
		};
		const existingFile = {
			textWithoutFrontmatter: "Modified existing content",
			createdDate: new Date("2023-05-24"),
			updatedDate: new Date("2023-05-26"),
			fsCreatedDate: new Date("2023-05-24"),
			fsUpdatedDate: new Date("2023-05-26"),
			lastSyncedDate: new Date("2023-05-25"),
		};

		expect(checkForDuplicateData(incomingFile, existingFile)).toBe("merge");
	});

	it('should return "overwrite" when only incoming file has been modified since last sync', () => {
		const incomingFile = {
			textWithoutFrontmatter: "New content",
			createdDate: new Date("2023-05-25"),
			updatedDate: new Date("2023-05-27"),
		};
		const existingFile = {
			textWithoutFrontmatter: "Existing content",
			createdDate: new Date("2023-05-24"),
			updatedDate: new Date("2023-05-25"),
			fsCreatedDate: new Date("2023-05-24"),
			fsUpdatedDate: new Date("2023-05-25"),
			lastSyncedDate: new Date("2023-05-26"),
		};

		expect(checkForDuplicateData(incomingFile, existingFile)).toBe("overwrite");
	});
});
