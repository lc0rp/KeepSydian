import { isSyncCancellationError } from "@app/sync-cancel";
import type { ReadRetryHooks } from "@features/keep/download-retry";
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { NetworkError, ParseError, AccessV1RequestError } from "@services/errors";
import { usesAccessBoundary, requestAccessBackend } from "@integrations/google/accessV1Backend";
import { requireAccessTransport } from "@integrations/google/accessV1Transport";

export interface HttpOptions {
	headers?: Record<string, string>;
	readRetry?: ReadRetryHooks;
}

export interface HttpRequestOptions extends HttpOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	body?: unknown;
}

type JsonCallable = (this: ResponseLike) => unknown;
type ArrayBufferCallable = (this: ResponseLike) => ArrayBuffer | Promise<ArrayBuffer>;

interface ResponseLike {
	status?: number;
	headers?: Record<string, string>;
	readRetry?: ReadRetryHooks;
	text?: string;
	json?: unknown;
	arrayBuffer?: ArrayBuffer | ArrayBufferCallable;
}

const asResponseLike = (response: RequestUrlResponse): ResponseLike => response;

const getTextSafely = (response: ResponseLike): string => {
	const { text } = response;
	return typeof text === "string" ? text : "";
};

const parseRetryAfterMs = (headers?: Record<string, string>): number | undefined => {
	const rawValue = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	if (!rawValue) {
		return undefined;
	}

	const seconds = Number(rawValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1_000, 60_000);
	}

	const retryAt = Date.parse(rawValue);
	if (Number.isNaN(retryAt)) {
		return undefined;
	}
	return Math.min(Math.max(0, retryAt - Date.now()), 60_000);
};

const callIfFunction = async <T>(
	value: unknown,
	response: ResponseLike
): Promise<{ hasValue: boolean; result?: T }> => {
	if (typeof value === "function") {
		const callable = value as JsonCallable | ArrayBufferCallable;
		const result = (await callable.call(response)) as T;
		return { hasValue: true, result };
	}
	return { hasValue: false };
};

// Defensive JSON parsing for Obsidian's requestUrl response shape variations
async function parseJsonDefensively<T>(response: ResponseLike): Promise<T> {
	try {
		const maybeJson = response.json;
		const { hasValue, result } = await callIfFunction<T>(maybeJson, response);
		if (hasValue) {
			return result as T;
		}
		if (maybeJson !== undefined) {
			return maybeJson as T;
		}
		const text = getTextSafely(response);
		return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
	} catch (e) {
		throw new ParseError("Failed to parse JSON response", e);
	}
}

