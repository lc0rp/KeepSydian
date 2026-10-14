import { Notice } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { normalizePathSafe } from "@services/paths";
import { logSync, flushLogSync } from "@app/logging";
import { SyncCancellationError, isSyncCancellationError } from "@app/sync-cancel";
import { buildFrontmatterWithSyncDate, wrapMarkdown } from "./frontmatter";
import { FRONTMATTER_GOOGLE_KEEP_URL_KEY } from "./constants";
import type { SyncCallbacks } from "./sync";
import { collectNotesToPush, assertPendingAttachmentsUnchanged } from "./push/collectNotes";
import { getReviewedPushAction, prepareReviewedUploads, reviewPushNotes, type PushPlanOptions, type ReviewedPushNote } from "./push/merge-review";
import { DEFAULT_MERGE_ACTION } from "./domain/merge-action";
import { localStateBaseline, stampLocalBaseline } from "./domain/local-state";
import { extractFrontmatter } from "./domain/note";
import { bodyBaseline, hasPendingUpload, localKeepKey, stripSyncState, storedRemoteRevision, withRemoteRevision, withSyncState } from "./domain/sync-state";
import { pushNotes as apiPushNotes, PushNotePayload, PushNoteResult } from "@integrations/server/keepApi";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { getDeletionLedger } from "./local-deletions/ledger";
import { getEnrichmentLedger } from "./enrichment/ledger";
import { buildLocalDeletionPlan, type PreparedLocalDeletions } from "./local-deletions/plan";
import type { SyncPlan, SyncPlanEntry } from "@types";
import { safeSyncError } from "@app/sync-attempt";
import { AppError } from "@services/errors";

const SKIPPED_LOG_BATCH_SIZE = 50;
const PUSH_PAYLOAD_BATCH_SIZE = 20;
const NOTE_LOG_BATCH_SIZE = 20;
function throwIfSyncCancelled(plugin: KeepSidianPlugin): void { plugin.throwIfSyncCancelled?.(); }
function mapResultsByPath(results?: PushNoteResult[]): Map<string, PushNoteResult> {
	const map = new Map<string, PushNoteResult>();
	if (results) for (const result of results) if (result?.path) map.set(normalizePathSafe(result.path), result);
	return map;
}
export interface BuiltPushSyncPlan { plan: SyncPlan; notesToPush: ReviewedPushNote[]; localDeletions?: PreparedLocalDeletions; }

function buildPushPlanEntry(note: ReviewedPushNote, index: number, allowPerNoteSelection: boolean, selectionLockedReason?: string): SyncPlanEntry {
	const attachmentCount = note.updatedAttachmentNames.length, missingAttachmentCount = note.missingAttachments.length;
	const detailParts: string[] = [];
	if (attachmentCount > 0) detailParts.push(attachmentCount === 1 ? "Includes 1 updated attachment." : `Includes ${attachmentCount} updated attachments.`);
	if (missingAttachmentCount > 0) detailParts.push(missingAttachmentCount === 1 ? "1 referenced attachment is missing." : `${missingAttachmentCount} referenced attachments are missing.`);
	const action = getReviewedPushAction(note);
	if (hasPendingUpload(note.frontmatter)) detailParts.push("Contains a downloaded merge awaiting a confirmed upload.");
	if (action === "conflict-copy") detailParts.push("Will save a local conflict copy and leave both originals unchanged unless another merge action is chosen.");
	return {
		id: note.planEntryId ?? `upload:${index}:${normalizePathSafe(note.fullPath)}`,
		mode: "push", stage: "upload", title: note.title, path: normalizePathSafe(note.fullPath), action,
		label: action === "conflict-copy" ? "Conflict copy" : action === "merge" ? "Merge" : "Upload",
		selectable: true, selected: true, selectionLocked: !allowPerNoteSelection,
		selectionLockedReason: !allowPerNoteSelection ? selectionLockedReason : undefined,
		meta: { relativePath: note.relativePath, attachmentCount, missingAttachmentCount, missingAttachmentNames: note.missingAttachments, detail: detailParts.join(" ") },
	};
}

