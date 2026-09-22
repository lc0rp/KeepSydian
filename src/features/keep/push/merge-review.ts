import type KeepSidianPlugin from "@app/main";
import type { MergeAction, SyncPlanAction } from "@types";
import { fetchNotes } from "@integrations/server/keepApi";
import { logSync } from "@app/logging";
import { extractFrontmatter, getFrontmatterStringValue, normalizeNote } from "../domain/note";
import type { PreNormalizedNote } from "../domain/note";
import { stripManagedImageEmbeds, withManagedImageEmbeds } from "../domain/attachmentEmbeds";
import { resolveMergeAction } from "../domain/merge-action";
import { isRemoteBodyUnchanged, keepKey } from "../domain/sync-state";
import { CONFLICT_FILE_SUFFIX, FRONTMATTER_GOOGLE_KEEP_URL_KEY } from "../constants";
import { wrapMarkdown } from "../frontmatter";
import { ensureParentFolderForFile, normalizePathSafe } from "@services/paths";
import { retryDownload } from "../download-retry";
import { assertPendingAttachmentsUnchanged, type NoteForPush } from "./collectNotes";
import type { SyncCallbacks } from "../sync";

export interface ReviewedPushNote extends NoteForPush {
	planEntryId?: string;
	mergeReview?: {
		sourceContent: string;
		remoteKey?: string;
		remote?: PreNormalizedNote;
		remoteSignature?: string;
		needsMerge: boolean;
	};
	outcome?: SyncPlanAction;
}

export interface PushPlanOptions {
	reviewMerges?: boolean;
	protectedPaths?: readonly string[];
	forcePaths?: readonly string[];
}

function checkCancelled(plugin: KeepSidianPlugin): void { plugin.throwIfSyncCancelled?.(); }

function localKey(note: NoteForPush): string | undefined {
	const [, , frontmatter] = extractFrontmatter(note.content);
	const url = getFrontmatterStringValue(frontmatter, FRONTMATTER_GOOGLE_KEEP_URL_KEY);
	const key = keepKey(url);
	if (url && !key) throw new Error("A local note has an invalid Keep link. Refresh its download before uploading.");
	return key;
}

function remoteKey(note: PreNormalizedNote): string | undefined {
	const normalized = normalizeNote(note);
	return note.id || keepKey(getFrontmatterStringValue(normalized.frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY));
}

function signature(note: PreNormalizedNote): string {
	// Avoid comparing expiring attachment URLs. Snapshots stay in memory and are never logged.
	return JSON.stringify([note.id, note.title, note.text, note.updated, note.blob_names, note.archived, note.trashed]);
}

async function fetchRemoteIndex(plugin: KeepSidianPlugin): Promise<Map<string, PreNormalizedNote>> {
	const index = new Map<string, PreNormalizedNote>();
	const cursors = new Set<string>();
	let cursor: string | undefined;
	let offset = 0;
	for (let page = 0; page < 1000; page += 1) {
		checkCancelled(plugin);
		const response = await retryDownload(
			() => fetchNotes(plugin.settings.email, plugin.settings.token, offset, 100, undefined, cursor),
			{ checkCancelled: () => checkCancelled(plugin), onRetry: async () => {} }
		);
		if (!response || !Array.isArray(response.notes)) throw new Error("Unable to read Keep notes for upload review.");
		for (const note of response.notes) {
			const key = remoteKey(note);
			if (!key) continue;
			const previous = index.get(key);
			if (previous && signature(previous) !== signature(note)) throw new Error("Keep changed while preparing the upload review. Refresh the plan.");
			index.set(key, note);
		}
		if (JSON.stringify(Array.from(index.values())).length * 2 > 16 * 1024 * 1024) throw new Error("Upload review is too large. Reduce the sync scope.");
		if (response.next_cursor) {
			if (cursors.has(response.next_cursor)) throw new Error("Upload review received a repeated cursor.");
			cursors.add(response.next_cursor);
			cursor = response.next_cursor;
		} else if (cursor || response.notes.length < 100) {
			return index;
		} else {
			offset += 100;
		}
	}
	throw new Error("Upload review exceeded its pagination limit.");
}

