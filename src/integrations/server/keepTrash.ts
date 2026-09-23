import { z } from "zod";
import { KEEPSIDIAN_SERVER_URL } from "../../config";
import { httpPostJson } from "@services/http";
import { canonicalKeepUrl } from "./keepDeletions";

export const KEEP_REVISION_PATTERN = /^keep-v1:[a-f0-9]{64}$/;
export const MAX_TRASH_BATCH = 20;

export interface KeepTrashRequest {
	keep_url: string;
	expected_revision: string;
}

const StatusSchema = z.enum([
	"ready", "conflict", "already_trashed", "missing", "unverifiable",
	"trashed", "failed", "not_processed",
]);
export type KeepTrashStatus = z.infer<typeof StatusSchema>;
export interface KeepTrashResult { keep_url: string; status: KeepTrashStatus; }

const ResponseSchema = z.object({
	version: z.literal(1),
	complete: z.boolean(),
	results: z.array(z.object({
		keep_url: z.string().max(512).refine((url) => canonicalKeepUrl(url) === url),
		status: StatusSchema,
	}).strict()).max(MAX_TRASH_BATCH),
}).strict();

/** No response omission, duplicate identity or unexpected body may imply success. */
export async function requestKeepTrash(
	email: string,
	token: string,
	notes: readonly KeepTrashRequest[],
	apply = false
): Promise<KeepTrashResult[]> {
	const requested = new Set(notes.map((note) => note.keep_url));
	if (!notes.length || notes.length > MAX_TRASH_BATCH || requested.size !== notes.length || notes.some((note) =>
		canonicalKeepUrl(note.keep_url) !== note.keep_url || !KEEP_REVISION_PATTERN.test(note.expected_revision)
	)) throw new Error("A bounded set of canonical identities and known revisions is required for Keep trash.");
	const raw = await httpPostJson<unknown, { version: number; notes: readonly KeepTrashRequest[] }>(
		`${KEEPSIDIAN_SERVER_URL}/keep/trash/${apply ? "" : "preview/"}v1`,
		{ version: 1, notes },
		{ "Content-Type": "application/json", "X-User-Email": email, Authorization: `Bearer ${token}` }
	);
	const parsed = ResponseSchema.safeParse(raw);
	if (!parsed.success) throw new Error("Keep trash returned an invalid response. No unconfirmed deletion was acknowledged.");
	const { complete, results } = parsed.data;
	const returned = new Set(results.map((result) => result.keep_url));
	if (returned.size !== requested.size || returned.size !== results.length || results.some((result) => !requested.has(result.keep_url))) {
		throw new Error("Keep trash did not account for every requested identity. Refresh the plan before retrying.");
	}
	if (!apply && (!complete || results.some((result) => ["trashed", "failed", "not_processed"].includes(result.status)))) {
		throw new Error("Keep trash preview was incomplete. No deletion is eligible without a complete preview.");
	}
	const hasUnprocessed = results.some((result) => result.status === "failed" || result.status === "not_processed");
	if (apply && (results.some((result) => result.status === "ready") || complete === hasUnprocessed)) {
		throw new Error("Keep trash did not confirm a consistent application result. Refresh the plan before retrying.");
	}
	return results;
}
