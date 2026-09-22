import type { MergeAction } from "@types";
import { FRONTMATTER_GOOGLE_KEEP_URL_KEY } from "../constants";
import { extractFrontmatter, getFrontmatterStringValue, normalizeNote, type PreNormalizedNote } from "./note";
import { stripManagedImageEmbeds } from "./attachmentEmbeds";
import { normalizeMergeAction, resolveMergeAction, type MergeDecision } from "./merge-action";

export const PENDING_UPLOAD_KEY = "KeepSidianPendingUpload";
export const REMOTE_BASELINE_KEY = "KeepSidianRemoteBaseline";

/** Account indices are not part of Keep note identity. */
export function keepKey(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.hostname !== "keep.google.com" || url.protocol !== "https:") return undefined;
		return /^#NOTE\/([^/?#]+)$/.exec(url.hash)?.[1];
	} catch { return undefined; }
}

function properties(frontmatter: string): Record<string, unknown> {
	return extractFrontmatter(`---\n${frontmatter}\n---\n`)[2];
}

export function localKeepKey(frontmatter: string): string | undefined {
	return keepKey(getFrontmatterStringValue(properties(frontmatter), FRONTMATTER_GOOGLE_KEEP_URL_KEY));
}

export function hasPendingUpload(frontmatter: string): boolean {
	// Our marker is a single top-level scalar. Treat a malformed value as pending,
	// rather than silently retiring unsent work when another editor changes YAML.
	return /^KeepSidianPendingUpload:/m.test(frontmatter);
}

/** These properties belong to the vault only and must never be sent to Keep. */
export function stripSyncState(frontmatter: string): string {
	return frontmatter.replace(/^KeepSidian(?:PendingUpload|RemoteBaseline):[^\r\n]*(?:\r?\n|$)/gm, "").trim();
}

export function withSyncState(frontmatter: string, pending: boolean, baseline?: string): string {
	const lines = [stripSyncState(frontmatter)];
	if (pending) lines.push(`${PENDING_UPLOAD_KEY}: true`);
	if (baseline && /^sha256:[a-f0-9]{64}$/.test(baseline)) lines.push(`${REMOTE_BASELINE_KEY}: ${baseline}`);
	return lines.filter(Boolean).join("\n");
}

/** A content baseline is independent of local clocks and filesystem precision.
 * Only a hash is stored, never a duplicate body, credential, or attachment URL.
 * Unavailable Web Crypto means an unknown baseline and conservative merging.
 */
export async function bodyBaseline(key: string | undefined, body: string): Promise<string | undefined> {
	if (!key) return undefined;
	try {
		const subtle = globalThis.crypto?.subtle;
		if (!subtle) return undefined;
		const bytes = new TextEncoder().encode(JSON.stringify(["keep-body-v1", key, stripManagedImageEmbeds(body).trim()]));
		const digest = await subtle.digest("SHA-256", bytes);
		return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	} catch { return undefined; }
}

export async function remoteBaseline(note: PreNormalizedNote): Promise<string | undefined> {
	const normalized = normalizeNote(note);
	return bodyBaseline(note.id || localKeepKey(normalized.frontmatter), normalized.textWithoutFrontmatter);
}

export async function isRemoteBodyUnchanged(frontmatter: string, remote: PreNormalizedNote): Promise<boolean> {
	const stored = getFrontmatterStringValue(properties(frontmatter), REMOTE_BASELINE_KEY);
	if (!stored || !/^sha256:[a-f0-9]{64}$/.test(stored)) return false;
	const current = await remoteBaseline(remote);
	return current !== undefined && current === stored;
}

export async function resolveDownloadMerge(
	frontmatter: string,
	localBody: string,
	remote: PreNormalizedNote,
	action?: MergeAction
): Promise<MergeDecision> {
	// Preserve genuine local-only edits, including deletions, when the captured
	// remote body is still the confirmed baseline. Explicit overwrite still wins.
	if (normalizeMergeAction(action) !== "overwrite-all" && await isRemoteBodyUnchanged(frontmatter, remote)) {
		return { action: "merge", text: localBody, hasConflict: false };
	}
	return resolveMergeAction(localBody, normalizeNote(remote).textWithoutFrontmatter, action);
}
