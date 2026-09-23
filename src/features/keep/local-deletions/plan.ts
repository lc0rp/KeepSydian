import type KeepSidianPlugin from "@app/main";
import type { SyncPlanEntry } from "@types";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { MAX_TRASH_BATCH, requestKeepTrash, type KeepTrashStatus } from "@integrations/server/keepTrash";
import { normalizeNote, type PreNormalizedNote } from "../domain/note";
import type { SyncCallbacks } from "../sync";
import { getDeletionLedger, type LocalDeletionLedger } from "./ledger";
import { isWithinScope, type LocalDeletionRecord } from "./state";
import { contentKeepIdentity, type IdentityScan } from "./scan";

export interface LocalDeletionCandidate { entryId: string; record: LocalDeletionRecord; acknowledged?: boolean; }
export interface PreparedLocalDeletions {
	account?: string;
	scope?: string;
	entries: SyncPlanEntry[];
	candidates: LocalDeletionCandidate[];
	protectedKeepUrls: Set<string>;
	hasBlockingConflicts: boolean;
}

function emptyPlan(): PreparedLocalDeletions {
	return { entries: [], candidates: [], protectedKeepUrls: new Set(), hasBlockingConflicts: false };
}

function blockedEntry(id: string, path: string, title: string, detail: string): SyncPlanEntry {
	return { id, path, title, mode: "push", stage: "upload", action: "skipped-conflict", label: "Deletion not verified",
		selectable: false, selected: false, selectionLocked: false, meta: { detail } };
}

function protectedIdentities(records: LocalDeletionRecord[], scan: IdentityScan): Set<string> {
	return new Set(records.filter((record) => !scan.complete || !(scan.identities.get(record.keepUrl)?.length)).map((record) => record.keepUrl));
}

/** Protect all known missing identities, including unchecked and unverified ones. */
export async function getLocalDeletionProtection(plugin: KeepSidianPlugin): Promise<Set<string>> {
	const ledger = getDeletionLedger(plugin);
	if (!ledger) return new Set();
	const uncertain: LocalDeletionRecord[] = [];
	for (const record of await ledger.records()) {
		plugin.throwIfSyncCancelled?.();
		try {
			if (contentKeepIdentity(await plugin.app.vault.adapter.read(record.path)) === record.keepUrl) continue;
		} catch { /* A missing path may still be a move; scan outside the sync folder. */ }
		uncertain.push(record);
	}
	if (!uncertain.length) return new Set();
	const scan = await ledger.scan();
	plugin.throwIfSyncCancelled?.();
	return protectedIdentities(uncertain, scan);
}

export function downloadedKeepIdentity(note: PreNormalizedNote | undefined): string | undefined {
	return note ? canonicalKeepUrl(normalizeNote(note).frontmatterDict.GoogleKeepUrl) : undefined;
}

export async function assertNoUnreviewedLocalDeletions(plugin: KeepSidianPlugin): Promise<void> {
	if ((await getLocalDeletionProtection(plugin)).size) {
		throw new Error("Known local removals require review in Sync Center. Automatic download was stopped to avoid recreating those notes.");
	}
}

