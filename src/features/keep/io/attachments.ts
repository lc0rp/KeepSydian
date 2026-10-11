import { digest, type MediaBaseline } from "../domain/local-state";
import { KEEPSIDIAN_SERVER_URL } from "../../../config";
import { NetworkError } from "../../../services/errors";
import { httpGetArrayBuffer } from "../../../services/http";
import { buildMediaPath } from "../../../services/paths";
import { assertRelativePath, equivalentPath, portableFile, withPathLock } from "@services/portable-path";

// Minimal app interface to reduce coupling in tests and code
interface AdapterLike {
	list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
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
	failures: AttachmentFailure[];
	totalDurationMs: number;
	fetchDurationMs: number;
	compareDurationMs: number;
	writeDurationMs: number;
	fileNames: string[];
	mediaBaselines?: MediaBaseline;
}

export interface AttachmentFailure {
	url: string;
	message: string;
	status?: number;
}

interface AttachmentRequestHeaders {
	email: string;
	token: string;
}

const ATTACHMENT_FETCH_MAX_ATTEMPTS = 3;
const ATTACHMENT_FETCH_INITIAL_RETRY_DELAY_MS = 750;
const ATTACHMENT_FETCH_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function getNowMs(): number {
	if (typeof performance !== "undefined" && typeof performance.now === "function") {
		return performance.now();
	}
	return Date.now();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
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
	const extension = /\.[a-z0-9]{1,10}$/i.exec(fileName)?.[0] ?? "";
	return portableFile(extension ? fileName.slice(0, -extension.length) : fileName, extension);
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
	return portableFile(fileName, inferredExtension);
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

function toAttachmentFailure(url: string, error: unknown): AttachmentFailure {
	if (error instanceof NetworkError) {
		return {
			url,
			message: error.message,
			...(typeof error.status === "number" ? { status: error.status } : {}),
		};
	}
	return {
		url,
		message: error instanceof Error ? error.message : String(error),
	};
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
			const serverRetryDelayMs = error instanceof NetworkError ? error.retryAfterMs : undefined;
			const effectiveRetryDelayMs = Math.max(retryDelayMs, serverRetryDelayMs ?? 0);
			console.warn(
				`Retrying attachment download in ${effectiveRetryDelayMs}ms (attempt ${attempt}/${ATTACHMENT_FETCH_MAX_ATTEMPTS}) for ${url}`,
				error
			);
			await sleep(effectiveRetryDelayMs);
			retryDelayMs = effectiveRetryDelayMs * 2;
		}
	}
	throw new Error(`Attachment download retry loop exhausted for ${url}`);
}

export async function processAttachments(
	app: AppLike,
	blobUrls: string[],
	saveLocation: string,
	blobNames?: string[],
	requestHeaders?: AttachmentRequestHeaders,
	preserveExisting = false
): Promise<ProcessAttachmentsResult> {
	assertRelativePath(saveLocation, true);
	const result: ProcessAttachmentsResult = {
		downloaded: 0,
		skippedIdentical: 0,
		failures: [],
		totalDurationMs: 0,
		fetchDurationMs: 0,
		compareDurationMs: 0,
		writeDurationMs: 0,
		fileNames: [],
		mediaBaselines: [],
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

			const initialPath = buildMediaPath(saveLocation, fileName);
			const initialExisting = await equivalentPath(adapter, initialPath);
			const initialBytes = initialExisting && adapter.readBinary ? await adapter.readBinary(initialExisting) : undefined;
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
			let resolvedFileName = ensureImageExtension(fileName, blobData);
			let blobFilePath = buildMediaPath(saveLocation, resolvedFileName);

			await withPathLock(adapter, `${saveLocation}/media`, async () => {
			let shouldWrite = true;
			if (typeof adapter.exists === "function") {
				try {
					const compareStartedAt = getNowMs();
					const alreadyExists = await equivalentPath(adapter, blobFilePath);
					if (alreadyExists && typeof adapter.readBinary === "function") {
						const existingData = await adapter.readBinary(alreadyExists);
						if (blobFilePath !== initialPath && !arrayBuffersAreEqual(existingData, blobData)) throw new Error("Existing media at an inferred filename was preserved. Review it before replacing it.");
						if (initialBytes && blobFilePath === initialPath && !arrayBuffersAreEqual(existingData, initialBytes)) throw new Error("Local media changed during download. Its bytes were preserved.");
						if (preserveExisting && !arrayBuffersAreEqual(existingData, blobData)) throw new Error("Local media has unsent changes. Its bytes were preserved.");
						if (existingData && arrayBuffersAreEqual(existingData, blobData)) {
							blobFilePath = alreadyExists;
							resolvedFileName = alreadyExists.split("/").pop()!;
							shouldWrite = false;
							result.skippedIdentical += 1;
						} else {
							// Without a persisted blob identity, differing bytes must never
							// overwrite a basename match. Content-address a separate version.
							let hash = 2166136261;
							for (const byte of new Uint8Array(blobData)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
							const extension = /\.[a-z0-9]{1,10}$/i.exec(resolvedFileName)?.[0] ?? "";
							const stem = extension ? resolvedFileName.slice(0, -extension.length) : resolvedFileName;
							let allocated = false;
							for (let counter = 1; counter <= 1000; counter++) {
								resolvedFileName = portableFile(stem, extension, `--media-${hash.toString(16)}${counter === 1 ? "" : `-${counter}`}`);
								blobFilePath = buildMediaPath(saveLocation, resolvedFileName);
								const occupied = await equivalentPath(adapter, blobFilePath);
								if (!occupied) { allocated = true; break; }
								if (arrayBuffersAreEqual(await adapter.readBinary(occupied), blobData)) {
									blobFilePath = occupied; resolvedFileName = occupied.split("/").pop()!;
									shouldWrite = false; result.skippedIdentical++; allocated = true; break;
								}
							}
							if (!allocated) throw new Error("Unable to allocate a distinct media filename.");
						}
					} else if (alreadyExists) {
						throw new Error("Existing media cannot be compared. Its bytes were preserved.");
					}
					result.compareDurationMs += getNowMs() - compareStartedAt;
				} catch (existsError) {
					console.error(existsError);
					throw new Error(`Failed to download blob from ${blob_url}.`);
				}
			}

			if (shouldWrite) {
				const writeStartedAt = getNowMs();
				assertRelativePath(blobFilePath);
				if (await equivalentPath(adapter, blobFilePath)) throw new Error("Media appeared at the download destination. It was preserved.");
				await adapter.writeBinary(blobFilePath, blobData);
				result.writeDurationMs += getNowMs() - writeStartedAt;
				result.downloaded += 1;
			}
			});
			result.fileNames.push(resolvedFileName);
			try { result.mediaBaselines?.push([blobFilePath, await digest(new Uint8Array(blobData))]); } catch { /* Crypto unavailable: leave acknowledgement unknown. */ }
		} catch (error) {
			console.error(error);
			result.failures.push(toAttachmentFailure(blob_url, error));
		}
	}

	result.totalDurationMs = getNowMs() - startedAt;
	return result;
}
