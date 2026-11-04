import { Platform } from "obsidian";
import type { ClientRequest, IncomingMessage } from "http";
import type { Agent } from "https";
import type { Buffer } from "buffer";
import { KEEPSIDIAN_SERVER_URL } from "../../config";
import { AccessV1RequestError } from "@services/errors";
import { mobileAccessRequest, requireMobileFetch } from "./accessV1MobileTransport";
import { nativeGoogleAuthRequest } from "./accessV1NativeGoogle";

declare const require: ((moduleId: string) => unknown) | undefined;
function loadNodeModule<T>(moduleId: string): T {
	if (typeof require !== "function") throw new Error("Desktop transport is unavailable.");
	return require(moduleId) as T;
}

export const GOOGLE_AUTH_URL = "https://android.clients.google.com/auth";
export interface AccessWireResponse {
	status: number;
	bytes: Uint8Array;
	text: string;
	retryAfterMs?: number;
}
export function requireAccessTransport(): void {
	if (Platform?.isDesktopApp) return;
	if (Platform?.isMobileApp) {
		requireMobileFetch();
		return;
	}
	throw new Error("Short-lived authentication requires a supported Obsidian platform.");
}

/** One verified TLS attempt. Never follows redirects, proxies, or retries. */
async function send(
	url: URL,
	method: string,
	headers: Record<string, string>,
	body: string,
	maxResponseBytes: number,
	maxRequestBytes: number,
	deadlineMs?: number,
	acceptHttpErrors = false
): Promise<AccessWireResponse> {
	requireAccessTransport();
	if (!Platform.isDesktopApp)
		return mobileAccessRequest(
			url,
			method,
			headers,
			body,
			maxResponseBytes,
			maxRequestBytes,
			deadlineMs,
			acceptHttpErrors
		);
	// Lazy loading preserves the existing mobile path when the build gate is off.
	// Use the existing CommonJS require path; native imports failed in the tested desktop renderer.
	const https = loadNodeModule<typeof import("https")>("https");
	const tls = loadNodeModule<typeof import("tls")>("tls");
	const { TextDecoder } = loadNodeModule<typeof import("util")>("util");
	const { Buffer } = loadNodeModule<typeof import("buffer")>("buffer");
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		Buffer.byteLength(body) > maxRequestBytes ||
		Object.entries(headers).some(([k, v]) => !/^[A-Za-z0-9-]+$/.test(k) || /[^\x20-\x7e]/.test(v))
	)
		throw new Error("Invalid secure request.");
	return new Promise((resolve, reject) => {
		let req: ClientRequest | undefined, res: IncomingMessage | undefined, agent: Agent | undefined;
		let done = false,
			verified = false,
			sent = false,
			size = 0;
		let chunks: Buffer[] = [];
		const finish = (result?: AccessWireResponse) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			for (const resource of [res, req, agent]) {
				try {
					resource?.destroy();
				} catch {
					/* fixed diagnostics only */
				}
			}
			chunks = [];
			body = "";
			if (result) resolve(result);
			else if (
				acceptHttpErrors &&
				verified &&
				sent &&
				res?.statusCode &&
				res.statusCode >= 400 &&
				res.statusCode <= 599
			)
				reject(new AccessV1RequestError(res.statusCode));
			else reject(new Error("Secure request failed; it was not retried."));
		};
		// Legacy backend requests had no client total deadline. Do not shorten an
		// admitted paid/mutation operation to Google's separate auth deadline.
		const timer = deadlineMs === undefined ? undefined : setTimeout(() => finish(), deadlineMs);
		try {
			// proxyEnv is recognized by recent Node; older Node ignores it and own agents do not read proxy env.
			agent = new https.Agent({
				keepAlive: false,
				maxCachedSessions: 0,
				rejectUnauthorized: true,
				...{ proxyEnv: {} },
			});
			req = https.request(
				{
					protocol: "https:",
					hostname: url.hostname,
					port: url.port || 443,
					path: url.pathname + url.search,
					method,
					servername: url.hostname,
					rejectUnauthorized: true,
					checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(url.hostname, cert),
					minVersion: "TLSv1.2",
					agent,
					maxHeaderSize: 8192,
					...{ insecureHTTPParser: false },
					headers: {
						...headers,
						Host: url.host,
						"Content-Length": Buffer.byteLength(body),
						Connection: "close",
						"Accept-Encoding": "identity",
					},
				},
				(response) => {
					res = response;
					res.on("error", () => finish());
					res.on("aborted", () => finish());
					if (done) {
						res.destroy();
						return;
					}
					if (
						!verified ||
						!sent ||
						!res.statusCode ||
						res.statusCode < 200 ||
						(res.statusCode >= 300 && (!acceptHttpErrors || res.statusCode < 400 || res.statusCode > 599)) ||
						(res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")
					) {
						finish();
						return;
					}
					const responseLimit = res.statusCode >= 400 ? Math.min(maxResponseBytes, 16_384) : maxResponseBytes;
					const length = res.headers["content-length"];
					if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > responseLimit)) {
						finish();
						return;
					}
					res.on("data", (chunk: Buffer) => {
						if (done) return;
						size += chunk.length;
						if (size > responseLimit) {
							finish();
							return;
						}
						chunks.push(chunk);
					});
					res.on("end", () => {
						if (done) return;
						try {
							if (!res?.complete) {
								finish();
								return;
							}
							const bytes = Buffer.concat(chunks, size);
							// Binary media is decoded only by its caller when a JSON/text response is required.
							const text = () => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
							const rawRetryAfter = res.headers["retry-after"];
							let retryAfterMs: number | undefined;
							if (typeof rawRetryAfter === "string") {
								const seconds = Number(rawRetryAfter);
								const milliseconds =
									Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(rawRetryAfter) - Date.now();
								if (Number.isFinite(milliseconds)) retryAfterMs = Math.min(Math.max(0, milliseconds), 60_000);
							}
							finish({
								status: res.statusCode ?? 200,
								retryAfterMs,
								bytes,
								get text() {
									return text();
								},
							});
						} catch {
							finish();
						}
					});
					res.on("close", () => {
						if (!res?.complete) finish();
					});
				}
			);
			req.on("error", () => finish());
			req.on("close", () => {
				if (!res) finish();
			});
			req.on("socket", (socket) => {
				socket.once("secureConnect", () => {
					if (done) return;
					try {
						const secure = socket as import("tls").TLSSocket;
						if (
							!secure.encrypted ||
							!secure.authorized ||
							tls.checkServerIdentity(url.hostname, secure.getPeerCertificate())
						) {
							finish();
							return;
						}
						verified = true;
						if (!sent) {
							sent = true;
							req?.end(body);
						}
					} catch {
						finish();
					}
				});
			});
		} catch {
			finish();
		}
	});
}