export async function httpRequest<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
	const { method = "GET", headers = {}, body } = options;
	if (usesAccessBoundary(url, headers)) {
		requireAccessTransport();
		try {
			const response = await requestAccessBackend(url, method, headers, body, options.readRetry);
			return (response.text ? JSON.parse(response.text) : undefined) as T;
		} catch (error) {
			if (error instanceof AccessV1RequestError || isSyncCancellationError(error)) throw error;
			throw new AccessV1RequestError();
		}
	}
	const hasSupporterKey = Object.keys(headers).some((name) => name.toLowerCase() === "x-supporter-key");
	const reqInit: RequestUrlParam = {
		url,
		method,
		headers,
		// Keep numeric HTTP status available for retries and attempt diagnostics.
		throw: false,
	};

	if (body !== undefined) {
		reqInit.body = typeof body === "string" ? body : JSON.stringify(body);
		reqInit.headers = {
			"Content-Type": "application/json",
			...headers,
		};
	}

	let response: RequestUrlResponse;
	try {
		response = await requestUrl(reqInit);
	} catch (error) {
		if (error instanceof NetworkError) {
			if (hasSupporterKey) {
				const safe = new NetworkError("Unable to reach the KeepSidian server", error.status);
				safe.retryAfterMs = error.retryAfterMs;
				safe.transportFailure = error.transportFailure;
				throw safe;
			}
			throw error;
		}
		const candidate = error as { status?: unknown; code?: unknown; message?: unknown } | null;
		const status = typeof candidate?.status === "number" ? candidate.status : undefined;
		const message =
			!hasSupporterKey && error instanceof Error ? error.message : "Unable to reach the KeepSidian server";
		const normalized = new NetworkError(message, status);
		normalized.transportFailure =
			["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ECONNREFUSED"].includes(String(candidate?.code)) ||
			(typeof candidate?.message === "string" &&
				/net::ERR_(CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|INTERNET_DISCONNECTED)/.test(candidate.message));
		throw normalized;
	}
	const status = typeof response.status === "number" ? response.status : 0;
	if (status < 200 || status >= 300) {
		// Try to extract error message from body, but don't fail parsing again here
		let errMsg = `Server returned status ${status}`;
		let errorCode: string | undefined;
		try {
			const errJson = await parseJsonDefensively<{ error?: unknown; message?: unknown; code?: unknown }>(
				asResponseLike(response)
			);
			if (typeof errJson?.code === "string" && /^sync_[a-z_]+$/.test(errJson.code)) errorCode = errJson.code;
			const candidateMessage =
				typeof errJson?.error === "string"
					? errJson.error
					: typeof errJson?.message === "string"
						? errJson.message
						: undefined;
			if (candidateMessage) {
				errMsg = candidateMessage;
			}
		} catch {
			/* empty */
		}
		const networkError = new NetworkError(errMsg, status);
		networkError.code = errorCode;
		networkError.retryAfterMs = parseRetryAfterMs(asResponseLike(response).headers);
		throw networkError;
	}

	return await parseJsonDefensively<T>(asResponseLike(response));
}

export async function httpGetJson<T = unknown>(
	url: string,
	headers?: Record<string, string>,
	readRetry?: ReadRetryHooks
): Promise<T> {
	return httpRequest<T>(url, { method: "GET", headers, readRetry });
}

export async function httpPostJson<TRes = unknown, TReq = unknown>(
	url: string,
	body: TReq,
	headers?: Record<string, string>,
	readRetry?: ReadRetryHooks
): Promise<TRes> {
	return httpRequest<TRes>(url, { method: "POST", headers, body, readRetry });
}

// Fetch a binary payload as an ArrayBuffer with status checking.
export async function httpGetArrayBuffer(url: string, headers?: Record<string, string>): Promise<ArrayBuffer> {
	if (usesAccessBoundary(url, headers)) {
		requireAccessTransport();
		const response = await requestAccessBackend(url, "GET", headers ?? {});
		return new Uint8Array(response.bytes).buffer;
	}
	const response = await requestUrl({ url, method: "GET", headers });
	const responseLike = asResponseLike(response);
	const statusRaw = responseLike.status;
	if (typeof statusRaw === "number") {
		const status = statusRaw;
		if (status < 200 || status >= 300) {
			let errMsg = `Server returned status ${status}`;
			try {
				const text = getTextSafely(responseLike);
				if (text) {
					const errJson = JSON.parse(text) as { error?: unknown; message?: unknown };
					const candidateMessage =
						typeof errJson?.error === "string"
							? errJson.error
							: typeof errJson?.message === "string"
								? errJson.message
								: undefined;
					if (candidateMessage) {
						errMsg = candidateMessage;
					}
				}
			} catch {
				/* empty */
			}
			const networkError = new NetworkError(errMsg, status);
			networkError.retryAfterMs = parseRetryAfterMs(responseLike.headers);
			throw networkError;
		}
	}
	const maybe = responseLike.arrayBuffer;
	const { hasValue, result } = await callIfFunction<ArrayBuffer>(maybe, responseLike);
	if (hasValue && result) {
		return result;
	}
	if (maybe instanceof ArrayBuffer) {
		return maybe;
	}
	if (maybe !== undefined && typeof maybe !== "function") {
		return maybe;
	}
	throw new Error("No binary content in response");
}
