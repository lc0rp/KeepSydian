import { normalizePathSafe } from "@services/paths";
import { resolveNoteLookupRoot } from "@services/note-path-resolver";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { sha256 } from "../local-deletions/state";
import { extractFrontmatter, getFrontmatterStringValue, normalizeKeepNoteUrl, type NormalizedNote } from "./note";
import {
	CONFLICT_FILE_SUFFIX,
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

type NoteLookupApp = {
	vault: {
		adapter: ListableAdapter;
	};
};

export interface ExistingKeepNoteIndex {
	pathByKeepUrl: Map<string, string>;
	existingPaths: Set<string>;
	ambiguousKeepUrls?: Set<string>;
	plannedPathIdentities?: Map<string, string>;
}

function indexIdentity(index: ExistingKeepNoteIndex, url: string, path: string): void {
	const identity = normalizeKeepNoteUrl(url);
	const previous = index.pathByKeepUrl.get(identity);
	if (previous && previous !== path) (index.ambiguousKeepUrls ??= new Set()).add(identity);
	else index.pathByKeepUrl.set(identity, path);
}

/** A content comparison cannot protect a path that already belongs to another note. */
export function assertKeepNoteIdentity(incomingNote: NormalizedNote, content: string): void {
	const identity = canonicalKeepUrl(getFrontmatterStringValue(incomingNote.frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY));
	if (!identity) return;
	const [, , properties] = extractFrontmatter(content);
	if (canonicalKeepUrl(getFrontmatterStringValue(properties, FRONTMATTER_GOOGLE_KEEP_URL_KEY)) !== identity)
		throw new Error("Keep identity changed after lookup. The local file was preserved; sync again after resolving its identity.");
}

function normalizeVaultPathForScope(path: string): string {
	return normalizePathSafe(path).replace(/^\/+/, "").replace(/\/+$/, "");
}

async function folderIsProvenAbsent(adapter: ListableAdapter, folder: string): Promise<boolean> {
	let candidate = folder;
	while (candidate && adapter.list) {
		const separator = candidate.lastIndexOf("/");
		const parent = separator < 0 ? "" : candidate.slice(0, separator);
		try {
			const inventory = await adapter.list(parent);
			return ![...inventory.files, ...inventory.folders].some((entry) => {
				const path = normalizeVaultPathForScope(entry);
				return path === candidate || path.startsWith(`${candidate}/`);
			});
		} catch {
			candidate = parent;
		}
	}
	return false;
}

export async function listMarkdownFilesRecursively(
	adapter: ListableAdapter,
	folder = "",
	strict = false
): Promise<string[]> {
	const normalizedFolder = normalizePathSafe(folder);
	if (typeof adapter.list !== "function") {
		if (strict) throw new Error("Enrichment vault listing is unavailable.");
		return [];
	}

	let listed = false;
	try {
		const { files, folders } = await adapter.list(normalizedFolder);
		listed = true;
		const markdownFiles = files
			.map((file) => normalizePathSafe(file))
			.filter((file) => file.toLowerCase().endsWith(".md"));

		for (const subfolder of folders) {
			const nested = await listMarkdownFilesRecursively(adapter, subfolder, strict);
			markdownFiles.push(...nested);
		}

		return markdownFiles;
	} catch (error) {
		// A paid admission must distinguish a missing destination from a failed
		// scan. Only a readable ancestor inventory can prove a folder absent.
		if (strict && (listed || !(await folderIsProvenAbsent(adapter, normalizeVaultPathForScope(normalizedFolder)))))
			throw error;
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
	app: NoteLookupApp,
	rootFolder = ""
): Promise<ExistingKeepNoteIndex> {
	const adapter = app.vault.adapter;
	const normalizedRootFolder = normalizeVaultPathForScope(resolveNoteLookupRoot(rootFolder));
	// Neither cached metadata nor a failed scan proves that an identity is absent.
	// Use one physical, complete discovery path for admission and all import modes.
	const markdownFiles = await listMarkdownFilesRecursively(adapter, normalizedRootFolder, true);
	const existingPaths = new Set(markdownFiles.map((filePath) => normalizePathSafe(filePath)));
	const pathByKeepUrl = new Map<string, string>();
	const index = { pathByKeepUrl, existingPaths, ambiguousKeepUrls: new Set<string>() };

	for (const filePath of existingPaths) {
		if (filePath.includes(CONFLICT_FILE_SUFFIX)) continue;
		const content = await adapter.read(filePath);
		const [, , frontmatterDict] = extractFrontmatter(content, true);
		const existingKeepUrl = getFrontmatterStringValue(frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY);
		if (existingKeepUrl) indexIdentity(index, existingKeepUrl, filePath);
	}

	return index;
}

export function updateExistingKeepNoteIndex(
	index: ExistingKeepNoteIndex,
	filePath: string,
	incomingNote: NormalizedNote
): void {
	const normalizedPath = normalizePathSafe(filePath);
	index.existingPaths.add(normalizedPath);
	const incomingKeepUrl = getFrontmatterStringValue(incomingNote.frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY);
	// A conflict copy shares the original's metadata, but is never its canonical download target.
	if (incomingKeepUrl && !normalizedPath.includes(CONFLICT_FILE_SUFFIX)) {
		index.pathByKeepUrl.set(normalizeKeepNoteUrl(incomingKeepUrl), normalizedPath);
	}
}

/** A filename match never proves that two Google Keep notes are the same note. */
async function resolveIdentitySafePath(
	adapter: ListableAdapter,
	preferredPath: string,
	incomingKeepUrl: string | undefined,
	index?: ExistingKeepNoteIndex
): Promise<string> {
	const identity = canonicalKeepUrl(incomingKeepUrl);
	if (!identity) return preferredPath;
	const exists = async (path: string) => index?.existingPaths.has(path) || (await adapter.exists?.(path)) || false;
	const matches = async (path: string) => {
		const [, , properties] = extractFrontmatter(await adapter.read(path));
		return canonicalKeepUrl(getFrontmatterStringValue(properties, FRONTMATTER_GOOGLE_KEEP_URL_KEY)) === identity;
	};
	// Reservations stay separate from files that exist on disk. Parallel planners can
	// await the same vacant path, so claim it only after rechecking its owner.
	const claims = index ? (index.plannedPathIdentities ??= new Map<string, string>()) : new Map<string, string>();
	const claim = async (path: string): Promise<boolean> => {
		const owner = claims.get(path);
		if (owner && owner !== identity) return false;
		if ((await exists(path)) && !(await matches(path))) return false;
		const currentOwner = claims.get(path);
		if (currentOwner && currentOwner !== identity) return false;
		claims.set(path, identity);
		return true;
	};
	if (await claim(preferredPath)) return preferredPath;

	const separator = preferredPath.lastIndexOf("/");
	const directory = preferredPath.slice(0, separator + 1);
	let stem = preferredPath.slice(separator + 1).replace(/\.md$/i, "");
	// Leave room for the full identity hash and collision counter, including UTF-8 titles.
	const encoder = new TextEncoder();
	while (encoder.encode(stem).length > 160) stem = Array.from(stem).slice(0, -1).join("");
	const suffix = await sha256(identity);
	for (let counter = 1; counter <= 1000; counter++) {
		const candidate = `${directory}${stem || "Keep note"}--keep-${suffix}${counter === 1 ? "" : `-${counter}`}.md`;
		if (await claim(candidate)) return candidate;
	}
	throw new Error("Unable to allocate a separate filename for a distinct Google Keep identity.");
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
	if (incomingKeepUrl && !index) index = await buildExistingKeepNoteIndex(app, rootFolder);

	// A renamed linked note takes precedence over a different note with the expected filename.
	if (incomingKeepUrl && index) {
		if (index.ambiguousKeepUrls?.has(normalizeKeepNoteUrl(incomingKeepUrl)))
			throw new Error("Multiple local notes share a Keep identity. Resolve them before importing.");
		const linkedPath =
			index.pathByKeepUrl.get(normalizeKeepNoteUrl(incomingKeepUrl)) ?? index.pathByKeepUrl.get(incomingKeepUrl);
		if (linkedPath) {
			assertKeepNoteIdentity(incomingNote, await adapter.read(linkedPath));
			return linkedPath;
		}
	}

	if (normalizedPreferredPath) {
		return resolveIdentitySafePath(adapter, normalizedPreferredPath, incomingKeepUrl, index);
	}

	return null;
}
