import { arrayBufferToBase64 } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { extractFrontmatter, getFrontmatterStringValue } from "../domain/note";
import { dirnameSafe, normalizePathSafe } from "@services/paths";
import { isKeepSidianFrontmatter, listMarkdownFilesRecursively } from "../domain/noteLookup";
import { CONFLICT_FILE_SUFFIX, FRONTMATTER_KEEP_SIDIAN_LAST_SYNCED_DATE_KEY } from "../constants";
import { ensurePascalCaseFrontmatter } from "../migrations/fixFrontmatterCasing";
import { captureLocalMedia, localStateBaseline, storedLocalBaseline, type MediaBaseline } from "../domain/local-state";
import { extractAttachmentReferences } from "../domain/attachmentReferences";
import { hasPendingUpload } from "../domain/sync-state";
import type { PushAttachmentPayload } from "@integrations/server/keepApi";

export interface VaultAdapter {
	list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
	read: (path: string) => Promise<string>;
	write: (path: string, data: string) => Promise<void>;
	readBinary?: (path: string) => Promise<ArrayBuffer>;
	stat?: (path: string) => Promise<{ mtime?: number } | null>;
	exists?: (path: string) => Promise<boolean>;
}

interface AttachmentCollectionResult {
	payloads: PushAttachmentPayload[];
	updatedAttachments: string[];
	missingAttachments: string[];
}

export interface NoteForPush {
	fullPath: string;
	relativePath: string;
	title: string;
	content: string;
	body: string;
	frontmatter: string;
	lastSyncedDate: Date | null;
	modifiedSinceLastSync: boolean;
	localState?: string;
	localMedia?: MediaBaseline;
	attachments: PushAttachmentPayload[];
	updatedAttachmentNames: string[];
	missingAttachments: string[];
}

export interface CollectedNotesResult {
	notesToPush: NoteForPush[];
	skippedNotes: Array<{ path: string; reason: string }>;
}

function parseDate(value?: string): Date | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeRelativePath(notePath: string, baseFolder: string): string {
	const normalizedBase = normalizePathSafe(baseFolder);
	const normalizedNote = normalizePathSafe(notePath);
	if (normalizedNote.startsWith(`${normalizedBase}/`)) return normalizedNote.slice(normalizedBase.length + 1);
	return normalizedNote;
}

function guessMimeType(fileName: string): string {
	const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
	const mapping: Record<string, string> = {
		png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
		svg: "image/svg+xml", bmp: "image/bmp", heic: "image/heic", mp3: "audio/mpeg", wav: "audio/wav",
		m4a: "audio/m4a", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
		pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
		json: "application/json", html: "text/html",
	};
	return mapping[extension] || "application/octet-stream";
}

