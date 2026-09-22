import { z } from "zod";
import { KEEPSIDIAN_SERVER_URL } from "../../config";
import { httpGetJson } from "@services/http";

/** Canonical identity only; never match a deletion by title or filename. */
export function canonicalKeepUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value.trim());
		if (
			url.protocol !== "https:" ||
			url.hostname !== "keep.google.com" ||
			url.port || url.username || url.password ||
			!/^\/(?:u\/\d+\/)?$/.test(url.pathname) ||
			!url.hash.startsWith("#NOTE/")
		) return undefined;
		const id = decodeURIComponent(url.hash.slice(6));
		return /^[A-Za-z0-9._:-]{1,256}$/.test(id)
			? `https://keep.google.com/#NOTE/${encodeURIComponent(id)}`
			: undefined;
	} catch {
		return undefined;
	}
}

const DeletionResponseSchema = z.object({
	version: z.literal(1),
	complete: z.literal(true),
	deleted_keep_urls: z.array(z.string().max(512).refine((value) => !!canonicalKeepUrl(value))).max(20_000),
});

export async function fetchDeletedKeepUrls(email: string, token: string): Promise<Set<string>> {
	const raw = await httpGetJson<unknown>(`${KEEPSIDIAN_SERVER_URL}/keep/deletions/v1`, {
		"Content-Type": "application/json",
		"X-User-Email": email,
		Authorization: `Bearer ${token}`,
	});
	const response = DeletionResponseSchema.parse(raw);
	return new Set(response.deleted_keep_urls.map((url) => canonicalKeepUrl(url)!));
}