export async function buildPushSyncPlan(plugin: KeepSidianPlugin, allowPerNoteSelection = true, selectionLockedReason?: string, options?: PushPlanOptions): Promise<BuiltPushSyncPlan> {
	const collected = options?.forcePaths ? await collectNotesToPush(plugin, options.forcePaths) : await collectNotesToPush(plugin);
	if (options?.reviewMerges && collected.skippedNotes.some((note) => note.reason.startsWith("error:"))) {
		throw new Error("Some local notes could not be read. Fix the vault errors before reviewing uploads.");
	}
	const protectedPaths = new Set((options?.protectedPaths ?? []).map(normalizePathSafe));
	const protectedNotes = collected.notesToPush.filter((note) => protectedPaths.has(normalizePathSafe(note.fullPath)));
	let notesToPush: ReviewedPushNote[] = collected.notesToPush.filter((note) => !protectedPaths.has(normalizePathSafe(note.fullPath)))
		.map((note, index) => ({ ...note, planEntryId: `upload:${index}:${normalizePathSafe(note.fullPath)}` }));
	if (options?.reviewMerges) notesToPush = await reviewPushNotes(plugin, notesToPush);
	const skippedNotes = [...collected.skippedNotes, ...protectedNotes.map((note) => ({ path: note.fullPath, reason: "unresolved-conflict" }))];
	const localDeletions = await buildLocalDeletionPlan(plugin, allowPerNoteSelection, selectionLockedReason);
	const entries: SyncPlanEntry[] = [
		...notesToPush.map((note, index) => buildPushPlanEntry(note, index, allowPerNoteSelection, selectionLockedReason)),
		...localDeletions.entries,
		...skippedNotes.map((skipped, index): SyncPlanEntry => ({
			id: `upload-skipped:${index}:${normalizePathSafe(skipped.path)}`, mode: "push", stage: "upload",
			title: skipped.path.split("/").pop() || skipped.path, path: normalizePathSafe(skipped.path),
			action: skipped.reason === "unresolved-conflict" ? "skipped-conflict" : skipped.reason === "up-to-date" ? "skipped-up-to-date" : "skipped-conflict-copy",
			label: skipped.reason === "unresolved-conflict" ? "Skipped: conflict" : skipped.reason === "up-to-date" ? "Skipped: up to date" : "Skipped: conflict copy",
			selectable: false, selected: false, selectionLocked: false,
			meta: { detail: skipped.reason === "unresolved-conflict" ? "Preserved during download. This run will not upload the unresolved original."
				: skipped.reason === "up-to-date" ? "No changes detected since the last sync." : "Conflict copies are never uploaded." },
		})),
	];
	const counts = entries.reduce<Record<string, number>>((acc, entry) => { acc[entry.label] = (acc[entry.label] ?? 0) + 1; return acc; }, {});
	return {
		plan: { id: `push-plan:${Date.now()}`, mode: "push", stage: "upload", generatedAt: Date.now(), title: "Review upload changes", entries, counts,
			selectedCount: entries.filter((entry) => entry.selectable && entry.selected).length,
			actionableCount: entries.filter((entry) => entry.selectable).length },
		notesToPush,
		localDeletions,
	};
}

