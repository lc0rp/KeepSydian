import type KeepSidianPlugin from "@app/main";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { extractFrontmatter } from "../domain/note";
import { isSafeVaultPath, sha256 } from "./state";

export const MAX_SCAN_FILES = 50_000;
export const MAX_SCAN_FOLDERS = 10_000;
export const MAX_SCAN_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SCAN_TOTAL_BYTES = 256 * 1024 * 1024;

export interface CompleteIdentityScan {
	complete: true;
	paths: ReadonlySet<string>;
	identities: ReadonlyMap<string, readonly string[]>;
	generation: number;
	fingerprint: string;
}
export interface IncompleteIdentityScan { complete: false; reason: string; }
export type IdentityScan = CompleteIdentityScan | IncompleteIdentityScan;

interface InventoryFile { path: string; size: number; mtime: number; ctime: number; }

function isTrashPath(path: string): boolean {
	return path.split("/")[0]?.toLowerCase() === ".trash";
}

function sameStat(a: InventoryFile, b: InventoryFile): boolean {
	return a.path === b.path && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
}

export function contentKeepIdentity(content: string): string | undefined {
	const [, , properties] = extractFrontmatter(content);
	return canonicalKeepUrl(properties.GoogleKeepUrl);
}

/**
 * This is NOT the upload collector. Enumerate the entire vault through the
 * adapter, including hidden folders and non-Markdown extensions. A renamed note
 * must remain visible even outside the configured sync folder. Only Obsidian's
 * recoverable .trash and this ledger's exact metadata file are excluded.
 *
 * All reads are local and transient. Retain paths/identities only, never bodies.
 * Unsupported/unreadable/oversize files or unstable inventories fail closed.
 */
export async function scanLocalIdentities(
	plugin: KeepSidianPlugin,
	metadataPath: string,
	getGeneration: () => number
): Promise<IdentityScan> {
	try {
		const vault = plugin.app.vault;
		const adapter = vault.adapter;
		if (typeof adapter.list !== "function" || typeof adapter.stat !== "function" ||
			typeof adapter.read !== "function" || typeof vault.getFiles !== "function") {
			throw new Error("The vault adapter cannot prove a complete identity scan.");
		}
		const generation = getGeneration();
		const inventory = async (): Promise<InventoryFile[]> => {
			const folders = [""];
			const seen = new Set<string>([""]);
			const files: InventoryFile[] = [];
			let totalBytes = 0;
			let folderCount = 0;
			while (folders.length) {
				plugin.throwIfSyncCancelled?.();
				const parent = folders.pop()!;
				if (++folderCount > MAX_SCAN_FOLDERS) throw new Error("Identity scan exceeded its folder limit.");
				const listing = await adapter.list(parent);
				if (!listing || !Array.isArray(listing.files) || !Array.isArray(listing.folders)) throw new Error("Incomplete vault listing.");
				for (const [paths, folder] of [[listing.files, false], [listing.folders, true]] as const) {
					for (const path of paths) {
						if (typeof path !== "string" || !isSafeVaultPath(path) ||
							(parent !== "" && !path.startsWith(`${parent}/`)) ||
							path.slice(parent.length + (parent ? 1 : 0)).includes("/") || seen.has(path)) {
							throw new Error("Ambiguous or incomplete vault listing.");
						}
						seen.add(path);
						if (isTrashPath(path) || path === metadataPath) continue;
						const stat = await adapter.stat(path);
						if (!stat || stat.type !== (folder ? "folder" : "file")) throw new Error("A vault item changed during the scan.");
						if (folder) { folders.push(path); continue; }
						if (!Number.isFinite(stat.size) || stat.size < 0 || stat.size > MAX_SCAN_FILE_BYTES ||
							!Number.isFinite(stat.mtime) || !Number.isFinite(stat.ctime)) throw new Error("A vault file cannot be completely scanned.");
						totalBytes += stat.size;
						if (files.length >= MAX_SCAN_FILES || totalBytes > MAX_SCAN_TOTAL_BYTES) throw new Error("Identity scan exceeded its bounded capacity.");
						files.push({ path, size: stat.size, mtime: stat.mtime, ctime: stat.ctime });
					}
				}
			}
			const listed = new Set(files.map((file) => file.path));
			for (const file of vault.getFiles()) {
				if (!isTrashPath(file.path) && file.path !== metadataPath && !listed.has(file.path)) throw new Error("The adapter omitted a loaded vault file.");
			}
			return files.sort((a, b) => a.path.localeCompare(b.path));
		};
		const before = await inventory();
		const identities = new Map<string, string[]>();
		for (const file of before) {
			plugin.throwIfSyncCancelled?.();
			const content = await adapter.read(file.path);
			if (typeof content !== "string" || content.length > MAX_SCAN_FILE_BYTES) throw new Error("A file could not be read completely.");
			const stat = await adapter.stat(file.path);
			if (!stat || stat.type !== "file" || !sameStat(file, { path: file.path, size: stat.size, mtime: stat.mtime, ctime: stat.ctime })) {
				throw new Error("A file changed while its identity was read.");
			}
			const [frontmatter, , properties] = extractFrontmatter(content);
			const keepUrl = canonicalKeepUrl(properties.GoogleKeepUrl);
			if (!keepUrl && /^\s*["']?(?:GoogleKeepUrl|googleKeepUrl|google-keep-url)["']?\s*:/m.test(frontmatter)) {
				throw new Error("A Keep identity is malformed or ambiguous.");
			}
			if (keepUrl) {
				const paths = identities.get(keepUrl) ?? [];
				paths.push(file.path);
				identities.set(keepUrl, paths);
			}
		}
		const after = await inventory();
		if (generation !== getGeneration() || before.length !== after.length || before.some((file, index) => !sameStat(file, after[index]))) {
			throw new Error("The vault changed during the identity scan.");
		}
		const fingerprint = await sha256(JSON.stringify(before));
		plugin.throwIfSyncCancelled?.();
		if (generation !== getGeneration()) throw new Error("The vault changed before scan confirmation.");
		return { complete: true, paths: new Set(before.map((file) => file.path)), identities, generation, fingerprint };
	} catch {
		plugin.throwIfSyncCancelled?.();
		return { complete: false, reason: "Deletion review requires a complete, readable, stable vault scan. No missing note was treated as deleted." };
	}
}
