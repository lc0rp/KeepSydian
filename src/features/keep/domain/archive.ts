import type { KeepArchivedStatus } from "../../../types/subscription";
import { FRONTMATTER_GOOGLE_KEEP_ARCHIVED_KEY, FRONTMATTER_GOOGLE_KEEP_URL_KEY } from "../constants";
import { extractFrontmatter, getFrontmatterStringValue, normalizeNote, type PreNormalizedNote } from "./note";

// Only top-level properties are matched; similarly named fields in nested user metadata are left alone.
const ARCHIVE_PROPERTY = /^(["']?)(?:GoogleKeepArchived|googleKeepArchived|google-keep-archived)\1[\t ]*:[^\r\n]*/gm;

function isRemoteArchived(note: PreNormalizedNote): boolean {
	if (typeof note.archived === "boolean") return note.archived;
	const normalized = normalizeNote(note);
	return getFrontmatterStringValue(normalized.frontmatterDict, FRONTMATTER_GOOGLE_KEEP_ARCHIVED_KEY) === "true";
}

export function isArchivedDownload(note: PreNormalizedNote, archivedStatus?: KeepArchivedStatus): boolean {
	return (
		(archivedStatus === "archived-only" || archivedStatus === "all") &&
		note.trashed !== true &&
		isRemoteArchived(note)
	);
}

/** Ensure the API's archive flag is honored even when it is absent from the rendered Markdown. */
export function getDownloadFrontmatter(note: PreNormalizedNote, archivedStatus?: KeepArchivedStatus): string {
	const normalized = normalizeNote(note);
	const renderedArchived =
		getFrontmatterStringValue(normalized.frontmatterDict, FRONTMATTER_GOOGLE_KEEP_ARCHIVED_KEY) === "true";
	if (!isRemoteArchived(note) && !renderedArchived) return normalized.frontmatter;
	const withoutArchive = normalized.frontmatter.replace(ARCHIVE_PROPERTY, "").trim();
	// An explicit false from the API also takes precedence over stale rendered true metadata.
	if (!isArchivedDownload(note, archivedStatus)) return withoutArchive;
	return [withoutArchive, `${FRONTMATTER_GOOGLE_KEEP_ARCHIVED_KEY}: true`].filter(Boolean).join("\n");
}

/**
 * Return a metadata-only edit for an already-synced note, or undefined for a no-op.
 * Never infer an archive from an absent note, a title match, or a default filter.
 * Preserve body bytes, user properties, and the last body-sync timestamp.
 */
export function getArchivedNoteUpdate(
	note: PreNormalizedNote,
	existingMarkdown: string,
	archivedStatus?: KeepArchivedStatus
): string | undefined {
	if (!isArchivedDownload(note, archivedStatus)) return undefined;
	const [, , existingProperties] = extractFrontmatter(existingMarkdown);
	const incoming = normalizeNote(note);
	const incomingUrl =
		getFrontmatterStringValue(incoming.frontmatterDict, FRONTMATTER_GOOGLE_KEEP_URL_KEY) ??
		(note.id ? `https://keep.google.com/#NOTE/${note.id}` : undefined);
	const existingUrl = getFrontmatterStringValue(existingProperties, FRONTMATTER_GOOGLE_KEEP_URL_KEY);
	if (!incomingUrl || incomingUrl !== existingUrl) return undefined;
	if (getFrontmatterStringValue(existingProperties, FRONTMATTER_GOOGLE_KEEP_ARCHIVED_KEY) === "true") {
		return undefined;
	}

	const match = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(existingMarkdown);
	if (!match) return undefined;
	const newline = match[0].includes("\r\n") ? "\r\n" : "\n";
	const property = `${FRONTMATTER_GOOGLE_KEEP_ARCHIVED_KEY}: true`;
	const oldFrontmatter = match[1];
	const replaced = oldFrontmatter.replace(ARCHIVE_PROPERTY, property);
	const newFrontmatter = replaced !== oldFrontmatter ? replaced : `${oldFrontmatter}${newline}${property}`;
	const openingLength = match[0].indexOf("\n") + 1;
	return (
		existingMarkdown.slice(0, openingLength) +
		newFrontmatter +
		existingMarkdown.slice(openingLength + oldFrontmatter.length)
	);
}
