import type KeepSidianPlugin from "@app/main";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { resolveLogBaseFolder } from "@services/note-path-resolver";
import { normalizePathSafe } from "@services/paths";
import { extractFrontmatter } from "../domain/note";
import { deletionScope, isSafeVaultPath, isWithinScope, sha256 } from "./state";

export const MAX_SCAN_FILES = 50_000;
export const MAX_SCAN_FOLDERS = 10_000;
export const MAX_SCAN_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SCAN_TOTAL_BYTES = 256 * 1024 * 1024;

export interface CompleteIdentityScan {
	complete: true;
	scope: string;
	paths: ReadonlySet<string>;
	identities: ReadonlyMap<string, readonly string[]>;
	generation: number;
	fingerprint: string;
}
export interface IncompleteIdentityScan { complete: false; reason: string; }
export type IdentityScan = CompleteIdentityScan | IncompleteIdentityScan;
interface InventoryItem { path: string; size: number; mtime: number; ctime: number; }
interface Inventory { files: InventoryItem[]; folders: InventoryItem[]; }

class ScanFailure extends Error {
	constructor(readonly category: string) { super(category); }
}

/** Match the logger's resolved directory, including its vault-root default. */
export function resolveMembershipLogFolder(plugin: KeepSidianPlugin): string {
	return normalizePathSafe(`${resolveLogBaseFolder(plugin.app, plugin.settings)}/_KeepSidianLogs`);
}

/** Exclude only root Trash, our index and the exact owned log subtree. */
export function isActiveMembershipPath(path: string, scope: string, metadataPath: string, logFolder: string): boolean {
	return isWithinScope(path, scope) && path !== metadataPath && path.split("/")[0]?.toLowerCase() !== ".trash" &&
		path !== logFolder && !path.startsWith(`${logFolder}/`);
}

function sameStat(a: InventoryItem, b: InventoryItem): boolean {
	return a.path === b.path && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
}

export function contentKeepIdentity(content: string): string | undefined {
	const [, , properties] = extractFrontmatter(content);
	return canonicalKeepUrl(properties.GoogleKeepUrl);
}

/**
 * Inventory the configured folder recursively, including hidden/non-Markdown
 * members. Optional download filters never constrain membership. Files outside
 * this folder are neither read nor changed. Events are instability hints only;
 * offline changes are detected through the next complete inventory.
 */
