import { AccessV1RequestError } from "@services/errors";
import type { AccessWireResponse } from "./accessV1Transport";
import { KEEPSIDIAN_SERVER_URL } from "../../config";

const OPTIONS = {
	redirect: "error",
	mode: "cors",
	credentials: "omit",
	cache: "no-store",
	referrerPolicy: "no-referrer",
} as const;

/** Capability checks are local only; they do not attest Google/CORS compatibility. */
export function requireMobileFetch(): void {
	try {
		if (
			[
				globalThis.fetch,
				globalThis.Request,
				globalThis.Response,
				globalThis.AbortController,
				globalThis.TextEncoder,
				globalThis.TextDecoder,
			].some((value) => typeof value !== "function")
		)
			throw new Error();
		const controller = new AbortController();
		const probe = new Request("https://android.clients.google.com/auth", {
			...OPTIONS,
			method: "POST",
			signal: controller.signal,
		});
		checkRequest(probe);
		controller.abort();
		if (!probe.signal.aborted || typeof new Response(new Uint8Array()).body?.getReader !== "function")
			throw new Error();
		let rejected = false;
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([255]));
		} catch {
			rejected = true;
		}
		if (!rejected) throw new Error();
	} catch {
		throw new Error("Short-lived authentication requires supported mobile Fetch primitives.");
	}
}

function checkRequest(request: Request): void {
	if (
		request.redirect !== "error" ||
		request.mode !== "cors" ||
		request.credentials !== "omit" ||
		request.cache !== "no-store" ||
		request.referrerPolicy !== "no-referrer"
	)
		throw new Error();
}

/** Explicit mobile path using browser UA/certificate validation. Never retries or falls back. */
export async function mobileAccessRequest(
	url: URL,
	method: string,
	headers: Record<string, string>,
	body: string,
	maxResponseBytes: number,
	maxRequestBytes: number,
	deadlineMs?: number,
	acceptHttpErrors = false
): Promise<AccessWireResponse> {
	let controller: AbortController | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let status: number | undefined;
	try {
		requireMobileFetch();
		const encoder = new TextEncoder();
		const backend = new URL(KEEPSIDIAN_SERVER_URL);
		const google = url.href === "https://android.clients.google.com/auth";
		if (
			!(google && method === "POST") &&
			!(
				url.origin === backend.origin &&
				url.pathname.startsWith(backend.pathname.replace(/\/$/, "") + "/keep/access-v1/")
			)
		)
			throw new Error();
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.hash ||
			!["GET", "POST"].includes(method) ||
			body.length > maxRequestBytes ||
			encoder.encode(body).byteLength > maxRequestBytes ||
			(method === "GET" && body !== "") ||
			Object.entries(headers).some(([k, v]) => !/^[A-Za-z0-9-]+$/.test(k) || /[^\x20-\x7e]/.test(v)) ||
			encoder.encode(JSON.stringify(headers)).byteLength > 8192
		)
			throw new Error();
		// Fetch controls UA, Host, framing, cookies and TLS. Do not request forbidden Node headers.
		const mobileHeaders = { ...headers };
		for (const name of Object.keys(mobileHeaders)) {
			if (name.toLowerCase() === "user-agent" && mobileHeaders[name] === "GoogleAuth/1.4") delete mobileHeaders[name];
			else if (/^(user-agent|host|content-length|connection|accept-encoding|cookie|origin|referer)$/i.test(name))
				throw new Error();
		}
		controller = new AbortController();
		const request = new Request(url.href, {
			...OPTIONS,
			method,
			headers: mobileHeaders,
			signal: controller.signal,
			...(method === "POST" ? { body } : {}),
		});
		checkRequest(request);
		if (request.url !== url.href || request.method !== method) throw new Error();
		for (const [name, value] of Object.entries(mobileHeaders))
			if (request.headers.get(name) !== value) throw new Error();
		if (deadlineMs !== undefined) timer = setTimeout(() => controller?.abort(), deadlineMs);
		// A simple form POST can already have reached Google when CORS rejects its response.
		// A rejection has unknown outcome and must never cause a second attempt.
		const response = await globalThis.fetch(request);
		if (controller.signal.aborted) throw new Error();
		if (
			response.redirected ||
			response.url !== url.href ||
			!["basic", "cors"].includes(response.type) ||
			response.status < 200 ||
			response.status > 599 ||
			(response.status >= 300 && response.status < 400)
		)
			throw new Error();
		status = response.status;
		if (status >= 400 && !acceptHttpErrors) throw new Error();
		const limit = status >= 400 ? Math.min(maxResponseBytes, 16384) : maxResponseBytes;
		let headerSize = 0;
		response.headers.forEach((value, name) => {
			headerSize += encoder.encode(name + value).byteLength;
		});
		if (headerSize > 8192) throw new Error();
		const length = response.headers.get("content-length");
		if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (!response.body && status !== 204) throw new Error();
		if (response.body) {
			reader = response.body.getReader();
			for (;;) {
				const next = await reader.read();
				if (controller.signal.aborted) throw new Error();
				if (next.done) break;
				if (!(next.value instanceof Uint8Array)) throw new Error();
				if (next.value.byteLength === 0) continue;
				size += next.value.byteLength;
				if (size > limit) throw new Error();
				chunks.push(next.value);
			}
		}
		if (controller.signal.aborted) throw new Error();
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const rawRetryAfter = response.headers.get("retry-after");
		let retryAfterMs: number | undefined;
		if (rawRetryAfter !== null) {
			const seconds = Number(rawRetryAfter);
			const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(rawRetryAfter) - Date.now();
			if (Number.isFinite(ms)) retryAfterMs = Math.min(Math.max(0, ms), 60000);
		}
		return {
			status,
			bytes,
			retryAfterMs,
			get text() {
				return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			},
		};
	} catch {
		if (acceptHttpErrors) throw new AccessV1RequestError(status);
		throw new Error("Google authentication failed; it was not retried.");
	} finally {
		clearTimeout(timer);
		controller?.abort();
		try {
			void reader?.cancel().catch(() => undefined);
		} catch {
			/* no raw diagnostics */
		}
	}
}
