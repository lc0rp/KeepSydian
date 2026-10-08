import { dirnameSafe } from "@services/paths";
import { extractFrontmatter, getFrontmatterStringValue } from "./note";
import { extractAttachmentReferences } from "./attachmentReferences";
import { wrapMarkdown } from "../frontmatter";

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
	const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
	return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Own writes are acknowledged by content, independently of filesystem clocks.
 * Include properties, effective filename/title, embed references and media bytes.
 * Unknown/missing media or Web Crypto leaves timestamp fallback conservative.
 */
export async function localStateBaseline(adapter: LocalAdapter, path: string, content: string, acknowledgedMedia?: MediaBaseline): Promise<string | undefined> {
	try {
		if (!globalThis.crypto?.subtle) return undefined;
		const [frontmatter, body, properties] = extractFrontmatter(content);
		const userProperties = frontmatter.replace(/^(?:KeepSidian(?:PendingUpload|RemoteBaseline|LocalBaseline|RemoteRevision|LastSyncedDate)|GoogleKeep(?:CreatedDate|UpdatedDate)):[^\r\n]*(?:\r?\n|$)/gm, "").trim();
		const references = extractAttachmentReferences(content, path, dirnameSafe(path)).sort();
		const media = acknowledgedMedia ? references.map((reference): [string, string] => {
			const hash = acknowledgedMedia.find(([known]) => known === reference)?.[1];
			if (!hash) throw new Error("Unacknowledged media reference");
			return [reference, hash];
		}) : await captureLocalMedia(adapter, path, content);
		const effectiveName = getFrontmatterStringValue(properties, "Title") || path.split("/").pop()?.replace(/\.md$/i, "");
		return digest(new TextEncoder().encode(JSON.stringify(["keep-local-v1", effectiveName, userProperties, body, media])));
	} catch { return undefined; }
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
