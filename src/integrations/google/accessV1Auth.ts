import { googleAuthRequest, requireAccessTransport } from "./accessV1Transport";

export const ACCESS_V1_ENABLED = process.env.KEEPSIDIAN_ACCESS_V1 !== "false";
export const ACCESS_SCOPES = Object.freeze([
	"https://www.googleapis.com/auth/memento",
	"https://www.googleapis.com/auth/reminders",
	"https://www.googleapis.com/auth/userinfo.email",
]);
// Explicit local admission policy, not a claim about Google's issued lifetime.
const MAX_ACCEPTED_TTL_SECONDS = 24 * 60 * 60;
const ADMISSION_MARGIN_SECONDS = 60;
const CLIENT_SIGNATURE = "38918a453d07199354f8b19af05ec6562ced5788";
const DEVICE_ID = "Keep-To-Obsidian Android Id"; // existing registration identity, no new device discovery
const safeSecret = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
function validate(email: string, secret: string): void {
	if (!ACCESS_V1_ENABLED) throw new Error("Short-lived authentication is disabled.");
	requireAccessTransport();
	if (
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
		!/^[\x21-\x7e]+$/.test(email) ||
		email.length > 254 ||
		!safeSecret(secret)
	) {
		throw new Error("Invalid local Google credentials.");
	}
}
function parse(text: string): Map<string, string> {
	if (typeof text !== "string" || text.length > 16384) throw new Error();
	const normalized = text.replace(/\r\n/g, "\n");
	if (/[^\x20-\x7e\n]/.test(normalized)) throw new Error();
	const fields = new Map<string, string>();
	for (const line of normalized.replace(/\n$/, "").split("\n")) {
		const match = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!match || fields.has(match[1])) throw new Error();
		fields.set(match[1], match[2]);
	}
	if (fields.has("Error")) throw new Error();
	return fields;
}
function baseForm(email: string): Record<string, string> {
	return {
		accountType: "HOSTED_OR_GOOGLE",
		Email: email,
		has_permission: "1",
		source: "android",
		androidId: DEVICE_ID,
		device_country: "us",
		operatorCountry: "us",
		lang: "en",
		sdk_version: "17",
		google_play_services_version: "240913000",
		client_sig: CLIENT_SIGNATURE,
	};
}

/** Browser credential -> master, Google only. Caller persists master using existing local settings storage. */
export async function exchangeBrowserLocally(email: string, browser: string): Promise<string> {
	validate(email, browser);
	try {
		const fields = parse(
			await googleAuthRequest(
				new URLSearchParams({
					...baseForm(email),
					add_account: "1",
					ACCESS_TOKEN: "1",
					Token: browser,
					service: "ac2dm",
					callerSig: CLIENT_SIGNATURE,
					droidguard_results: "dummy123",
				}).toString()
			)
		);
		const master = fields.get("Token");
		if (
			!safeSecret(master) ||
			master === browser ||
			(fields.has("Email") && fields.get("Email")?.toLowerCase() !== email.toLowerCase())
		)
			throw new Error();
		cached = undefined;
		return master;
	} catch {
		throw new Error("Local Google registration failed; no server registration was attempted.");
	}
}

interface CachedAccess {
	email: string;
	master: string;
	access: string;
	expiresAt: number;
}
let cached: CachedAccess | undefined;
let pending: { email: string; master: string; promise: Promise<CachedAccess> } | undefined;

/** Do not clear a newer credential installed by a concurrent request. */
export function invalidateAccessCredential(email: string, master: string, rejected: string): void {
	if (cached?.email === email && cached.master === master && cached.access === rejected) cached = undefined;
}

/** Access credentials stay in module memory; only this result may enter the access-v1 backend header. */
export async function getAccessCredential(email: string, master: string): Promise<string> {
	validate(email, master);
	const now = Math.floor(Date.now() / 1000);
	if (cached?.email === email && cached.master === master && cached.expiresAt > now + ADMISSION_MARGIN_SECONDS)
		return cached.access;
	if (!pending || pending.email !== email || pending.master !== master) {
		const promise = (async (): Promise<CachedAccess> => {
			try {
				const fields = parse(
					await googleAuthRequest(
						new URLSearchParams({
							...baseForm(email),
							EncryptedPasswd: master,
							service: `oauth2:${ACCESS_SCOPES.join(" ")}`,
							app: "com.google.android.keep",
						}).toString()
					)
				);
				const access = fields.get("Auth"),
					expiry = fields.get("Expiry");
				if (!safeSecret(access) || access === master || fields.has("Token") || !expiry || !/^\d{1,12}$/.test(expiry))
					throw new Error();
				const expiresAt = Number(expiry),
					completed = Math.floor(Date.now() / 1000);
				if (
					!Number.isSafeInteger(expiresAt) ||
					expiresAt <= completed + ADMISSION_MARGIN_SECONDS ||
					expiresAt - now > MAX_ACCEPTED_TTL_SECONDS
				)
					throw new Error();
				return { email, master, access, expiresAt };
			} catch {
				throw new Error("Short-lived Google token unavailable; no server request was sent.");
			}
		})();
		pending = { email, master, promise };
	}
	const attempt = pending;
	try {
		const result = await attempt.promise;
		if (result.expiresAt <= Math.floor(Date.now() / 1000) + ADMISSION_MARGIN_SECONDS)
			throw new Error("Short-lived Google token expired before admission.");
		cached = result;
		return result.access;
	} finally {
		if (pending === attempt) pending = undefined;
	}
}
