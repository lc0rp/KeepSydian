import { KEEPSIDIAN_SERVER_URL } from "../../config";
import { AccessV1RequestError } from "@services/errors";
import { ACCESS_V1_ENABLED, getAccessCredential } from "./accessV1Auth";
import { accessBackendRequest, requireAccessTransport, type AccessWireResponse } from "./accessV1Transport";

const supported =
	/^\/keep\/(?:subscriber\/info|sync\/(?:v2|premium\/v2|capabilities)|push|enrich\/local\/(?:v1|capabilities)|deletions\/v1|trash\/(?:preview\/)?v1|media\/[^/]+\/.+)$/;
let capability: Promise<void> | undefined;

export async function requireAccessCapability(): Promise<void> {
	requireAccessTransport();
	if (!capability) {
		capability = (async () => {
			try {
				const response = await accessBackendRequest(`${KEEPSIDIAN_SERVER_URL}/keep/access-v1/capabilities`, "GET", {});
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
 * Requests are admitted once, with no authentication recovery/replay after send. */
export async function requestAccessBackend(
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: unknown
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
		const access = await getAccessCredential(email, master);
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
		return await accessBackendRequest(target.href, method, safeHeaders, serialized);
	} catch (error) {
		if (error instanceof AccessV1RequestError) throw error;
		throw new AccessV1RequestError();
	}
}
