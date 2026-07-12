const LEGACY_EMBED_BLOCK_START = "<!-- keepsidian-embedded-images:start -->";
const LEGACY_EMBED_BLOCK_END = "<!-- keepsidian-embedded-images:end -->";
const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "webp"]);

export function isImageFileName(fileName: string): boolean {
	const extension = fileName.split(".").pop()?.toLowerCase();
	return Boolean(extension && IMAGE_EXTENSIONS.has(extension));
}

export function stripManagedImageEmbeds(markdownBody: string): string {
	const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const legacyManagedBlock = new RegExp(
		`\\n?${escapePattern(LEGACY_EMBED_BLOCK_START)}[\\s\\S]*?${escapePattern(LEGACY_EMBED_BLOCK_END)}\\s*$`
	);
	const importedImageEmbed =
		/^\s*!\[\[media\/[^\]\n]+\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(?:\|[^\]]+)?\]\](?:<!-- keepsidian-managed-image -->)?\s*$/gim;
	return markdownBody
		.replace(legacyManagedBlock, "")
		.replace(importedImageEmbed, "")
		.trimEnd();
}

export function withManagedImageEmbeds(markdownBody: string, fileNames: string[]): string {
	const body = stripManagedImageEmbeds(markdownBody);
	const imageFileNames = Array.from(new Set(fileNames.filter(isImageFileName)));
	if (imageFileNames.length === 0) {
		return body;
	}

	const embeds = imageFileNames.map((fileName) => `![[media/${fileName}]]`).join("\n");
	return body ? `${body}\n\n${embeds}` : embeds;
}
