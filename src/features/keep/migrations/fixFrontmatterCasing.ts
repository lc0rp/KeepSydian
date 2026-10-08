import type KeepSidianPlugin from "@app/main";
import { parseYaml } from "obsidian";
import { normalizePathSafe } from "@services/paths";
import { extractFrontmatter } from "../domain/note";
import { readKeepNoteIdentity } from "../domain/noteLookup";
import {
	FRONTMATTER_GOOGLE_KEEP_CREATED_DATE_KEY,
	FRONTMATTER_GOOGLE_KEEP_UPDATED_DATE_KEY,
	FRONTMATTER_GOOGLE_KEEP_URL_KEY,
} from "../constants";

const FRONTMATTER_FIX_FLAG = "frontmatterPascalCaseFixApplied" as const;

const FRONTMATTER_KEY_MAPPINGS = [
	{ hyphenated: "google-keep-created-date", pascal: FRONTMATTER_GOOGLE_KEEP_CREATED_DATE_KEY },
	{ hyphenated: "google-keep-updated-date", pascal: FRONTMATTER_GOOGLE_KEEP_UPDATED_DATE_KEY },
	{ hyphenated: "google-keep-url", pascal: FRONTMATTER_GOOGLE_KEEP_URL_KEY },
] as const;

interface ListableVaultAdapter {
	list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
	read: (path: string) => Promise<string> | string;
	write: (path: string, data: string) => Promise<void> | void;
}

let frontmatterFixPromise: Promise<void> | null = null;

export async function ensurePascalCaseFrontmatter(plugin: KeepSidianPlugin): Promise<void> {
	if (plugin.settings[FRONTMATTER_FIX_FLAG]) {
		return;
	}

	if (!frontmatterFixPromise) {
		frontmatterFixPromise = runFrontmatterFix(plugin).finally(() => {
			frontmatterFixPromise = null;
		});
	}

	await frontmatterFixPromise;
}

async function runFrontmatterFix(plugin: KeepSidianPlugin): Promise<void> {
	const adapter = plugin.app?.vault?.adapter as ListableVaultAdapter | undefined;
	if (!adapter) {
		return;
	}

	const saveLocation = normalizePathSafe(plugin.settings.saveLocation);
	let encounteredError = false;
	let markdownFiles: string[] = [];

	if (typeof adapter.list === "function") {
		try {
			markdownFiles = await listMarkdownFilesRecursively(adapter, saveLocation);
		} catch (error) {
			encounteredError = true;
			console.error("KeepSidian frontmatter fix: failed to list notes", error);
		}
	}

	if (markdownFiles.length === 0 && !encounteredError) {
		await markFixComplete(plugin);
		return;
	}

	for (const filePath of markdownFiles) {
		try {
			const content = await Promise.resolve(adapter.read(filePath));
			const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
			if (!match) {
				continue;
			}

			const frontmatterBlock = match[1];
			if (
				!FRONTMATTER_KEY_MAPPINGS.some(({ hyphenated }) =>
					frontmatterBlock.includes(hyphenated)
				)
			) {
				continue;
			}

			const [, , properties] = extractFrontmatter(content, true);
			readKeepNoteIdentity(properties, filePath);
			// The shared reader adds compatibility aliases; collision checks need only stored keys.
			const storedProperties = (parseYaml(frontmatterBlock) ?? {}) as Record<string, unknown>;
			const { updated, changed } = replaceHyphenatedKeys(frontmatterBlock, storedProperties);
			if (!changed) {
				continue;
			}

			const openingLength = content.indexOf("\n") + 1;
			const updatedContent = content.slice(0, openingLength) + updated + content.slice(openingLength + frontmatterBlock.length);

			if (updatedContent !== content) {
				readKeepNoteIdentity(extractFrontmatter(updatedContent, true)[2], filePath);
				await Promise.resolve(adapter.write(filePath, updatedContent));
			}
		} catch (error) {
			encounteredError = true;
			console.error(`KeepSidian frontmatter fix: failed to update ${filePath}`, error);
		}
	}

	if (!encounteredError) {
		await markFixComplete(plugin);
	}
}

async function markFixComplete(plugin: KeepSidianPlugin): Promise<void> {
	plugin.settings[FRONTMATTER_FIX_FLAG] = true;
	if (typeof plugin.saveSettings === "function") {
		try {
			await plugin.saveSettings();
		} catch (error) {
			plugin.settings[FRONTMATTER_FIX_FLAG] = false;
			console.error("KeepSidian frontmatter fix: failed to persist state", error);
		}
	}
}