export async function buildLocalDeletionPlan(
	plugin: KeepSidianPlugin,
	allowPerNoteSelection = true,
	selectionLockedReason?: string
): Promise<PreparedLocalDeletions> {
	const prepared = emptyPlan();
	const ledger = getDeletionLedger(plugin);
	if (!ledger) return prepared;
	try {
		const context = await ledger.context();
		prepared.account = context.account;
		prepared.scope = context.scope;
		const records = await ledger.records();
		if (!records.length) return prepared;
		const scan = await ledger.scan();
		plugin.throwIfSyncCancelled?.();
		prepared.protectedKeepUrls = protectedIdentities(records, scan);
		if (!scan.complete) {
			prepared.entries.push(blockedEntry("upload-deletions:incomplete-scan", "", "Local deletion review unavailable", scan.reason));
			prepared.hasBlockingConflicts = true;
			return prepared;
		}
		for (const record of records) {
			// Presence anywhere, even outside the sync folder or under another
			// extension, defeats deletion. An occupied original path also blocks it.
			if (scan.identities.get(record.keepUrl)?.length || scan.paths.has(record.path)) continue;
			const entryId = `upload-delete:${record.keepUrl}:${record.generation}`;
			if (record.state !== "tombstone" || !record.witness || record.scope !== context.scope || !isWithinScope(record.path, context.scope)) {
				prepared.entries.push(blockedEntry(entryId, record.path, record.path.split("/").pop() ?? "Local note",
					"This absence has no eligible explicit Obsidian deletion witness in the current sync folder. Moves, offline removals and scope changes are not deletions."));
				prepared.hasBlockingConflicts = true;
				continue;
			}
			prepared.candidates.push({ entryId, record });
		}
		for (let offset = 0; offset < prepared.candidates.length; offset += MAX_TRASH_BATCH) {
			const batch = prepared.candidates.slice(offset, offset + MAX_TRASH_BATCH);
			const results = await requestKeepTrash(plugin.settings.email, plugin.settings.token,
				batch.map(({ record }) => ({ keep_url: record.keepUrl, expected_revision: record.revision })));
			await assertContext(plugin, ledger, prepared);
			const byUrl = new Map(results.map((result) => [result.keep_url, result.status]));
			for (const candidate of batch) {
				const status = byUrl.get(candidate.record.keepUrl)!;
				const eligible = status === "ready" || status === "already_trashed";
				const entry = blockedEntry(candidate.entryId, candidate.record.path,
					candidate.record.path.split("/").pop()?.replace(/\.md$/i, "") ?? "Local note", statusDetail(status));
				if (eligible) {
					entry.action = "delete";
					entry.label = "Delete from Google Keep";
					entry.selectable = true;
					entry.selected = true;
					entry.selectionLocked = !allowPerNoteSelection;
					entry.selectionLockedReason = allowPerNoteSelection ? undefined : selectionLockedReason;
				} else {
					entry.label = status === "conflict" ? "Deletion conflict" : "Deletion not verified";
					prepared.hasBlockingConflicts = true;
				}
				prepared.entries.push(entry);
			}
		}
		return prepared;
	} catch {
		plugin.throwIfSyncCancelled?.();
		// An unavailable contract/ledger is not an empty successful deletion plan.
		prepared.entries = [blockedEntry("upload-deletions:unavailable", "", "Local deletion review unavailable",
			"The identity baseline, complete scan or remote preview could not be verified. No Google Keep deletion is authorized.")];
		prepared.candidates = [];
		prepared.hasBlockingConflicts = true;
		return prepared;
	}
}

function statusDetail(status: KeepTrashStatus): string {
	switch (status) {
		case "ready": return "Move this explicitly deleted local note to Google Keep Trash. No permanent deletion. Uncheck to leave Keep unchanged.";
		case "already_trashed": return "Google Keep already reports this identity in Trash. Selection only acknowledges that confirmed state.";
		case "conflict": return "Google Keep changed since the last completed sync. This note will not be trashed; review the remote change first.";
		case "missing": return "Google Keep did not return this identity. Missing is not proof of Trash, and no fallback delete is allowed.";
		default: return "The current remote revision or trash outcome could not be verified. Keep remains unacknowledged; refresh the plan before retrying.";
	}
}

async function assertContext(plugin: KeepSidianPlugin, ledger: LocalDeletionLedger, prepared: PreparedLocalDeletions): Promise<void> {
	plugin.throwIfSyncCancelled?.();
	await ledger.verify();
	const context = await ledger.context();
	if (context.account !== prepared.account || context.scope !== prepared.scope) throw new Error("The account or sync folder changed. Refresh the upload plan.");
}