export async function reviewPushNotes(plugin: KeepSidianPlugin, notes: ReviewedPushNote[]): Promise<ReviewedPushNote[]> {
	const remoteIndex = notes.some((note) => localKey(note)) ? await fetchRemoteIndex(plugin) : new Map<string, PreNormalizedNote>();
	return Promise.all(notes.map(async (note) => {
		const key = localKey(note), remote = key ? remoteIndex.get(key) : undefined;
		if (key && !remote) throw new Error("A linked Keep note is unavailable. Refresh the download before uploading it.");
		const remoteBody = remote ? stripManagedImageEmbeds(normalizeNote(remote).textWithoutFrontmatter) : "";
		const localBody = stripManagedImageEmbeds(note.body);
		// Local write time is never a remote baseline. Unknown baselines merge
		// conservatively; a confirmed body hash preserves local-only deletions.
		const remoteChanged = remote ? !(await isRemoteBodyUnchanged(note.frontmatter, remote)) : false;
		return {
			...note,
			mergeReview: {
				sourceContent: note.content, remoteKey: key, remote,
				remoteSignature: remote ? signature(remote) : undefined,
				needsMerge: Boolean(remote && remoteBody !== localBody && remoteChanged),
			},
		};
	}));
}

export function getReviewedPushAction(note: ReviewedPushNote): SyncPlanAction {
	if (!note.mergeReview?.needsMerge || !note.mergeReview.remote) return "upload";
	return resolveMergeAction(stripManagedImageEmbeds(normalizeNote(note.mergeReview.remote).textWithoutFrontmatter), stripManagedImageEmbeds(note.body)).action;
}

function restoreLocalImageEmbeds(text: string, original: string): string {
	const names = Array.from(original.matchAll(/!\[\[media\/([^\]\n|]+)(?:\|[^\]]+)?\]\]/g), (match) => match[1]);
	return names.length ? withManagedImageEmbeds(text, names) : text;
}

async function writeConflictCopy(plugin: KeepSidianPlugin, note: ReviewedPushNote, text: string): Promise<void> {
	const stem = note.fullPath.replace(/\.md$/i, ""), timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	let path = `${stem}${CONFLICT_FILE_SUFFIX}${timestamp}.md`, suffix = 1;
	while (await plugin.app.vault.adapter.exists(path)) {
		path = `${stem}${CONFLICT_FILE_SUFFIX}${timestamp}-${suffix++}.md`;
		if (suffix > 1000) throw new Error("Unable to allocate a conflict copy path.");
	}
	checkCancelled(plugin);
	await ensureParentFolderForFile(plugin.app, path);
	await plugin.app.vault.adapter.write(path, wrapMarkdown(note.frontmatter, restoreLocalImageEmbeds(text, note.body)));
}

/** Revalidate every selected source and remote snapshot before the first write. */
export async function prepareReviewedUploads(
	plugin: KeepSidianPlugin,
	notes: ReviewedPushNote[],
	action: MergeAction,
	callbacks?: SyncCallbacks
): Promise<ReviewedPushNote[]> {
	const remoteIndex = notes.some((note) => note.mergeReview?.remoteKey) ? await fetchRemoteIndex(plugin) : new Map<string, PreNormalizedNote>();
	for (const note of notes) {
		checkCancelled(plugin);
		const review = note.mergeReview;
		if (!review || (await plugin.app.vault.adapter.read(note.fullPath)) !== review.sourceContent) throw new Error("A local note changed after review. Refresh the upload plan.");
		await assertPendingAttachmentsUnchanged(plugin, note);
		if (review.remoteKey) {
			const current = remoteIndex.get(review.remoteKey);
			if (!current || signature(current) !== review.remoteSignature) throw new Error("A Keep note changed after review. Refresh the upload plan.");
		}
	}
	const uploads: ReviewedPushNote[] = [];
	for (const note of notes) {
		checkCancelled(plugin);
		const review = note.mergeReview!;
		if (!review.needsMerge || !review.remote) { uploads.push({ ...note, outcome: "upload" }); continue; }
		const decision = resolveMergeAction(stripManagedImageEmbeds(normalizeNote(review.remote).textWithoutFrontmatter), stripManagedImageEmbeds(note.body), action);
		if (decision.action === "conflict-copy" || decision.action === "skipped-conflict") {
			if (decision.action === "conflict-copy") await writeConflictCopy(plugin, note, decision.text);
			callbacks?.onMergeConflict?.(normalizePathSafe(note.fullPath));
			await logSync(plugin, `Upload ${decision.action}${callbacks?.attempt ? ` (attempt ${callbacks.attempt.id})` : ""}; originals preserved.`);
			if (note.planEntryId) callbacks?.onEntrySettled?.(note.planEntryId, true, decision.action);
			callbacks?.reportProgress?.();
			continue;
		}
		const body = restoreLocalImageEmbeds(decision.text, note.body);
		uploads.push({ ...note, body, content: wrapMarkdown(note.frontmatter, body), outcome: decision.action });
	}
	return uploads;
}