function replaceHyphenatedKeys(frontmatter: string, properties: Record<string, unknown>): { updated: string; changed: boolean } {
	// Parsed equality loses shadowed merge entries. Only consider documents whose
	// physical lines independently prove their root-key ownership; defer richer YAML.
	if (!hasStandaloneRootProperties(frontmatter, properties)) return { updated: frontmatter, changed: false };
	let updated = frontmatter;
	let changed = false;
	const expected = { ...properties };

	for (const { hyphenated, pascal } of FRONTMATTER_KEY_MAPPINGS) {
		// Existing aliases remain readable; never turn them into duplicate YAML keys.
		if (!Object.prototype.hasOwnProperty.call(properties, hyphenated) || Object.prototype.hasOwnProperty.call(properties, pascal)) continue;
		const pattern = new RegExp(`(^|\\r?\\n)${escapeRegExp(hyphenated)}([\\t ]*:)`, "g");
		const next = updated.replace(pattern, (match, prefix, separator) => {
			changed = true;
			return `${prefix}${pascal}${separator}`;
		});
		if (next !== updated) {
			updated = next;
			expected[pascal] = properties[hyphenated];
			delete expected[hyphenated];
		}
	}

	// A column-zero match can still be inside a flow mapping or quoted value.
	// Legacy aliases are supported: skip the whole rewrite unless only root keys changed.
	if (changed && !sameYamlData(expected, parseYaml(updated))) return { updated: frontmatter, changed: false };
	return { updated, changed };
}

function hasStandaloneRootProperties(frontmatter: string, properties: Record<string, unknown>): boolean {
	const seen = new Set<string>();
	for (const line of frontmatter.split(/\r?\n/)) {
		if (/^\s*(?:#.*)?$/.test(line)) continue;
		const match = /^(?:"([^"\\]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_-]*))[\t ]*:/.exec(line);
		if (!match) return false;
		const key = match[1] ?? match[2] ?? match[3];
		try {
			const parsed: unknown = parseYaml(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
				Object.keys(parsed).length !== 1 || !Object.prototype.hasOwnProperty.call(parsed, key) ||
				!Object.prototype.hasOwnProperty.call(properties, key) || seen.has(key) ||
				!sameYamlData((parsed as Record<string, unknown>)[key], properties[key])) return false;
			seen.add(key);
		} catch {
			return false;
		}
	}
	return seen.size === Object.keys(properties).length;
}

function sameYamlData(left: unknown, right: unknown, ancestors = new Set<object>()): boolean {
	if (Object.is(left, right)) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (left instanceof Date || right instanceof Date)
		return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
	const prototype = Object.getPrototypeOf(left) as unknown;
	if (prototype !== Object.getPrototypeOf(right)) return false;
	if (Array.isArray(left)) {
		if (!Array.isArray(right) || left.length !== right.length) return false;
	} else if (prototype !== Object.prototype && prototype !== null) return false;
	// Unusual recursive/deep YAML is left byte-for-byte intact rather than guessed at.
	if (ancestors.has(left) || ancestors.size >= 64) return false;
	ancestors.add(left);
	try {
		const keys = Object.keys(left);
		return keys.length === Object.keys(right).length && keys.every((key) =>
			Object.prototype.hasOwnProperty.call(right, key) &&
			sameYamlData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], ancestors)
		);
	} finally {
		ancestors.delete(left);
	}
}

async function listMarkdownFilesRecursively(
	adapter: ListableVaultAdapter,
	folder: string
): Promise<string[]> {
	const normalizedFolder = normalizePathSafe(folder);
	if (typeof adapter.list !== "function") {
		return [];
	}

	try {
		const { files, folders } = await adapter.list(normalizedFolder);
		const markdownFiles = (files || [])
			.map((file) => normalizePathSafe(file))
			.filter((file) => file.toLowerCase().endsWith(".md"));

		for (const subfolder of folders || []) {
			const normalizedSubfolder = normalizePathSafe(subfolder);
			const name = normalizedSubfolder.split("/").pop();
			if (!name) {
				continue;
			}
			if (name === "media" || name === "_KeepSidianLogs") {
				continue;
			}
			const nested = await listMarkdownFilesRecursively(adapter, normalizedSubfolder);
			markdownFiles.push(...nested);
		}

		return markdownFiles;
	} catch (error) {
		console.error("KeepSidian frontmatter fix: failed to traverse", error);
		throw error;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