async function assertAbsent(plugin: KeepSidianPlugin, ledger: LocalDeletionLedger, candidate: LocalDeletionCandidate): Promise<number> {
	await ledger.assertCurrent(candidate.record);
	const scan = await ledger.scan();
	plugin.throwIfSyncCancelled?.();
	if (!scan.complete || scan.generation !== ledger.generation || scan.paths.has(candidate.record.path) || scan.identities.get(candidate.record.keepUrl)?.length) {
		throw new Error("The local deletion is no longer proven by a complete scan. No Keep trash was authorized.");
	}
	return scan.generation;
}

async function requireUploadPermission(plugin: KeepSidianPlugin): Promise<void> {
	if (typeof plugin.requireTwoWaySafeguards !== "function") throw new Error("Upload safeguards are unavailable. Keep trash is disabled.");
	const gate = await plugin.requireTwoWaySafeguards();
	if (!gate?.allowed) {
		if (gate) plugin.showTwoWaySafeguardNotice?.(gate);
		throw new Error("Upload safeguards must be satisfied before moving notes to Keep Trash.");
	}
}

export async function executeReviewedLocalDeletions(
	plugin: KeepSidianPlugin,
	prepared: PreparedLocalDeletions | undefined,
	selectedEntryIds: ReadonlySet<string>,
	callbacks?: SyncCallbacks
): Promise<number> {
	if (!prepared) return 0;
	const selected = prepared.candidates.filter((candidate) => !candidate.acknowledged && selectedEntryIds.has(candidate.entryId) &&
		prepared.entries.some((entry) => entry.id === candidate.entryId && entry.selectable && entry.action === "delete"));
	if (!selected.length) return 0;
	const ledger = getDeletionLedger(plugin);
	try {
		if (!ledger) throw new Error("The deletion ledger is unavailable. No Google Keep deletion is authorized.");
		await requireUploadPermission(plugin);
		// Validate every selected local witness before the first remote side effect.
		await assertContext(plugin, ledger, prepared);
		for (const candidate of selected) await assertAbsent(plugin, ledger, candidate);
	} catch (error) {
		for (const candidate of selected) callbacks?.onEntrySettled?.(candidate.entryId, false);
		throw error;
	}
	let completed = 0;
	for (const candidate of selected) {
		try {
			await requireUploadPermission(plugin);
			await assertContext(plugin, ledger, prepared);
			const generation = await assertAbsent(plugin, ledger, candidate);
			await assertContext(plugin, ledger, prepared);
			if (generation !== ledger.generation) throw new Error("The vault changed after the deletion scan. Refresh the upload plan.");
			const [result] = await requestKeepTrash(plugin.settings.email, plugin.settings.token,
				[{ keep_url: candidate.record.keepUrl, expected_revision: candidate.record.revision }], true);
			if (result.status !== "trashed" && result.status !== "already_trashed") {
				const entry = prepared.entries.find((item) => item.id === candidate.entryId)!;
				if (result.status === "conflict") {
					entry.action = "skipped-conflict";
					entry.label = "Deletion conflict";
					entry.selected = false;
					entry.selectable = false;
					prepared.hasBlockingConflicts = true;
				}
				if (entry.meta) entry.meta.detail = statusDetail(result.status);
				throw new Error(statusDetail(result.status));
			}
			await assertContext(plugin, ledger, prepared);
			await assertAbsent(plugin, ledger, candidate);
			await ledger.retire(candidate.record);
			candidate.acknowledged = true;
			completed += 1;
			callbacks?.onEntrySettled?.(candidate.entryId, true, "delete");
			callbacks?.reportProgress?.();
		} catch (error) {
			const conflict = prepared.entries.some((entry) => entry.id === candidate.entryId && entry.action === "skipped-conflict");
			callbacks?.onEntrySettled?.(candidate.entryId, false, conflict ? "skipped-conflict" : undefined);
			throw error; // Later candidates remain untouched and retryable.
		}
	}
	return completed;
}
