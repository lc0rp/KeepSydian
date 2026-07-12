import { KEEPSIDIAN_SERVER_URL } from "../../../config";
import { NetworkError } from "../../../services/errors";
import { httpGetArrayBuffer } from "../../../services/http";
import { buildMediaPath } from "../../../services/paths";

// Minimal app interface to reduce coupling in tests and code
interface AdapterLike {
	writeBinary: (path: string, data: ArrayBuffer) => Promise<void> | void;
	exists?: (path: string) => Promise<boolean> | boolean;
	readBinary?: (path: string) => Promise<ArrayBuffer> | ArrayBuffer;
}
interface VaultLike {
	adapter: AdapterLike;
}
interface AppLike {
	vault: VaultLike;
}

export interface ProcessAttachmentsResult {
	downloaded: number;
	skippedIdentical: number;
	totalDurationMs: number;
	fetchDurationMs: number;
	compareDurationMs: number;
	writeDurationMs: number;
	fileNames: string[];
}

interface AttachmentRequestHeaders {
	email: string;
	token: string;
}

const ATTACHMENT_FETCH_MAX_ATTEMPTS = 3;
const ATTACHMENT_FETCH_INITIAL_RETRY_DELAY_MS = 750;
const ATTACHMENT_FETCH_RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

function getNowMs(): number {
	if (typeof performance !== "undefined" && typeof performance.now === "function") {
		return performance.now();
	}
	return Date.now();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function arrayBuffersAreEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) {
		return false;
	}
	const viewA = new Uint8Array(a);
	const viewB = new Uint8Array(b);
	for (let i = 0; i < viewA.length; i += 1) {
		if (viewA[i] !== viewB[i]) {
			return false;
		}
	}
	return true;
}

function resolveBlobUrl(blobUrl: string): URL | null {
	try {
		return new URL(blobUrl);
	} catch {
		if (!blobUrl || !blobUrl.trim()) {
			return null;
		}
		if (!blobUrl.trim().startsWith("/")) {
			return null;
		}
		try {
			const base = `${KEEPSIDIAN_SERVER_URL.replace(/\/$/, "")}/`;
			return new URL(blobUrl, base);
		} catch {
			return null;
		}
	}
}

function sanitizeFileName(fileName: string): string {
	const unsafeCharacters = new Set(["\\", "/", "#", "[", "]", "|", "^"]);
	return Array.from(fileName, (character) => (unsafeCharacters.has(character) ? "_" : character)).join("");
}

function hasImageFileExtension(fileName: string): boolean {
	return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(fileName);
}

function inferImageExtension(data: ArrayBuffer): string | null {
	const bytes = new Uint8Array(data);
	if (
		bytes.length >= 8 &&
		bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
	) {
		return ".png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return ".jpg";
	}
	const signature = String.fromCharCode(...bytes.slice(0, 12));
	if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) {
		return ".gif";
	}
	if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") {
		return ".webp";
	}
	if (signature.startsWith("BM")) {
		return ".bmp";
	}
	const textPrefix = String.fromCharCode(...bytes.slice(0, 512)).trimStart();
	if (textPrefix.startsWith("<svg") || (textPrefix.startsWith("<?xml") && textPrefix.includes("<svg"))) {
		return ".svg";
	}
	return null;
}

function ensureImageExtension(fileName: string, data: ArrayBuffer): string {
	const inferredExtension = inferImageExtension(data);
	if (!inferredExtension || hasImageFileExtension(fileName)) {
		return fileName;
	}
	return `${fileName}${inferredExtension}`;
}

function deriveFileName(url: URL, index: number, blobNames?: string[]): string | null {
	const nameFromBlobNames = blobNames?.[index]?.trim();
	if (nameFromBlobNames) {
		return sanitizeFileName(nameFromBlobNames);
	}
	const segments = url.pathname.split("/").filter(Boolean);
	const lastSegment = segments[segments.length - 1];
	if (!lastSegment) {
		return null;
	}
	try {
		return sanitizeFileName(decodeURIComponent(lastSegment));
	} catch {
		return sanitizeFileName(lastSegment);
	}
}

