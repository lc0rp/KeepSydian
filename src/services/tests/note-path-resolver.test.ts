import {
	DEFAULT_NOTE_FILE_NAME_PATTERN,
	DEFAULT_SAVE_LOCATION_MODE,
	LEGACY_SAVE_LOCATION,
	NEW_INSTALL_SAVE_LOCATION,
	resolveLogBaseFolder,
	resolveNoteDate,
	resolveNotePath,
	type NotePathSettings,
} from "../note-path-resolver";

describe("note-path-resolver", () => {
	const baseSettings: NotePathSettings = {
		saveLocationMode: DEFAULT_SAVE_LOCATION_MODE,
		saveLocation: NEW_INSTALL_SAVE_LOCATION,
		noteFileNamePattern: DEFAULT_NOTE_FILE_NAME_PATTERN,
	};

	it("uses created date first, then updated date, then now", () => {
		const createdFirst = resolveNoteDate({
			created: "2024-03-20T10:00:00.000Z",
			updated: "2024-03-22T12:00:00.000Z",
		});
		expect(createdFirst.toISOString()).toBe("2024-03-20T10:00:00.000Z");

		const updatedFallback = resolveNoteDate({
			updated: "2024-03-22T12:00:00.000Z",
		});
		expect(updatedFallback.toISOString()).toBe("2024-03-22T12:00:00.000Z");

		jest.useFakeTimers().setSystemTime(new Date("2024-03-25T09:30:00.000Z"));
		try {
			const nowFallback = resolveNoteDate({});
			expect(nowFallback.toISOString()).toBe("2024-03-25T09:30:00.000Z");
		} finally {
			jest.useRealTimers();
		}
	});

	it("resolves custom save-location variables and filename variables like granola-sync", () => {
		jest.useFakeTimers().setSystemTime(new Date(2026, 2, 13, 11, 20, 25));
		try {
			const result = resolveNotePath(
				{},
				{
					...baseSettings,
					saveLocation: "/KeepSidian/{year}/{month}/{day}/{note.year}/{note.day}",
					noteFileNamePattern: "{date}-{time}-{day}-{note.date}-{note.day}-{title}",
				},
				{
					title: "Planning: Q1/2024",
					created: new Date(2024, 2, 20, 12, 30, 45),
				}
			);

			expect(result).toBe(
				"KeepSidian/2026/03/13/2024/20/2026-03-13-11-20-25-13-2024-03-20-20-Planning_ Q1_2024.md"
			);
		} finally {
			jest.useRealTimers();
		}
	});

	it("treats legacy daily-notes mode like custom mode", () => {
		const result = resolveNotePath(
			{},
			{
				...baseSettings,
				saveLocationMode: "daily-notes",
				saveLocation: "/Fallback/{note.year}",
			},
			{
				title: "Fallback note",
				created: "2024-03-20T14:30:45.000Z",
			}
		);

		expect(result).toBe("Fallback/2024/Fallback note.md");
	});

	it("resolves log base folders from the custom path and current date", () => {
		const customFolder = resolveLogBaseFolder(
			{},
			{
				...baseSettings,
				saveLocation: "/KeepSidian/{year}/{month}",
			},
			new Date("2024-03-20T14:30:45.000Z")
		);
		expect(customFolder).toBe("KeepSidian/2024/03");

		const legacyModeFolder = resolveLogBaseFolder(
			{},
			{
				...baseSettings,
				saveLocationMode: "daily-notes",
				saveLocation: LEGACY_SAVE_LOCATION,
			},
			new Date("2024-03-20T14:30:45.000Z")
		);
		expect(legacyModeFolder).toBe("Google Keep");
	});
});
