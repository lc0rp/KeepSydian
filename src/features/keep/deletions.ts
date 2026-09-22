import { TFile } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import type { SyncPlanEntry } from "@types";
import type { SyncCallbacks } from "./sync";
import { logSync } from "@app/logging";
import { normalizePathSafe } from "@services/paths";
import { canonicalKeepUrl, fetchDeletedKeepUrls } from "@integrations/server/keepDeletions";
import { extractFrontmatter, getFrontmatterStringValue } from "./domain/note";
import {
	CONFLICT_FILE_SUFFIX,
	FRONTMATTER_GOOGLE_KEEP_URL_KEY,
	FRONTMATTER_KEEP_SIDIAN_LAST_SYNCED_DATE_KEY,
} from "./constants";

interface DeletionCandidate {
	entryId: string;
	path: string;
	keepUrl: string;
	content: string;
	file: TFile;
}

export interface PreparedDeletions {
	accountEmail: string;
	rootFolder: string;
	entries: SyncPlanEntry[];
	candidates: DeletionCandidate[];
}

function rootFolder(plugin: KeepSidianPlugin): string {
	return normalizePathSafe(plugin.settings.saveLocation).replace(/^\/+|\/+$/g, "");
}

function accountEmail(plugin: KeepSidianPlugin): string {
	return plugin.settings.email.trim().toLowerCase();
}

function isInScope(path: string, root: string): boolean {
	return (!root || path.startsWith(`${root}/`)) &&
		!path.split("/").some((part) => part.startsWith(".") || part === "_KeepSidianLogs") &&
		!path.includes(CONFLICT_FILE_SUFFIX);
}

function syncedKeepUrl(content: string): string | undefined {
	const [, , frontmatter] = extractFrontmatter(content);
	const synced = getFrontmatterStringValue(frontmatter, FRONTMATTER_KEEP_SIDIAN_LAST_SYNCED_DATE_KEY);
	if (!synced || Number.isNaN(Date.parse(synced))) return undefined;
	return canonicalKeepUrl(getFrontmatterStringValue(frontmatter, FRONTMATTER_GOOGLE_KEEP_URL_KEY));
}

/** Manual review only. A missing remote note or matching filename is never evidence. */
export async function buildDeletionPlan(plugin: KeepSidianPlugin): Promise<PreparedDeletions> {
	const prepared: PreparedDeletions = {
		accountEmail: accountEmail(plugin),
		rootFolder: rootFolder(plugin),
		entries: [],
		candidates: [],
	};
	const byUrl = new Map<string, DeletionCandidate[]>();
	for (const file of plugin.app.vault.getMarkdownFiles?.() ?? []) {
		plugin.throwIfSyncCancelled?.();
		const path = normalizePathSafe(file.path);
		if (!isInScope(path, prepared.rootFolder)) continue;
		const content = await plugin.app.vault.read(file);
		const keepUrl = syncedKeepUrl(content);
		if (!keepUrl) continue;
		const candidates = byUrl.get(keepUrl) ?? [];
		candidates.push({ entryId: `delete:${path}`, path, keepUrl, content, file });
		byUrl.set(keepUrl, candidates);
	}
	if (!byUrl.size) return prepared;

	const deletedUrls = await fetchDeletedKeepUrls(plugin.settings.email, plugin.settings.token);
	plugin.throwIfSyncCancelled?.();
	if (accountEmail(plugin) !== prepared.accountEmail || rootFolder(plugin) !== prepared.rootFolder) {
		throw new Error("Download account or folder changed. Prepare the sync plan again.");
	}
	for (const [url, candidates] of byUrl) {
		// Duplicate local identities may represent deliberate copies. Never guess.
		if (!deletedUrls.has(url) || candidates.length !== 1) continue;
		const candidate = candidates[0];
		prepared.candidates.push(candidate);
		prepared.entries.push({
			id: candidate.entryId,
			mode: "import",
			stage: "import",
			title: candidate.file.basename,
			path: candidate.path,
			action: "delete",
			label: "Delete from Obsidian",
			selectable: true,
			selected: true,
			selectionLocked: false,
			meta: { detail: "Deleted in Google Keep. Move this previously synced note to Obsidian's .trash folder. Uncheck to keep it. Attachments are retained." },
		});
	}
	return prepared;
}

/** Revalidate all selected deletions before any are applied, then check locally again per file. */
export async function executeReviewedDeletions(
	plugin: KeepSidianPlugin,
	prepared: PreparedDeletions | undefined,
	selectedEntryIds: Set<string>,
	callbacks?: SyncCallbacks
): Promise<number> {
	if (!prepared) return 0;
	const selected = prepared.candidates.filter((candidate) => selectedEntryIds.has(candidate.entryId));
	if (!selected.length) return 0;
	const checkContext = () => {
		plugin.throwIfSyncCancelled?.();
		if (accountEmail(plugin) !== prepared.accountEmail || rootFolder(plugin) !== prepared.rootFolder) {
			throw new Error("Download account or folder changed. Prepare the sync plan again before deleting notes.");
		}
	};
	checkContext();
	const deletedUrls = await fetchDeletedKeepUrls(plugin.settings.email, plugin.settings.token);
	const checkCandidate = async (candidate: DeletionCandidate): Promise<TFile> => {
		checkContext();
		if (!deletedUrls.has(candidate.keepUrl)) {
			throw new Error("A selected note is no longer reported as deleted in Google Keep. Prepare the sync plan again.");
		}
		const file = plugin.app.vault.getAbstractFileByPath(candidate.path);
		if (!(file instanceof TFile) || file !== candidate.file || await plugin.app.vault.read(file) !== candidate.content) {
			throw new Error("A note selected for deletion changed or moved after review. Prepare the sync plan again.");
		}
		return file;
	};
	try {
		for (const candidate of selected) await checkCandidate(candidate);
	} catch (error) {
		for (const candidate of selected) callbacks?.onEntrySettled?.(candidate.entryId, false);
		throw error;
	}
	let deleted = 0;
	for (const candidate of selected) {
		try {
			const file = await checkCandidate(candidate);
			checkContext();
			// Use recoverable local trash on every platform. Never remove attachments
			// or fall back to permanent deletion if the trash operation fails.
			await plugin.app.vault.trash(file, false);
			deleted += 1;
			callbacks?.onEntrySettled?.(candidate.entryId, true);
			callbacks?.reportProgress?.();
			await logSync(plugin, `Deleted from Obsidian (moved to .trash): ${candidate.path}`);
		} catch (error) {
			callbacks?.onEntrySettled?.(candidate.entryId, false);
			throw error;
		}
	}
	return deleted;
}