function isRetryableAttachmentFetchError(error: unknown): boolean {
	if (error instanceof NetworkError) {
		if (typeof error.status === "number") {
			return ATTACHMENT_FETCH_RETRYABLE_STATUSES.has(error.status);
		}
		return true;
	}
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	return (
		message.includes("network error") ||
		message.includes("failed to fetch") ||
		message.includes("timed out") ||
		message.includes("timeout") ||
		message.includes("econnreset") ||
		message.includes("econnrefused") ||
		message.includes("socket hang up")
	);
}

async function fetchAttachmentBlob(url: string, headers?: Record<string, string>): Promise<ArrayBuffer> {
	let retryDelayMs = ATTACHMENT_FETCH_INITIAL_RETRY_DELAY_MS;
	for (let attempt = 1; attempt <= ATTACHMENT_FETCH_MAX_ATTEMPTS; attempt += 1) {
		try {
			return await httpGetArrayBuffer(url, headers);
		} catch (error) {
			const shouldRetry = attempt < ATTACHMENT_FETCH_MAX_ATTEMPTS && isRetryableAttachmentFetchError(error);
			if (!shouldRetry) {
				throw error;
			}
			console.warn(
				`Retrying attachment download in ${retryDelayMs}ms (attempt ${attempt}/${ATTACHMENT_FETCH_MAX_ATTEMPTS}) for ${url}`,
				error
			);
			await sleep(retryDelayMs);
			retryDelayMs *= 2;
		}
	}
	throw new Error(`Attachment download retry loop exhausted for ${url}`);
}

export async function processAttachments(
	app: AppLike,
	blobUrls: string[],
	saveLocation: string,
	blobNames?: string[],
	requestHeaders?: AttachmentRequestHeaders
): Promise<ProcessAttachmentsResult> {
	const result: ProcessAttachmentsResult = {
		downloaded: 0,
		skippedIdentical: 0,
		totalDurationMs: 0,
		fetchDurationMs: 0,
		compareDurationMs: 0,
		writeDurationMs: 0,
		fileNames: [],
	};

	if (!blobUrls || blobUrls.length === 0) {
		return result;
	}

	const startedAt = getNowMs();
	const adapter = app?.vault?.adapter;
	for (const [index, blob_url] of blobUrls.entries()) {
		try {
			const resolvedUrl = resolveBlobUrl(blob_url);
			if (!resolvedUrl) {
				console.error(`Invalid URL format: ${blob_url}`);
				continue;
			}

			if (!adapter) {
				continue;
			}

			const fileName = deriveFileName(resolvedUrl, index, blobNames);
			if (!fileName) {
				console.error(`Could not determine filename for attachment at ${resolvedUrl.href}`);
				continue;
			}

			const fetchStartedAt = getNowMs();
			const requestUrlHeaders =
				requestHeaders && resolvedUrl.href.startsWith(KEEPSIDIAN_SERVER_URL)
					? {
							"X-User-Email": requestHeaders.email,
							Authorization: `Bearer ${requestHeaders.token}`,
						}
					: undefined;
			const blobData = await fetchAttachmentBlob(resolvedUrl.href, requestUrlHeaders);
			result.fetchDurationMs += getNowMs() - fetchStartedAt;
			const resolvedFileName = ensureImageExtension(fileName, blobData);
			const blobFilePath = buildMediaPath(saveLocation, resolvedFileName);

			let shouldWrite = true;
			if (typeof adapter.exists === "function") {
				try {
					const compareStartedAt = getNowMs();
					const alreadyExists = await adapter.exists(blobFilePath);
					if (alreadyExists && typeof adapter.readBinary === "function") {
						const existingData = await adapter.readBinary(blobFilePath);
						if (existingData && arrayBuffersAreEqual(existingData, blobData)) {
							shouldWrite = false;
							result.skippedIdentical += 1;
						}
					}
					result.compareDurationMs += getNowMs() - compareStartedAt;
				} catch (existsError) {
					console.error(existsError);
					throw new Error(`Failed to download blob from ${blob_url}.`);
				}
			}

			if (shouldWrite) {
				const writeStartedAt = getNowMs();
				await adapter.writeBinary(blobFilePath, blobData);
				result.writeDurationMs += getNowMs() - writeStartedAt;
				result.downloaded += 1;
			}
			result.fileNames.push(resolvedFileName);
		} catch (error) {
			console.error(error);
			throw new Error(`Failed to download blob from ${blob_url}.`);
		}
	}

	result.totalDurationMs = getNowMs() - startedAt;
	return result;
}
