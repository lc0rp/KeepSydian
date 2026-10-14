import { dirnameSafe } from "@services/paths";
import { extractFrontmatter, getFrontmatterStringValue } from "./note";
import { extractAttachmentReferences } from "./attachmentReferences";
import { wrapMarkdown } from "../frontmatter";
import { parseYaml } from "obsidian";

export const LOCAL_BASELINE_KEY = "KeepSidianLocalBaseline";

interface LocalAdapter {
	read(path: string): Promise<string>;
	readBinary?(path: string): Promise<ArrayBuffer>;
	exists?(path: string): Promise<boolean>;
}

export function storedLocalBaseline(content: string): string | undefined {
	const [frontmatter] = extractFrontmatter(content);
	return /^KeepSidianLocalBaseline: (sha256:[a-f0-9]{64})$/m.exec(frontmatter)?.[1];
}

export async function digest(bytes: Uint8Array): Promise<string> {
	// A byte view also works with older crypto implementations across JS realms.
	const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Own writes are acknowledged by content, independently of filesystem clocks.
 * Include properties, effective filename/title, embed references and media bytes.
 * Unknown/missing media or Web Crypto leaves timestamp fallback conservative.
 */
type BaselineFormat = "semantic" | "legacy" | "legacy-timestamps" | "legacy-quoted-filename";

function canonicalProperties(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(canonicalProperties);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalProperties(item)]));
	return value;
}

export async function localStateBaseline(adapter: LocalAdapter, path: string, content: string, acknowledgedMedia?: MediaBaseline, format: BaselineFormat = "semantic"): Promise<string | undefined> {
	try {
		if (!globalThis.crypto?.subtle) return undefined;
		const [frontmatter, body, properties] = extractFrontmatter(content);
		let userProperties = frontmatter.replace(/^(?:KeepSidian(?:PendingUpload|RemoteBaseline|LocalBaseline|RemoteRevision|LastSyncedDate)|GoogleKeep(?:CreatedDate|UpdatedDate)):[^\r\n]*(?:\r?\n|$)/gm, "").trim();
		if (format !== "legacy-timestamps") {
			// Common local timestamp plugins maintain these fields independently of
			// Keep. Ignore only date-valued top-level scalars, never body or nested data.
			userProperties = userProperties.replace(/^(["']?)(created|updated)\1[\t ]*:[^\r\n]*(?:\r?\n|$)/gim, (line, _quote: string, key: string) => {
				const value = getFrontmatterStringValue(properties, key);
				return value && /^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(value) && Number.isFinite(Date.parse(value)) ? "" : line;
			}).trim();
		}
		if (format === "legacy-quoted-filename") {
			const filename = getFrontmatterStringValue(properties, "KeepSidianUntitledFileName");
			if (filename) userProperties = userProperties.replace(/^KeepSidianUntitledFileName:[^\r\n]*/m, `KeepSidianUntitledFileName: ${JSON.stringify(filename)}`);
		}
		const references = extractAttachmentReferences(content, path, dirnameSafe(path)).sort();
		const media = acknowledgedMedia ? references.map((reference): [string, string] => {
			const hash = acknowledgedMedia.find(([known]) => known === reference)?.[1];
			if (!hash) throw new Error("Unacknowledged media reference");
			return [reference, hash];
		}) : await captureLocalMedia(adapter, path, content);
		const effectiveName = getFrontmatterStringValue(properties, "Title") || path.split("/").pop()?.replace(/\.md$/i, "");
		const meaningfulProperties: unknown = format === "semantic" ? canonicalProperties(parseYaml(userProperties) as unknown) : userProperties;
		return await digest(new TextEncoder().encode(JSON.stringify([format === "semantic" ? "keep-local-v2" : "keep-local-v1", effectiveName, meaningfulProperties, body, media])));
	} catch { return undefined; }
}

/** Existing hashes remain valid when their exact acknowledged timestamp values
 * are still present. Unknown legacy state stays conservative; never rebaseline
 * an edited body merely because its remote body happens to match.
 */
export async function isLocalStateUnchanged(adapter: LocalAdapter, path: string, content: string, acknowledgedMedia?: MediaBaseline): Promise<boolean> {
	const stored = storedLocalBaseline(content);
	if (!stored) return false;
	const current = await localStateBaseline(adapter, path, content, acknowledgedMedia);
	if (current === undefined) return false;
	if (stored === current) return true;
	for (const format of ["legacy", "legacy-timestamps", "legacy-quoted-filename"] as const) {
		if (stored === await localStateBaseline(adapter, path, content, acknowledgedMedia, format)) return true;
	}
	return false;
}

export async function stampLocalBaseline(adapter: LocalAdapter, path: string, content: string, acknowledgedMedia?: MediaBaseline): Promise<string> {
	const [frontmatter, body] = extractFrontmatter(content);
	const cleaned = frontmatter.replace(/^KeepSidianLocalBaseline:[^\r\n]*(?:\r?\n|$)/gm, "").trim();
	const baseline = await localStateBaseline(adapter, path, content, acknowledgedMedia);
	return wrapMarkdown(baseline ? `${cleaned}\n${LOCAL_BASELINE_KEY}: ${baseline}` : cleaned, body);
}

export type MediaBaseline = Array<[string, string]>;

export async function captureLocalMedia(adapter: LocalAdapter, path: string, content: string): Promise<MediaBaseline> {
	const media: MediaBaseline = [];
	for (const reference of extractAttachmentReferences(content, path, dirnameSafe(path)).sort()) {
		if (adapter.exists && !(await adapter.exists(reference))) throw new Error("Referenced local media is missing.");
		const bytes = adapter.readBinary ? new Uint8Array(await adapter.readBinary(reference)) : new TextEncoder().encode(await adapter.read(reference));
		media.push([reference, await digest(bytes)]);
	}
	return media;
}