export async function googleAuthRequest(body: string): Promise<string> {
	try {
		if (!/^[A-Za-z0-9*_.%+=&-]+$/.test(body) || /%(?![a-fA-F0-9]{2})/.test(body)) throw new Error();
		// Explicit Android Google transport; failures never enter browser or legacy paths.
		if (Platform?.isMobileApp && Platform.isAndroidApp && !Platform.isDesktopApp)
			return await nativeGoogleAuthRequest(body);
		return (
			await send(
				new URL(GOOGLE_AUTH_URL),
				"POST",
				{
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "GoogleAuth/1.4",
				},
				body,
				16_384,
				32_768,
				30_000
			)
		).text;
	} catch {
		throw new Error("Google authentication failed; it was not retried.");
	}
}

export async function accessBackendRequest(
	url: string,
	method: string,
	headers: Record<string, string>,
	body = ""
): Promise<AccessWireResponse> {
	try {
		const target = new URL(url),
			base = new URL(KEEPSIDIAN_SERVER_URL);
		if (
			target.origin !== base.origin ||
			!target.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/keep/access-v1/")
		)
			throw new Error();
		const response = await send(target, method, headers, body, 32 * 1024 * 1024, 32 * 1024 * 1024, undefined, true);
		if (response.status >= 400) {
			let code: unknown;
			try {
				code = (JSON.parse(response.text) as { code?: unknown })?.code;
			} catch {
				/* retain only status */
			}
			throw new AccessV1RequestError(response.status, code, response.retryAfterMs);
		}
		return response;
	} catch (error) {
		if (error instanceof AccessV1RequestError) throw error;
		throw new AccessV1RequestError();
	}
}
