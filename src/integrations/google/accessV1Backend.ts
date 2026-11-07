import { isSyncCancellationError } from "@app/sync-cancel";
import { KEEPSIDIAN_SERVER_URL } from "../../config";
import { AccessV1RequestError } from "@services/errors";
import { ACCESS_V1_ENABLED, getAccessCredential, invalidateAccessCredential } from "./accessV1Auth";
import { accessBackendRequest, requireAccessTransport, type AccessWireResponse } from "./accessV1Transport";

import { retryDownload, type ReadRetryHooks } from "@features/keep/download-retry";
import { PremiumFeatureFlagsSchema } from "@schemas/keep";
const defaultHooks: ReadRetryHooks = { checkCancelled: () => {}, onRetry: async () => {} };
const permanentCodes = new Set([
	"sync_session_expired",
	"sync_cursor_invalid",
	"sync_operation_conflict",
	"sync_snapshot_too_large",
	"sync_capacity",
	"sync_operation_held",
	"enrichment_replay_held",
	"enrichment_replay_pending",
	"enrichment_replay_expired",
	"enrichment_replay_conflict",
	"access_v1_disabled",
	"access_protocol_required",
	"access_headers_invalid",
	"access_identity_required",
	"access_validation_unavailable",
	"access_configuration_unavailable",
	"invalid_access",
]);

/** Explicit read contracts; a new endpoint or flag must earn retry eligibility. */
export function isSafeAccessRead(path: string, method: string, body?: unknown): boolean {
	if (method === "GET")
		return /^\/keep\/(?:subscriber\/info|sync\/(?:v2|capabilities)|enrich\/local\/capabilities|deletions\/v1|media\/[^/]+\/.+)$/.test(
			path
		);
	if (method !== "POST") return false;
	if (path === "/keep/trash/preview/v1" || path === "/keep/enrich/local/lookup/v1") return true;
	if (path !== "/keep/sync/premium/v2") return false;
	try {
		const value = typeof body === "string" ? JSON.parse(body) : body;
		if (!value || typeof value !== "object" || Object.keys(value).some((key) => key !== "feature_flags")) return false;
		const flags = (value as { feature_flags?: unknown }).feature_flags;
		return (
			!!flags &&
			typeof flags === "object" &&
			!Array.isArray(flags) &&
			Object.keys(flags).every((key) => ["keep_state_filter", "filter_notes", "skip_notes"].includes(key)) &&
			PremiumFeatureFlagsSchema.safeParse(flags).success
		);
	} catch {
		return false;
	}
}
function classify(error: unknown, safe: boolean): never {
	if (!(error instanceof AccessV1RequestError)) throw new AccessV1RequestError();
	error.retryAllowed =
		safe &&
		!error.responseRejected &&
		!permanentCodes.has(error.code ?? "") &&
		([429, 502, 503, 504].includes(error.status ?? 0) || error.transportFailure);
	throw error;
}
const supported =
	/^\/keep\/(?:subscriber\/info|sync\/(?:v2|premium\/v2|capabilities)|push|enrich\/local\/(?:v1|capabilities|lookup\/v1)|deletions\/v1|trash\/(?:preview\/)?v1|media\/[^/]+\/.+)$/;
let capability: Promise<void> | undefined;

export async function requireAccessCapability(): Promise<void> {
	requireAccessTransport();
	if (!capability) {
		capability = (async () => {
			try {
				const response = await retryDownload(async () => {
					try {
						return await accessBackendRequest(
							`${KEEPSIDIAN_SERVER_URL}/keep/access-v1/capabilities`,
							"GET",
							{},
							"",
							60_000
						);
					} catch (error) {
						return classify(error, true);
					}
				}, defaultHooks);
				const value = JSON.parse(response.text) as { auth_protocol?: unknown; enabled?: unknown };
				if (value?.auth_protocol !== "access-v1" || value.enabled !== true) throw new Error();
			} catch (error) {
				if (error instanceof AccessV1RequestError) throw error;
				throw new Error("Short-lived authentication is unavailable on this server.");
			}
		})();
	}
	try {
		await capability;
	} catch (error) {
		capability = undefined;
		if (error instanceof AccessV1RequestError) error.retryHandled = true;
		throw error;
	}
}