export function roundDateToSeconds(date: Date): Date {
	return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

async function collectAttachments(
	adapter: VaultAdapter,
	noteContent: string,
	notePath: string,
	noteFolder: string,
	lastSynced: Date | null
): Promise<AttachmentCollectionResult> {
	const attachmentPaths = extractAttachmentReferences(noteContent, notePath, noteFolder);
	const payloads: PushAttachmentPayload[] = [];
	const updatedAttachments: string[] = [];
	const missingAttachments: string[] = [];
	const roundedLastSynced = lastSynced;
	for (const attachmentPath of attachmentPaths) {
		try {
			if (typeof adapter.exists === "function" && !(await adapter.exists(attachmentPath))) {
				missingAttachments.push(attachmentPath);
				continue;
			}
			const stat = typeof adapter.stat === "function" ? await adapter.stat(attachmentPath) : null;
			const updated = stat?.mtime ? new Date(stat.mtime) : null;
			if (!(roundedLastSynced === null || updated === null || updated.getTime() > roundedLastSynced.getTime())) continue;
			let data: ArrayBuffer;
			if (typeof adapter.readBinary === "function") data = await adapter.readBinary(attachmentPath);
			else data = new TextEncoder().encode(await adapter.read(attachmentPath)).buffer;
			const name = attachmentPath.split("/").pop() ?? attachmentPath;
			payloads.push({ name, mime_type: guessMimeType(name), data: arrayBufferToBase64(data) });
			updatedAttachments.push(name);
		} catch (error) {
			console.error("Failed to collect attachment", error);
			throw new Error(`Failed to read attachment ${attachmentPath}`);
		}
	}
	return { payloads, updatedAttachments, missingAttachments };
}

/** Pending media must match the reviewed bytes, even when mtime is unchanged. */
export async function assertPendingAttachmentsUnchanged(plugin: KeepSidianPlugin, note: NoteForPush): Promise<void> {
	if (!hasPendingUpload(note.frontmatter)) return;
	const current = await collectAttachments(plugin.app.vault.adapter, note.content, note.fullPath, dirnameSafe(note.fullPath), null);
	if (current.missingAttachments.length > 0 || JSON.stringify(current.payloads) !== JSON.stringify(note.attachments)) {
		throw new Error("Pending attachments are missing or changed after review. Refresh the upload plan.");
	}
}

function deriveNoteTitle(relativePath: string): string {
	const parts = relativePath.split("/");
	const fileName = parts[parts.length - 1] || relativePath;
	return fileName.replace(/\.md$/i, "");
}

export async function collectNotesToPush(plugin: KeepSidianPlugin, forcePaths: readonly string[] = []): Promise<CollectedNotesResult> {
	const adapter = plugin.app.vault.adapter as VaultAdapter;
	const saveLocation = plugin.settings.saveLocation;
	const forced = new Set(forcePaths.map(normalizePathSafe));
	await ensurePascalCaseFrontmatter(plugin);
	const markdownFiles = await listMarkdownFilesRecursively(adapter, saveLocation);
	const notesToPush: NoteForPush[] = [];
	const skippedNotes: Array<{ path: string; reason: string }> = [];
	for (const filePath of markdownFiles) {
		try {
			if (filePath.includes(CONFLICT_FILE_SUFFIX)) {
				skippedNotes.push({ path: filePath, reason: "conflict copy (skipped)" });
				continue;
			}
			const content = await adapter.read(filePath);
			const [frontmatter, body, frontmatterDict] = extractFrontmatter(content);
			if (!isKeepSidianFrontmatter(frontmatterDict)) continue;
			const pendingUpload = hasPendingUpload(frontmatter);
			const lastSyncedDate = parseDate(getFrontmatterStringValue(frontmatterDict, FRONTMATTER_KEEP_SIDIAN_LAST_SYNCED_DATE_KEY));
			const stat = typeof adapter.stat === "function" ? await adapter.stat(filePath) : null;
			const modifiedDate = stat?.mtime ? new Date(stat.mtime) : null;
			const roundedLastSyncedDate = lastSyncedDate;
			let localMedia: MediaBaseline | undefined;
			try { localMedia = await captureLocalMedia(adapter, filePath, content); } catch { /* Unknown state stays eligible through timestamp fallback. */ }
			const localState = await localStateBaseline(adapter, filePath, content, localMedia);
			const storedState = storedLocalBaseline(content);
			const contentChanged = storedState ? localState === undefined || storedState !== localState : undefined;
			const modifiedSinceLastSync = pendingUpload || contentChanged === true || (contentChanged === undefined && (!roundedLastSyncedDate || modifiedDate === null || modifiedDate.getTime() > roundedLastSyncedDate.getTime()));
			// A download timestamp has never acknowledged local media. Retain all
			// referenced bytes while this note has a durable pending upload.
			const { payloads, updatedAttachments, missingAttachments } = await collectAttachments(adapter, content, filePath, dirnameSafe(filePath), pendingUpload || contentChanged === true ? null : lastSyncedDate);
			const shouldPush = modifiedSinceLastSync || (contentChanged === undefined && payloads.length > 0) || !lastSyncedDate || forced.has(normalizePathSafe(filePath));
			const relativePath = normalizeRelativePath(filePath, saveLocation);
			const title = getFrontmatterStringValue(frontmatterDict, "Title") || deriveNoteTitle(relativePath);
			if (!shouldPush) {
				skippedNotes.push({ path: filePath, reason: "up-to-date" });
				continue;
			}
			notesToPush.push({
				fullPath: filePath, relativePath, title, content, body, frontmatter, lastSyncedDate, modifiedSinceLastSync, localState, localMedia,
				attachments: payloads, updatedAttachmentNames: updatedAttachments, missingAttachments,
			});
		} catch (error: unknown) {
			console.error("Failed to prepare note for push", error);
			skippedNotes.push({ path: filePath, reason: `error: ${(error as Error).message}` });
		}
	}
	return { notesToPush, skippedNotes };
}
