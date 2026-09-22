import { normalizePathSafe } from "@services/paths";
import { extractFrontmatter, getFrontmatterStringValue, normalizeKeepNoteUrl, type NormalizedNote } from "./note";
import {
	FRONTMATTER_GOOGLE_KEEP_CREATED_DATE_KEY,
	FRONTMATTER_GOOGLE_KEEP_UPDATED_DATE_KEY,
	FRONTMATTER_GOOGLE_KEEP_URL_KEY,
	FRONTMATTER_KEEP_SIDIAN_LAST_SYNCED_DATE_KEY,
} from "../constants";

type ListableAdapter = {
	list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
	exists?: (path: string) => Promise<boolean>;
	read: (path: string) => Promise<string>;
};

type MarkdownFileLike = {
	path: string;
};

type MetadataCacheLike = {
	getFileCache?: (file: MarkdownFileLike) => { frontmatter?: Record<string, unknown> } | null;
};

type MetadataBackedApp = {
	vault: {
		adapter: ListableAdapter;
		getMarkdownFiles?: () => MarkdownFileLike[];
	};
	metadataCache?: MetadataCacheLike;
};

export interface ExistingKeepNoteIndex {
	pathByKeepUrl: Map<string, string>;
	existingPaths: Set<string>;
}

function normalizeVaultPathForScope(path: string): string {
	return normalizePathSafe(path).replace(/^\/+/, "").replace(/\/+$/, "");
}

export async function listMarkdownFilesRecursively(adapter: ListableAdapter, folder = ""): Promise<string[]> {
	const normalizedFolder = normalizePathSafe(folder);
	if (typeof adapter.list !== "function") {
		return [];
	}

	try {
		const { files, folders } = await adapter.list(normalizedFolder);
		const markdownFiles = files
			.map((file) => normalizePathSafe(file))
			.filter((file) => file.toLowerCase().endsWith(".md"));

		for (const subfolder of folders) {
			const nested = await listMarkdownFilesRecursively(adapter, subfolder);
			markdownFiles.push(...nested);
		}

		return markdownFiles;
	} catch {
		return [];
	}
}

export function isKeepSidianFrontmatter(frontmatterDict: Record<string, unknown>): boolean {
	return (
		typeof getFrontmatterStringValue(frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY) === "string" ||
		typeof getFrontmatterStringValue(frontmatterDict, FRONTMATTER_KEEP_SIDIAN_LAST_SYNCED_DATE_KEY) === "string" ||
		typeof getFrontmatterStringValue(frontmatterDict, FRONTMATTER_GOOGLE_KEEP_CREATED_DATE_KEY) === "string" ||
		typeof getFrontmatterStringValue(frontmatterDict, FRONTMATTER_GOOGLE_KEEP_UPDATED_DATE_KEY) === "string"
	);
}

export async function buildExistingKeepNoteIndex(
	app: MetadataBackedApp,
	rootFolder = ""
): Promise<ExistingKeepNoteIndex> {
	const adapter = app.vault.adapter;
	const normalizedRootFolder = normalizeVaultPathForScope(rootFolder);
	if (normalizedRootFolder) {
		const markdownFiles = await listMarkdownFilesRecursively(adapter, normalizedRootFolder);
		const existingPaths = new Set(markdownFiles.map((filePath) => normalizePathSafe(filePath)));
		const pathByKeepUrl = new Map<string, string>();

		for (const filePath of existingPaths) {
			try {
				const content = await adapter.read(filePath);
				const [, , frontmatterDict] = extractFrontmatter(content);
				const existingKeepUrl = getFrontmatterStringValue(frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY);
				if (existingKeepUrl) {
					pathByKeepUrl.set(normalizeKeepNoteUrl(existingKeepUrl), filePath);
				}
			} catch {
				// Ignore unreadable candidates during lookup.
			}
		}

		return {
			pathByKeepUrl,
			existingPaths,
		};
	}

	const metadataBackedFiles = app.vault.getMarkdownFiles?.();
	if (Array.isArray(metadataBackedFiles) && metadataBackedFiles.length > 0) {
		const existingPaths = new Set(
			metadataBackedFiles
				.map((file) => normalizePathSafe(file.path))
				.filter((path) => path.length > 0)
		);
		const pathByKeepUrl = new Map<string, string>();

		for (const file of metadataBackedFiles) {
			const normalizedPath = normalizePathSafe(file.path);
			const frontmatterDict = app.metadataCache?.getFileCache?.(file)?.frontmatter;
			if (!frontmatterDict) {
				continue;
			}
			const existingKeepUrl = getFrontmatterStringValue(frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY);
			if (existingKeepUrl) {
				pathByKeepUrl.set(normalizeKeepNoteUrl(existingKeepUrl), normalizedPath);
			}
		}

		return {
			pathByKeepUrl,
			existingPaths,
		};
	}

	const markdownFiles = await listMarkdownFilesRecursively(adapter, normalizedRootFolder);
	const existingPaths = new Set(markdownFiles.map((filePath) => normalizePathSafe(filePath)));
	const pathByKeepUrl = new Map<string, string>();

	for (const filePath of existingPaths) {
		try {
			const content = await adapter.read(filePath);
			const [, , frontmatterDict] = extractFrontmatter(content);
			const existingKeepUrl = getFrontmatterStringValue(frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY);
			if (existingKeepUrl) {
				pathByKeepUrl.set(normalizeKeepNoteUrl(existingKeepUrl), filePath);
			}
		} catch {
			// Ignore unreadable candidates during lookup.
		}
	}

	return {
		pathByKeepUrl,
		existingPaths,
	};
}

export function updateExistingKeepNoteIndex(
	index: ExistingKeepNoteIndex,
	filePath: string,
	incomingNote: NormalizedNote
): void {
	const normalizedPath = normalizePathSafe(filePath);
	index.existingPaths.add(normalizedPath);
	const incomingKeepUrl = getFrontmatterStringValue(incomingNote.frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY);
	if (incomingKeepUrl) {
		index.pathByKeepUrl.set(normalizeKeepNoteUrl(incomingKeepUrl), normalizedPath);
	}
}

export async function findExistingKeepNotePath(
	app: { vault: { adapter: ListableAdapter } },
	incomingNote: NormalizedNote,
	preferredPath?: string,
	index?: ExistingKeepNoteIndex,
	rootFolder = ""
): Promise<string | null> {
	const adapter = app.vault.adapter;
	const normalizedPreferredPath = preferredPath ? normalizePathSafe(preferredPath) : null;
	const incomingKeepUrl = getFrontmatterStringValue(incomingNote.frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY);

	// A renamed linked note takes precedence over a different note with the expected filename.
	if (incomingKeepUrl && index) {
		const linkedPath =
			index.pathByKeepUrl.get(normalizeKeepNoteUrl(incomingKeepUrl)) ?? index.pathByKeepUrl.get(incomingKeepUrl);
		if (linkedPath) return linkedPath;
	}

	if (normalizedPreferredPath) {
		if (index?.existingPaths.has(normalizedPreferredPath)) {
			return normalizedPreferredPath;
		}
		if (!index && typeof adapter.exists === "function" && (await adapter.exists(normalizedPreferredPath))) {
			return normalizedPreferredPath;
		}
	}

	if (!incomingKeepUrl || index) {
		return normalizedPreferredPath;
	}

	const builtIndex = await buildExistingKeepNoteIndex(app, rootFolder);
	return builtIndex.pathByKeepUrl.get(normalizeKeepNoteUrl(incomingKeepUrl)) ?? normalizedPreferredPath;
}
