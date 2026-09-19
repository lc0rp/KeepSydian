import { parseYaml } from "obsidian";

type FrontmatterDict = { [key: string]: unknown };

interface NormalizedNote {
	title: string;
	text: string;
	created: Date | null;
	updated: Date | null;
	color: string | null;
	pinned: boolean;
	frontmatter: string;
	frontmatterDict: FrontmatterDict;
	archived: boolean;
	trashed: boolean;
	labels: string[];
	blobs: string[];
	blob_urls: string[];
	blob_names: string[];
	media: string[];
	header: string;
	textWithoutFrontmatter: string;
}

interface PreNormalizedNote {
	id?: string;
	title: string;
	text?: string;
	created?: string;
	updated?: string;
	color?: string;
	pinned?: boolean;
	frontmatter?: string;
	frontmatterDict?: FrontmatterDict;
	archived?: boolean;
	trashed?: boolean;
	labels?: string[];
	blobs?: string[];
	blob_urls?: Array<string | null>;
	blob_names?: string[];
	media?: string[];
	header?: string;
}

function normalizeDate(dateString?: string | null): Date | null {
	if (!dateString) {
		return null;
	}
	const date = new Date(dateString);
	return isNaN(date.getTime()) ? null : date;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function normalizeNote(note: PreNormalizedNote): NormalizedNote {
	const normalizedNote: NormalizedNote = {
		title: note.title?.trim() || "",
		text: note.text?.trim() || "",
		created: normalizeDate(note.created) || null,
		updated: normalizeDate(note.updated) || null,
		color: typeof note.color === "string" && note.color.trim().length > 0 ? note.color.trim() : null,
		pinned: note.pinned || false,
		archived: note.archived || false,
		trashed: note.trashed || false,
		labels: normalizeStringArray(note.labels),
		blobs: normalizeStringArray(note.blobs),
		blob_urls: normalizeStringArray(note.blob_urls),
		blob_names: normalizeStringArray(note.blob_names),
		media: normalizeStringArray(note.media),
		header: note.header || "",
		frontmatter: "",
		frontmatterDict: {},
		textWithoutFrontmatter: note.text || "",
	};

	const [frontmatter, textWithoutFrontmatter, frontmatterDict] = extractFrontmatter(normalizedNote.text);
	normalizedNote.frontmatter = frontmatter;
	normalizedNote.textWithoutFrontmatter = textWithoutFrontmatter;
	normalizedNote.frontmatterDict = frontmatterDict;

	return normalizedNote;
}

function extractFrontmatter(text: string): [string, string, FrontmatterDict] {
	// Frontmatter is between --- and --- at the start of the text if it exists
	let frontmatter = "";
	let frontmatterDict: FrontmatterDict = {};
	let textWithoutFrontmatter = text;
	const frontmatterMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
	if (frontmatterMatch) {
		frontmatter = frontmatterMatch[1].trim();
		textWithoutFrontmatter = text.slice(frontmatterMatch[0].length).trim();
	}

	if (frontmatter) {
		frontmatterDict = parseFrontmatter(frontmatter);
	}

	return [frontmatter, textWithoutFrontmatter, frontmatterDict];
}

function parseFrontmatter(frontmatter: string): FrontmatterDict {
	try {
		const parseYamlUnknown = parseYaml as (yaml: string) => unknown;
		const parsed = parseYamlUnknown(frontmatter);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}

		const parsedRecord = parsed as Record<string, unknown>;
		const frontmatterDict: FrontmatterDict = {};

		for (const [key, value] of Object.entries(parsedRecord)) {
			frontmatterDict[key] = value;

			// Keep pascal-case alias for compatibility with existing call sites.
			const pascalKey = key.replace(/(^|-)([a-z])/g, (_match: string, _p1: string, p2: string) => p2.toUpperCase());
			if (!(pascalKey in frontmatterDict)) {
				frontmatterDict[pascalKey] = value;
			}
		}

		return frontmatterDict;
	} catch {
		return {};
	}
}

function getFrontmatterStringValue(frontmatterDict: FrontmatterDict, key: string): string | undefined {
	const value = frontmatterDict[key];
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString();
	}
	return undefined;
}

export { extractFrontmatter, normalizeNote, normalizeDate, getFrontmatterStringValue };
export type { NormalizedNote, PreNormalizedNote };
