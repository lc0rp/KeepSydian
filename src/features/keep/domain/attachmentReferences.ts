import { dirnameSafe, mediaFolderPath, normalizePathSafe } from "@services/paths";

function normalizeRelativePath(notePath: string, baseFolder: string): string {
	const normalizedBase = normalizePathSafe(baseFolder);
	const normalizedNote = normalizePathSafe(notePath);
	return normalizedNote.startsWith(`${normalizedBase}/`) ? normalizedNote.slice(normalizedBase.length + 1) : normalizedNote;
}

function resolveRelativePath(baseDir: string, target: string): string {
	const baseSegments = normalizePathSafe(baseDir).split("/").filter(Boolean);
	const targetSegments = normalizePathSafe(target).split("/").filter(Boolean);
	const stack = [...baseSegments];
	for (const segment of targetSegments) {
		if (!segment || segment === ".") continue;
		if (segment === "..") stack.pop();
		else stack.push(segment);
	}
	return stack.join("/");
}

export function extractAttachmentReferences(noteContent: string, notePath: string, saveLocation: string): string[] {
	const references = new Set<string>();
	const mediaFolderNormalized = normalizePathSafe(mediaFolderPath(saveLocation));
	const mediaRelative = normalizeRelativePath(mediaFolderNormalized, saveLocation);
	const noteDir = dirnameSafe(notePath);
	const wikiLinkRegex = /!\[\[([^\]]+)\]\]/g;
	const markdownImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
	const processMatch = (rawTarget: string) => {
		if (!rawTarget) return;
		let target = rawTarget.split("|")[0];
		target = target.split("#")[0];
		target = target.replace(/^</, "").replace(/>$/, "").trim();
		if (!target || target.includes("://")) return;
		const normalizedTarget = normalizePathSafe(target).replace(/^\.\//, "");
		const candidates = new Set<string>();
		if (normalizedTarget.startsWith(mediaFolderNormalized)) candidates.add(normalizedTarget);
		if (normalizedTarget.startsWith(mediaRelative)) candidates.add(normalizePathSafe(`${saveLocation}/${normalizedTarget}`));
		if (!normalizedTarget.includes("/")) candidates.add(normalizePathSafe(`${mediaFolderNormalized}/${normalizedTarget}`));
		if (!normalizedTarget.startsWith(mediaFolderNormalized)) candidates.add(resolveRelativePath(noteDir, normalizedTarget));
		for (const candidate of candidates) {
			const normalizedCandidate = normalizePathSafe(candidate);
			if (normalizedCandidate.startsWith(mediaFolderNormalized)) references.add(normalizedCandidate);
		}
	};
	let wikiMatch: RegExpExecArray | null;
	while ((wikiMatch = wikiLinkRegex.exec(noteContent)) !== null) processMatch(wikiMatch[1]);
	let mdMatch: RegExpExecArray | null;
	while ((mdMatch = markdownImageRegex.exec(noteContent)) !== null) processMatch(mdMatch[1]);
	return Array.from(references);
}