export async function scanLocalIdentities(
	plugin: KeepSidianPlugin,
	metadataPath: string,
	getGeneration: () => number,
	scope = deletionScope(plugin.settings.saveLocation)
): Promise<IdentityScan> {
	try {
		const vault = plugin.app.vault;
		const adapter = vault.adapter;
		const logFolder = resolveMembershipLogFolder(plugin);
		if (typeof adapter.list !== "function" || typeof adapter.stat !== "function" ||
			typeof adapter.read !== "function" || typeof vault.getFiles !== "function") throw new ScanFailure("adapter-capability");
		const generation = getGeneration();
		const assertScope = () => {
			plugin.throwIfSyncCancelled?.();
			if (scope !== deletionScope(plugin.settings.saveLocation)) throw new ScanFailure("scope-changed");
		};
		const inventory = async (): Promise<Inventory> => {
			const pending = [scope];
			const seen = new Set<string>([scope]);
			const files: InventoryItem[] = [];
			const folders: InventoryItem[] = [];
			let totalBytes = 0;
			while (pending.length) {
				assertScope();
				const parent = pending.pop()!;
				if (folders.length >= MAX_SCAN_FOLDERS) throw new ScanFailure("folder-limit");
				const parentStat = await adapter.stat(parent);
				if (!parentStat || parentStat.type !== "folder" || !Number.isFinite(parentStat.mtime) || !Number.isFinite(parentStat.ctime)) {
					throw new ScanFailure("folder-unavailable");
				}
				folders.push({ path: parent, size: 0, mtime: parentStat.mtime, ctime: parentStat.ctime });
				const listing = await adapter.list(parent);
				if (!listing || !Array.isArray(listing.files) || !Array.isArray(listing.folders)) throw new ScanFailure("listing-shape");
				for (const [paths, folder] of [[listing.files, false], [listing.folders, true]] as const) {
					for (const path of paths) {
						if (typeof path !== "string" || !isSafeVaultPath(path) || !isWithinScope(path, scope) ||
							(parent !== "" && !path.startsWith(`${parent}/`)) ||
							path.slice(parent.length + (parent ? 1 : 0)).includes("/") || seen.has(path)) throw new ScanFailure("listing-path");
						seen.add(path);
						if (!isActiveMembershipPath(path, scope, metadataPath, logFolder)) continue;
						const stat = await adapter.stat(path);
						if (!stat || stat.type !== (folder ? "folder" : "file")) throw new ScanFailure("item-changed");
						if (folder) { pending.push(path); continue; }
						if (!Number.isFinite(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtime) || !Number.isFinite(stat.ctime)) throw new ScanFailure("invalid-stat");
						if (stat.size > MAX_SCAN_FILE_BYTES) throw new ScanFailure("file-size-limit");
						totalBytes += stat.size;
						if (files.length >= MAX_SCAN_FILES || totalBytes > MAX_SCAN_TOTAL_BYTES) throw new ScanFailure("inventory-limit");
						files.push({ path, size: stat.size, mtime: stat.mtime, ctime: stat.ctime });
					}
				}
			}
			const listed = new Set(files.map((file) => file.path));
			for (const file of vault.getFiles()) {
				if (isActiveMembershipPath(file.path, scope, metadataPath, logFolder) && !listed.has(file.path)) throw new ScanFailure("loaded-file-omitted");
			}
			return { files: files.sort((a, b) => a.path.localeCompare(b.path)), folders: folders.sort((a, b) => a.path.localeCompare(b.path)) };
		};
		assertScope();
		const before = await inventory();
		const identities = new Map<string, string[]>();
		for (const file of before.files) {
			assertScope();
			const content = await adapter.read(file.path);
			if (typeof content !== "string" || content.length > MAX_SCAN_FILE_BYTES) throw new ScanFailure("incomplete-read");
			const stat = await adapter.stat(file.path);
			if (!stat || stat.type !== "file" || !sameStat(file, { path: file.path, size: stat.size, mtime: stat.mtime, ctime: stat.ctime })) throw new ScanFailure("file-changed");
			const [frontmatter, , properties] = extractFrontmatter(content);
			const keepUrl = canonicalKeepUrl(properties.GoogleKeepUrl);
			if (!keepUrl && /^\s*["']?(?:GoogleKeepUrl|googleKeepUrl|google-keep-url)["']?\s*:/m.test(frontmatter)) throw new ScanFailure("malformed-identity");
			const aliases = ["GoogleKeepUrl", "googleKeepUrl", "google-keep-url"].filter((key) => key in properties);
			if (aliases.some((key) => canonicalKeepUrl(properties[key]) !== keepUrl)) throw new ScanFailure("ambiguous-identity");
			if (keepUrl) identities.set(keepUrl, [...(identities.get(keepUrl) ?? []), file.path]);
		}
		const after = await inventory();
		for (const key of ["files", "folders"] as const) {
			if (before[key].length !== after[key].length || before[key].some((item, index) => !sameStat(item, after[key][index]))) throw new ScanFailure("inventory-changed");
		}
		const fingerprint = await sha256(JSON.stringify(before));
		assertScope();
		if (generation !== getGeneration()) throw new ScanFailure("generation-changed");
		return { complete: true, scope, paths: new Set(before.files.map((file) => file.path)), identities, generation, fingerprint };
	} catch (error) {
		plugin.throwIfSyncCancelled?.();
		const category = error instanceof ScanFailure ? error.category : "read-or-adapter-failure";
		return { complete: false, reason: `Sync folder membership could not be verified (${category}). A complete, readable, stable recursive scan is required. No removal was proposed.` };
	}
}