export async function pushGoogleKeepNotes(plugin: KeepSidianPlugin, callbacks?: SyncCallbacks, preparedNotes?: ReviewedPushNote[]): Promise<number> {
	try {
		throwIfSyncCancelled(plugin);
		const collected = preparedNotes ? { notesToPush: preparedNotes, skippedNotes: [] } : await collectNotesToPush(plugin);
		let notesToPush: ReviewedPushNote[] = collected.notesToPush;
		if (collected.skippedNotes.length > 0) {
			for (const skipped of collected.skippedNotes) {
				const fileName = skipped.path.split("/").pop() || skipped.path;
				const link = callbacks?.attempt ? `Note (attempt ${callbacks.attempt.id})` : `[${fileName}](${normalizePathSafe(skipped.path)})`;
				await logSync(plugin, `${link} - ${skipped.reason === "up-to-date" ? "up to date (skipped)" : skipped.reason}`, { batchKey: "push:skipped", batchSize: SKIPPED_LOG_BATCH_SIZE });
			}
			await flushLogSync(plugin, { batchKey: "push:skipped" });
		}
		if (notesToPush.length === 0) { new Notice("No Google Keep notes to push."); return 0; }
		callbacks?.setTotalNotes?.(notesToPush.length);
		// A later scheduled/legacy upload must not bypass conflict review for a
		// durable pending merge that originated in the manual Sync Center.
		const mergeAction = callbacks?.mergeAction ?? (notesToPush.some((note) => hasPendingUpload(note.frontmatter)) ? DEFAULT_MERGE_ACTION : undefined);
		if (mergeAction) {
			if (notesToPush.some((note) => !note.mergeReview)) notesToPush = await reviewPushNotes(plugin, notesToPush);
			notesToPush = await prepareReviewedUploads(plugin, notesToPush, mergeAction, callbacks);
		}
		const { email, token } = plugin.settings;
		const supporterKey = plugin.settings.supporterKeyConfigured ? (plugin.settings.supporterKey ?? "") : undefined;
		let successCount = 0;
		let firstFailure: Error | undefined;
		for (let index = 0; index < notesToPush.length; index += PUSH_PAYLOAD_BATCH_SIZE) {
			throwIfSyncCancelled(plugin);
			const batch = notesToPush.slice(index, index + PUSH_PAYLOAD_BATCH_SIZE);
			for (const note of batch) {
				if (plugin.settings.enrichmentLedgerInitialized) await getEnrichmentLedger(plugin).assertUploadAllowed(note.fullPath);
				if ((await plugin.app.vault.adapter.read(note.fullPath)) !== (note.mergeReview?.sourceContent ?? note.content)) throw new Error("A local note changed during upload. Refresh the plan.");
				await assertPendingAttachmentsUnchanged(plugin, note);
				if (note.localState && await localStateBaseline(plugin.app.vault.adapter, note.fullPath, note.mergeReview?.sourceContent ?? note.content) !== note.localState) throw new Error("Local media changed during upload. Refresh the plan.");
			}
			const payloadBatch: PushNotePayload[] = batch.map((note) => {
				const frontmatter = stripSyncState(note.frontmatter);
				return { path: note.relativePath, title: note.title, content: frontmatter === note.frontmatter ? note.content : wrapMarkdown(frontmatter, note.body), attachments: note.attachments.length > 0 ? note.attachments : undefined, expected_revision: note.mergeReview?.remote?.remote_revision ?? storedRemoteRevision(note.frontmatter) };
			});
			// Persist uncertainty before the remote write. Lost acknowledgements
			// must never turn our own AI fields into another paid request.
			if (plugin.settings.enrichmentLedgerInitialized)
				for (const note of batch) await getEnrichmentLedger(plugin).stageUpload(note.fullPath);
			const response = await apiPushNotes(email, token, payloadBatch, supporterKey);
			const resultMap = mapResultsByPath(response?.results), batchKey = "push:notes", batchOptions = { batchKey, batchSize: NOTE_LOG_BATCH_SIZE };
			for (const [batchIndex, note] of batch.entries()) {
				throwIfSyncCancelled(plugin);
				const noteLabel = callbacks?.attempt ? `Note (attempt ${callbacks.attempt.id})` : `[${note.title}](${normalizePathSafe(note.fullPath)})`;
				let pushSucceeded = false;
				const result = resultMap.get(normalizePathSafe(note.relativePath)) ?? resultMap.get(note.relativePath);
				try {
					const pushTimestamp = new Date().toISOString();
					if (result?.success !== true) {
						firstFailure ??= new Error("The server did not confirm an upload");
						await flushLogSync(plugin, { batchKey }); await logSync(plugin, `${noteLabel} - push failed: server rejected upload`); continue;
					}
					if (result?.keep_url) {
						const normalizedKeepUrl = result.keep_url.trim();
						if (normalizedKeepUrl) {
							const keyPrefix = `${FRONTMATTER_GOOGLE_KEEP_URL_KEY}:`;
							const match = note.frontmatter.match(new RegExp(`^${FRONTMATTER_GOOGLE_KEEP_URL_KEY}:\\s*(.*)$`, "m"));
							if (match?.[1]?.trim() !== normalizedKeepUrl) {
								if (match) note.frontmatter = note.frontmatter.replace(new RegExp(`^${FRONTMATTER_GOOGLE_KEEP_URL_KEY}:\\s*.*$`, "m"), `${keyPrefix} ${normalizedKeepUrl}`);
								else note.frontmatter = note.frontmatter ? `${note.frontmatter}\n${keyPrefix} ${normalizedKeepUrl}` : `${keyPrefix} ${normalizedKeepUrl}`;
							}
						}
					}
					// Hash the acknowledged body, not local completion time. If the
					// server transforms it, the next remote read conservatively differs.
					if (result?.remote_updated && Number.isFinite(Date.parse(result.remote_updated))) {
						const line = `GoogleKeepUpdatedDate: ${new Date(result.remote_updated).toISOString()}`;
						note.frontmatter = /^GoogleKeepUpdatedDate:/m.test(note.frontmatter) ? note.frontmatter.replace(/^GoogleKeepUpdatedDate:[^\r\n]*/m, line) : `${note.frontmatter}\n${line}`;
					}
					const baseline = result?.success === true ? await bodyBaseline(localKeepKey(note.frontmatter), note.body) : undefined;
					const frontmatter = withRemoteRevision(withSyncState(buildFrontmatterWithSyncDate(note.frontmatter, pushTimestamp), false, baseline), result?.success === true ? result.remote_revision : undefined);
					await assertPendingAttachmentsUnchanged(plugin, note);
				if (note.localState && await localStateBaseline(plugin.app.vault.adapter, note.fullPath, note.mergeReview?.sourceContent ?? note.content) !== note.localState) throw new Error("Local media changed during upload. Refresh the plan.");
					const currentContent = await plugin.app.vault.adapter.read(note.fullPath);
					if (currentContent !== (note.mergeReview?.sourceContent ?? note.content)) {
						throw new Error("A local note changed while its upload was in flight. Local edits were preserved.");
					}
					// Body, baseline and pending state change together. A failed local
					// write leaves the original pending marker available for retry.
					const acknowledged = await stampLocalBaseline(plugin.app.vault.adapter, note.fullPath, wrapMarkdown(frontmatter, note.body), note.localMedia);
					if (await plugin.app.vault.adapter.read(note.fullPath) !== (note.mergeReview?.sourceContent ?? note.content)) throw new Error("A local note changed while acknowledging its upload. Local edits were preserved.");
					await plugin.app.vault.adapter.write(note.fullPath, acknowledged);
					if (plugin.settings.enrichmentLedgerInitialized) await getEnrichmentLedger(plugin).acknowledgeUpload(note.fullPath, acknowledged, result.enrichment_source);
					getDeletionLedger(plugin)?.stageUpload(
						canonicalKeepUrl(result?.keep_url ?? localKeepKey(frontmatter)),
						normalizePathSafe(note.fullPath),
						result?.success === true && typeof result.remote_revision === "string" ? result.remote_revision : undefined
					);
					const attachmentSuffix = note.updatedAttachmentNames.length > 0 ? ` (updated ${note.updatedAttachmentNames.length === 1 ? "1 attachment" : `${note.updatedAttachmentNames.length} attachments`})` : "";
					await logSync(plugin, `${noteLabel} - pushed${attachmentSuffix}`, batchOptions);
					for (const missing of note.missingAttachments) await logSync(plugin, `${noteLabel} - missing attachment${callbacks?.attempt ? "" : ` ${missing}`}`, batchOptions);
					successCount += 1; pushSucceeded = true;
				} catch (error: unknown) {
					if (error instanceof SyncCancellationError) throw error;
					// A confirmed creation must retain its identity even if newer
					// local note/media edits prevent acknowledgement of its bytes.
					if (result?.success === true && result.keep_url && localKeepKey(`GoogleKeepUrl: ${result.keep_url}`) && !localKeepKey(extractFrontmatter(note.mergeReview?.sourceContent ?? note.content)[0])) {
						try {
							const current = await plugin.app.vault.adapter.read(note.fullPath);
							const [properties, body] = extractFrontmatter(current);
							if (!localKeepKey(properties)) {
								const linked = withRemoteRevision(withSyncState(`${properties}\nGoogleKeepUrl: ${result.keep_url}`, true), result.remote_revision);
								if (await plugin.app.vault.adapter.read(note.fullPath) !== current) throw new Error("Local note changed before linking its confirmed identity.");
								await plugin.app.vault.adapter.write(note.fullPath, wrapMarkdown(linked, body));
							}
						} catch { firstFailure ??= new Error("A confirmed upload could not be linked locally. Refresh Keep before retrying."); }
					}

					firstFailure ??= error instanceof Error ? error : new AppError("unknown", "Upload failed", error);
					await flushLogSync(plugin, { batchKey }); await logSync(plugin, `${noteLabel} - error: ${JSON.stringify(safeSyncError(error))}`);
				} finally {
					const entryId = note.planEntryId ?? `upload:${index + batchIndex}:${normalizePathSafe(note.fullPath)}`;
					if (mergeAction) callbacks?.onEntrySettled?.(entryId, pushSucceeded, note.outcome ?? "upload");
					else callbacks?.onEntrySettled?.(entryId, pushSucceeded);
					callbacks?.reportProgress?.();
				}
			}
			await flushLogSync(plugin, { batchKey: "push:notes" });
		}
		if ((callbacks?.attempt || mergeAction) && firstFailure !== undefined) throw firstFailure;
		throwIfSyncCancelled(plugin);
		new Notice(mergeAction ? "Upload plan completed. See the results for saved or skipped conflicts." : "Pushed Google Keep notes.");
		return successCount;
	} catch (error: unknown) {
		if (isSyncCancellationError(error)) throw error;
		new Notice("Failed to push notes."); throw error;
	}
}
