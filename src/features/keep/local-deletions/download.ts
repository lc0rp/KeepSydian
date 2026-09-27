import type KeepSidianPlugin from "@app/main";
import type { SyncPlanEntry } from "@types";
import { extractFrontmatter, normalizeNote, type PreNormalizedNote } from "../domain/note";
import { stripManagedImageEmbeds } from "../domain/attachmentEmbeds";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { contentKeepIdentity } from "./scan";
import { getDeletionLedger } from "./ledger";

export class StaleDownloadReviewError extends Error {
	constructor() {
		super("A previously up-to-date note changed after review. Refresh the download review before completing it. No new tracking baseline or successful-sync checkpoint was saved for this attempt.");
		this.name = "StaleDownloadReviewError";
	}
}

/** Recheck folder membership at the write boundary, including offline changes. */
export async function assertDownloadIdentityPresentOrUntracked(plugin: KeepSidianPlugin, note: PreNormalizedNote): Promise<void> {
	const ledger = getDeletionLedger(plugin);
	if (!ledger) return;
	const keepUrl = canonicalKeepUrl(normalizeNote(note).frontmatterDict.GoogleKeepUrl);
	if (!keepUrl) return;
	const record = (await ledger.records()).find((item) => item.keepUrl === keepUrl);
	if (!record) return;
	try {
		const content = await plugin.app.vault.adapter.read(record.path);
		if (contentKeepIdentity(content) === keepUrl) return;
	} catch { /* An in-folder rename may still contain the identity. */ }
	const scan = await ledger.scan();
	plugin.throwIfSyncCancelled?.();
	if (!scan.complete || !scan.identities.get(keepUrl)?.length) {
		throw new Error("A previously synced note is no longer in the sync folder. Review its removal in Sync Center; this download will not recreate it.");
	}
}

/**
 * Recheck identical rows before enrolling their snapshot receipts. Unchecked
 * actionable rows and conflict copies receive no new baseline. Selection may
 * be partial; the separate folder inventory must still be complete and stable.
 */
export async function stageIdenticalDownloadReceipts(
	plugin: KeepSidianPlugin,
	notes: readonly PreNormalizedNote[],
	entryIds: readonly string[],
	entries: readonly SyncPlanEntry[]
): Promise<void> {
	const ledger = getDeletionLedger(plugin);
	if (!ledger) return;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	for (const [index, note] of notes.entries()) {
		const entry = byId.get(entryIds[index]);
		if (!entry || entry.selectable || entry.action !== "skipped-identical") continue;
		plugin.throwIfSyncCancelled?.();
		const normalized = normalizeNote(note);
		const keepUrl = canonicalKeepUrl(normalized.frontmatterDict.GoogleKeepUrl);
		if (!keepUrl) continue;
		let content: string;
		try { content = await plugin.app.vault.adapter.read(entry.path); }
		catch { throw new StaleDownloadReviewError(); }
		if (contentKeepIdentity(content) !== keepUrl) throw new StaleDownloadReviewError();
		// Duplicate decisions can skip differing bodies based on timestamps. A
		// receipt needs actual content equality, even when an edit preserved mtime.
		const [, body] = extractFrontmatter(content);
		if (stripManagedImageEmbeds(body) !== normalized.textWithoutFrontmatter) throw new StaleDownloadReviewError();
		ledger.stageDownload(note, entry.path);
	}
}
