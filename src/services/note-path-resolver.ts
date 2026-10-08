import { normalizePath } from "obsidian";
import {
	DEFAULT_NOTE_FILE_NAME_PATTERN,
	DEFAULT_SAVE_LOCATION_MODE,
	LEGACY_SAVE_LOCATION,
	NEW_INSTALL_SAVE_LOCATION,
	type SaveLocationMode,
} from "../types/keepsidian-plugin-settings";

export {
	DEFAULT_NOTE_FILE_NAME_PATTERN,
	DEFAULT_SAVE_LOCATION_MODE,
	LEGACY_SAVE_LOCATION,
	NEW_INSTALL_SAVE_LOCATION,
};

export interface NotePathSettings {
	saveLocation: string;
	saveLocationMode: SaveLocationMode;
	noteFileNamePattern: string;
}

export interface NoteDateLike {
	title?: string | null;
	created?: string | Date | null;
	now?: string | Date | null;
	updated?: string | Date | null;
}

interface NotePatternValues {
	title: string;
	now: DatePatternValues;
	note: DatePatternValues;
}

interface DatePatternValues {
	date: string;
	day: string;
	time: string;
	year: string;
	month: string;
	quarter: string;
}

function toDate(value?: string | Date | null): Date | null {
	if (!value) {
		return null;
	}

	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sanitizePathSegment(value: string): string {
	return value.replace(/[<>:"/\\|?*]/g, "_").trim();
}

function sanitizePatternPath(value: string): string {
	return normalizePath(
		value
			.split("/")
			.map((segment) => sanitizePathSegment(segment))
			.filter((segment) => segment.length > 0)
			.join("/")
	);
}

function buildDatePatternValues(date: Date): DatePatternValues {
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");

	return {
		date: `${year}-${month}-${day}`,
		day,
		time: `${hours}-${minutes}-${seconds}`,
		year,
		month,
		quarter: `Q${Math.floor(date.getMonth() / 3) + 1}`,
	};
}

function buildPatternValues(note: NoteDateLike): NotePatternValues {
	return {
		title: sanitizePathSegment(note.title?.trim() ?? ""),
		now: buildDatePatternValues(toDate(note.now) ?? new Date()),
		note: buildDatePatternValues(resolveNoteDate(note)),
	};
}

function resolveToken(token: string, values: NotePatternValues): string | null {
	if (token === "title") {
		return values.title;
	}

	const normalizedToken = token.startsWith("now.") || token.startsWith("note.") ? token : `now.${token}`;
	const [scope, field] = normalizedToken.split(".", 2) as ["now" | "note", keyof DatePatternValues];

	if ((scope !== "now" && scope !== "note") || !field) {
		return null;
	}

	const scopedValues = values[scope];
	return field in scopedValues ? scopedValues[field] : null;
}

function resolvePattern(pattern: string, values: NotePatternValues): string {
	return pattern.replace(/\{([^}]+)\}/g, (fullMatch, token: string) => {
		const resolvedToken = resolveToken(token, values);
		return resolvedToken ?? fullMatch;
	});
}

export function resolveNoteDate(note: NoteDateLike): Date {
	return toDate(note.created) ?? toDate(note.updated) ?? new Date();
}

export function resolveCustomSaveLocation(pattern: string, note: NoteDateLike): string {
	const effectivePattern = pattern.trim() || NEW_INSTALL_SAVE_LOCATION;
	return sanitizePatternPath(resolvePattern(effectivePattern, buildPatternValues(note)));
}

/** Search every resolved folder, including old dates and titles, by stable ID. */
export function resolveNoteLookupRoot(pattern: string): string {
	const parts = pattern
		.trim()
		.split("/")
		.filter((part) => part.length > 0);
	const dynamic = parts.findIndex((part) => /[{}]/.test(part));
	return sanitizePatternPath((dynamic < 0 ? parts : parts.slice(0, dynamic)).join("/"));
}

export function resolveNoteFolder(_app: unknown, settings: NotePathSettings, note: NoteDateLike): string {
	return resolveCustomSaveLocation(settings.saveLocation, note);
}

export function resolveNoteFileName(pattern: string, note: NoteDateLike): string {
	const resolved = resolvePattern(
		pattern?.trim() || DEFAULT_NOTE_FILE_NAME_PATTERN,
		buildPatternValues(note)
	);
	return `${sanitizePathSegment(resolved) || "Untitled KeepSidian Note"}.md`;
}

export function resolveNotePath(app: unknown, settings: NotePathSettings, note: NoteDateLike): string {
	const folder = resolveNoteFolder(app, settings, note);
	const fileName = resolveNoteFileName(settings.noteFileNamePattern, note);
	return folder ? normalizePath(`${folder}/${fileName}`) : normalizePath(fileName);
}

export function resolveLogBaseFolder(
	app: unknown,
	settings: NotePathSettings,
	currentDate: Date = new Date()
): string {
	return resolveNoteFolder(app, {
		...settings,
		saveLocation: settings.saveLocation || LEGACY_SAVE_LOCATION,
		saveLocationMode: settings.saveLocationMode || DEFAULT_SAVE_LOCATION_MODE,
		noteFileNamePattern: settings.noteFileNamePattern || DEFAULT_NOTE_FILE_NAME_PATTERN,
	}, {
		created: currentDate,
		now: currentDate,
	});
}
