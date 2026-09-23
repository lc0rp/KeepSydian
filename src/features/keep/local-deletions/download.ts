import type KeepSidianPlugin from "@app/main";
import type { SyncPlanEntry } from "@types";
import { normalizeNote, type PreNormalizedNote } from "../domain/note";
import { handleDuplicateNotes } from "../domain/compare";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { contentKeepIdentity } from "./scan";
import { getDeletionLedger } from "./ledger";

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
		const content = await plugin.app.vault.adapter.read(entry.path);
		if (contentKeepIdentity(content) !== keepUrl) continue;
		if (await handleDuplicateNotes(plugin.settings.saveLocation, normalized, plugin.app, entry.path) !== "skip") continue;
		ledger.stageDownload(note, entry.path);
	}
}
