import { z } from "zod";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { KEEP_REVISION_PATTERN } from "@integrations/server/keepTrash";
import { KEEPSIDIAN_SERVER_URL } from "../../../config";

export const MAX_DELETION_RECORDS = 20_000;

export function isSafeVaultPath(path: string, allowRoot = false): boolean {
	return (allowRoot || path.length > 0) && !path.startsWith("/") && !/[\\\u0000]/.test(path) &&
		(path === "" || path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
}

export function deletionScope(saveLocation: string): string {
	const scope = saveLocation.trim().replace(/^\/+|\/+$/g, "");
	if (!isSafeVaultPath(scope, true)) throw new Error("The sync folder is not a safe vault-relative path.");
	return scope;
}

export function isWithinScope(path: string, scope: string): boolean {
	return scope === "" || path.startsWith(`${scope}/`);
}

const RecordSchema = z.object({
	keepUrl: z.string().max(512).refine((url) => canonicalKeepUrl(url) === url),
	path: z.string().max(4096).refine((path) => isSafeVaultPath(path)),
	scope: z.string().max(4096).refine((path) => isSafeVaultPath(path, true)),
	revision: z.string().regex(KEEP_REVISION_PATTERN),
	generation: z.string().min(1).max(128),
	state: z.enum(["present", "tombstone"]),
	witness: z.enum(["obsidian-trash", "obsidian-delete"]).optional(),
}).strict().refine((record) => record.state === "tombstone" ? record.witness !== undefined : record.witness === undefined);

export const LedgerSchema = z.object({
	version: z.literal(1),
	account: z.string().regex(/^[a-f0-9]{64}$/),
	records: z.array(RecordSchema).max(MAX_DELETION_RECORDS),
}).strict().refine((ledger) => new Set(ledger.records.map((record) => record.keepUrl)).size === ledger.records.length);

export type LocalDeletionRecord = z.infer<typeof RecordSchema>;
export type LocalDeletionState = z.infer<typeof LedgerSchema>;
export interface DownloadedRevisionReceipt { keepUrl: string; path: string; scope: string; revision?: string; }

export async function sha256(value: string): Promise<string> {
	if (!globalThis.crypto?.subtle) throw new Error("Secure identity hashing is unavailable; deletion review is disabled.");
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deletionAccount(email: string): Promise<string> {
	if (!email.trim()) throw new Error("A Google Keep account is required for deletion review.");
	return sha256(JSON.stringify(["keep-account-v1", KEEPSIDIAN_SERVER_URL, email.trim().toLowerCase()]));
}

export function recordGeneration(): string {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A checksum detects truncated/corrupt local metadata; it is not an auth token. */
export async function encodeLedger(state: LocalDeletionState): Promise<string> {
	const ledger = LedgerSchema.parse({ ...state, records: [...state.records].sort((a, b) => a.keepUrl.localeCompare(b.keepUrl)) });
	return JSON.stringify({ ledger, digest: await sha256(JSON.stringify(ledger)) });
}

export async function decodeLedger(text: string): Promise<LocalDeletionState> {
	if (text.length > 16 * 1024 * 1024) throw new Error("Deletion metadata exceeds capacity.");
	const envelope = z.object({ ledger: LedgerSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(text));
	if (await sha256(JSON.stringify(envelope.ledger)) !== envelope.digest) throw new Error("Deletion metadata is incomplete or damaged.");
	return envelope.ledger;
}
