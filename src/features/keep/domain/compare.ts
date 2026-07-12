import { App } from "obsidian";
import { NormalizedNote, normalizeDate, extractFrontmatter, getFrontmatterStringValue } from "./note";
import {
	FRONTMATTER_GOOGLE_KEEP_CREATED_DATE_KEY,
	FRONTMATTER_GOOGLE_KEEP_UPDATED_DATE_KEY,
	FRONTMATTER_KEEP_SIDIAN_LAST_SYNCED_DATE_KEY,
} from "../constants";
import { buildNotePath } from "@services/index";
import { findExistingKeepNotePath, type ExistingKeepNoteIndex } from "./noteLookup";
import { stripManagedImageEmbeds } from "./attachmentEmbeds";

interface UpdatedFileInfo {
	textWithoutFrontmatter: string;
	createdDate: Date | null;
	updatedDate: Date | null;
}

interface ExistingFileInfo {
	textWithoutFrontmatter: string;
	createdDate: Date | null;
	updatedDate: Date | null;
	fsCreatedDate: Date | null;
	fsUpdatedDate: Date | null;
	lastSyncedDate: Date | null;
}

function getUpdatedFileInfo(incomingNote: NormalizedNote): UpdatedFileInfo {
	return {
		textWithoutFrontmatter: incomingNote.textWithoutFrontmatter,
		createdDate: incomingNote.created,
		updatedDate: incomingNote.updated,
	};
}

async function getExistingFileInfo(noteFilePath: string, app: App): Promise<ExistingFileInfo> {
	const existingContent = await app.vault.adapter.read(noteFilePath);
	const [, existingBody, existingFrontMatterDict] = extractFrontmatter(existingContent);

	const existingCreatedDate = normalizeDate(
		getFrontmatterStringValue(existingFrontMatterDict, FRONTMATTER_GOOGLE_KEEP_CREATED_DATE_KEY)
	);
	const existingUpdatedDate = normalizeDate(
		getFrontmatterStringValue(existingFrontMatterDict, FRONTMATTER_GOOGLE_KEEP_UPDATED_DATE_KEY)
	);
	const existingLastSyncedDate = normalizeDate(
		getFrontmatterStringValue(existingFrontMatterDict, FRONTMATTER_KEEP_SIDIAN_LAST_SYNCED_DATE_KEY)
	);
	// Get fsCreatedDate and fsUpdatedDate from noteFilePath
	const fsCreatedDateTimeStamp = await app.vault.adapter.stat(noteFilePath).then((stat) => stat?.ctime);
	const fsUpdatedDateTimeStamp = await app.vault.adapter.stat(noteFilePath).then((stat) => stat?.mtime);
	const fsCreatedDate = fsCreatedDateTimeStamp ? new Date(fsCreatedDateTimeStamp) : null;
	const fsUpdatedDate = fsUpdatedDateTimeStamp ? new Date(fsUpdatedDateTimeStamp) : null;

	return {
		// Read from noteFilePath
		textWithoutFrontmatter: stripManagedImageEmbeds(existingBody),
		createdDate: existingCreatedDate,
		updatedDate: existingUpdatedDate,
		fsCreatedDate: fsCreatedDate,
		fsUpdatedDate: fsUpdatedDate,
		lastSyncedDate: existingLastSyncedDate,
	};
}

async function handleDuplicateNotes(
	saveLocation: string,
	incomingNote: NormalizedNote,
	app: App,
	noteFilePathOverride?: string,
	existingKeepNoteIndex?: ExistingKeepNoteIndex
): Promise<"skip" | "merge" | "overwrite" | "create"> {
	const preferredPath = noteFilePathOverride ?? buildNotePath(saveLocation, incomingNote.title);
	const noteFilePath =
		(await findExistingKeepNotePath(app, incomingNote, preferredPath, existingKeepNoteIndex, saveLocation)) ??
		preferredPath;
	const fileExists = existingKeepNoteIndex
		? existingKeepNoteIndex.existingPaths.has(noteFilePath)
		: noteFilePath !== preferredPath || (await app.vault.adapter.exists(noteFilePath));

	if (fileExists) {
		const updatedFileInfo: UpdatedFileInfo = getUpdatedFileInfo(incomingNote);
		const existingFileInfo: ExistingFileInfo = await getExistingFileInfo(noteFilePath, app);

		return checkForDuplicateData(updatedFileInfo, existingFileInfo);
	} else {
		return "create";
	}
}

function checkForDuplicateData(
	incomingFile: UpdatedFileInfo,
	existingFile: ExistingFileInfo
): "skip" | "merge" | "overwrite" {
	const currentDate = new Date();

	// Normalize dates for incoming file
	const incomingUpdatedDate = incomingFile.updatedDate || currentDate;

	// Normalize dates for existing file
	const existingUpdatedDate = existingFile.fsUpdatedDate || existingFile.updatedDate || existingFile.fsCreatedDate;
	const lastSyncedDate = existingFile.lastSyncedDate || existingFile.fsCreatedDate;

	// Step 1: Check if the contents are exactly the same
	if (incomingFile.textWithoutFrontmatter === existingFile.textWithoutFrontmatter) {
		return "skip";
	}

	// Step 2: If lastSyncedDate exists, use it to determine if both files have been modified
	if (lastSyncedDate && existingUpdatedDate) {
		const incomingModified = incomingUpdatedDate > lastSyncedDate;
		const existingModified = existingUpdatedDate > lastSyncedDate;

		if (incomingModified && existingModified) {
			return "merge"; // Both sides have been edited since last sync, so we attempt to merge
		}

		if (incomingModified && !existingModified) {
			return "overwrite"; // Only incoming file has been modified since last sync
		}

		if (!incomingModified && existingModified) {
			return "merge"; // Only existing file has been modified since last sync
		}

		// If neither file has been modified since last sync (shouldn't happen if contents differ, but just in case)
		return "skip";
	}

	// Step 3: If lastSyncedDate doesn't exist or couldn't be normalized, fall back to comparing dates
	if (existingUpdatedDate) {
		if (incomingUpdatedDate > existingUpdatedDate) {
			return "overwrite";
		} else if (incomingUpdatedDate < existingUpdatedDate) {
			return "merge";
		} else {
			// If dates are equal, we can't determine which is newer, so we attempt to merge
			return "merge";
		}
	} else {
		return "merge";
	}
}

export { normalizeDate, handleDuplicateNotes, checkForDuplicateData, getExistingFileInfo, getUpdatedFileInfo };