export function usesAccessBoundary(url: string, headers: Record<string, string> = {}): boolean {
	if (!ACCESS_V1_ENABLED) return false;
	// Credentials cannot escape to an unrecognized origin, even on a media URL.
	if (Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) return true;
	try {
		const target = new URL(url),
			base = new URL(KEEPSIDIAN_SERVER_URL);
		return (
			target.origin === base.origin &&
			(target.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/keep/") ||
				target.pathname === base.pathname.replace(/\/$/, "") + "/register")
		);
	} catch {
		return false;
	}
}

/** Sole enabled backend boundary: convert local master header before transmission.
 * Verified reads have one bounded retry owner. Paid operations and writes remain single-attempt. */
export async function requestAccessBackend(
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: unknown,
	hooks: ReadRetryHooks = defaultHooks
): Promise<AccessWireResponse> {
	requireAccessTransport();
	try {
		const target = new URL(url),
			base = new URL(KEEPSIDIAN_SERVER_URL);
		const prefix = base.pathname.replace(/\/$/, "");
		const suffix = target.pathname.slice(prefix.length).replace(/^\/keep\/access-v1\//, "/keep/");
		if (
			target.origin !== base.origin ||
			!target.pathname.startsWith(prefix + "/") ||
			target.username ||
			target.password ||
			target.hash ||
			!supported.test(suffix) ||
			!["GET", "POST"].includes(method)
		)
			throw new Error();
		const names = Object.keys(headers);
		if (
			names.filter((key) => key.toLowerCase() === "authorization").length !== 1 ||
			names.filter((key) => key.toLowerCase() === "x-user-email").length !== 1
		)
			throw new Error();
		const authorization = headers[names.find((key) => key.toLowerCase() === "authorization")!];
		const email = headers[names.find((key) => key.toLowerCase() === "x-user-email")!];
		if (!authorization.startsWith("Bearer ")) throw new Error();
		const master = authorization.slice(7);
		if (
			!master ||
			target.href.includes(master) ||
			Array.from(target.searchParams.values()).some((value) => value.includes(master))
		)
			throw new Error();
		await requireAccessCapability();
		let access = await getAccessCredential(email, master);
		const safeHeaders: Record<string, string> = {};
		const allowed = new Set([
			"content-type",
			"x-supporter-key",
			"x-sync-operation",
			"x-enrichment-operation",
			"x-keep-upload-review",
		]);
		for (const [key, value] of Object.entries(headers)) {
			if (allowed.has(key.toLowerCase())) safeHeaders[key] = value;
		}
		safeHeaders.Authorization = `Bearer ${access}`;
		safeHeaders["X-User-Email"] = email;
		safeHeaders["X-Keep-Auth-Protocol"] = "access-v1";
		target.pathname = prefix + suffix.replace(/^\/keep\//, "/keep/access-v1/");
		const serialized = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
		// Refuse accidental raw credential inclusion in payloads or non-auth headers.
		if (serialized.includes(master) || Object.values(safeHeaders).some((value) => value.includes(master)))
			throw new Error();
		const safe = isSafeAccessRead(suffix, method, body);
		let refreshed = false;
		try {
			return await retryDownload(
				async () => {
					safeHeaders.Authorization = `Bearer ${access}`;
					try {
						return await accessBackendRequest(
							target.href,
							method,
							safeHeaders,
							serialized,
							safe ? (/^\/keep\/(?:sync\/|media\/|deletions\/v1$|trash\/preview\/v1$)/.test(suffix) ? 310_000 : 60_000) : undefined
						);
					} catch (error) {
						return classify(error, safe);
					}
				},
				{
					...hooks,
					enabled: safe,
					recover: async (error) => {
						if (
							!safe ||
							refreshed ||
							!(error instanceof AccessV1RequestError) ||
							error.status !== 401 ||
							error.code !== "access_expired"
						)
							return false;
						refreshed = true;
						invalidateAccessCredential(email, master, access);
						access = await getAccessCredential(email, master);
						return true;
					},
				}
			);
		} catch (error) {
			if (error instanceof AccessV1RequestError) error.retryHandled = true;
			throw error;
		}
	} catch (error) {
		if (error instanceof AccessV1RequestError || isSyncCancellationError(error)) throw error;
		throw new AccessV1RequestError();
	}
}
