import { z } from "zod";
import { EnrichmentSourceSchema, EnrichmentProvenanceSchema } from "@schemas/keep";
import { extractFrontmatter, getFrontmatterStringValue } from "../domain/note";
import { sha256, isSafeVaultPath } from "../local-deletions/state";

const ProjectionSchema = z.object({ body: z.string(), title: z.string(), labels: z.array(z.string()) });
const ReceiptSchema = z.object({
	source: EnrichmentSourceSchema,
	path: z
		.string()
		.max(4096)
		.refine((path) => isSafeVaultPath(path)),
	title: z.string(),
	body: z.string(),
	tags: z.array(z.string()),
	owned: z.record(z.string(), z.string()),
});
export const RecordSchema = z.object({
	source: EnrichmentSourceSchema,
	projection: ProjectionSchema,
	manualTitle: z.boolean(),
	suppressed: z.array(z.string()).max(1024),
	suppressedValues: z.array(z.string()).max(1024),
	conflicts: z.array(z.string()).max(1024),
	manualKeepLabels: z.array(z.string()).max(1024),
	owned: z.record(z.string(), z.string()),
	local: ReceiptSchema.optional(),
	uploadPending: z.boolean().optional(),
	alias: z
		.object({ source: EnrichmentSourceSchema, projection: ProjectionSchema, owned: z.record(z.string(), z.string()) })
		.optional(),
	journal: z.object({ before: z.string().optional(), after: z.string(), receipt: ReceiptSchema }).optional(),
});
export const StateSchema = z.object({
	version: z.literal(1),
	records: z.record(z.string(), RecordSchema),
	cache: z.record(
		z.string(),
		z.object({
			status: z.enum(["ready", "uncertain"]),
			output: z.union([z.string(), z.array(z.string())]).optional(),
			coverage: z.number(),
			attemptedCoverage: z.number().optional(),
			recipe: z.string(),
			provenance: EnrichmentProvenanceSchema.optional(),
		})
	),
	vocabulary: z.record(z.string(), z.array(z.string()).max(256)),
});
export type EnrichmentState = z.infer<typeof StateSchema>;
export type EnrichmentRecord = z.infer<typeof RecordSchema>;
export type Projection = z.infer<typeof ProjectionSchema>;
export const emptyState = (): EnrichmentState => ({ version: 1, records: {}, cache: {}, vocabulary: {} });
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, item]) => [key, canonical(item)])
		);
	return value;
}
export const hash = (value: unknown): Promise<string> => sha256(JSON.stringify(canonical(value)));

export function tags(markdown: string): string[] {
	const value = extractFrontmatter(markdown)[2].tags;
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: typeof value === "string"
			? [value]
			: [];
}

export function effectiveTitle(path: string, markdown: string): string {
	const properties = extractFrontmatter(markdown)[2];
	// An explicit blank is a manual edit too.
	return getFrontmatterStringValue(properties, "Title") ?? path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
}

export async function bodyHash(markdown: string): Promise<string> {
	return hash(extractFrontmatter(markdown)[1].replace(/\r\n/g, "\n"));
}

/** Detect removals before applying another candidate; never infer ownership by prefix. */
export function observeLocal(record: EnrichmentRecord, path: string, markdown: string): void {
	if (!record.local) {
		record.manualTitle = true;
		return;
	}
	if (effectiveTitle(path, markdown) !== record.local.title) record.manualTitle = true;
	const current = new Set(tags(markdown));
	for (const value of record.local.tags)
		if (!current.has(value) && !record.suppressedValues.includes(value)) record.suppressedValues.push(value);
	for (const [raw, value] of Object.entries(record.owned)) {
		if (!current.has(value)) {
			if (!record.suppressed.includes(raw)) record.suppressed.push(raw);
			delete record.owned[raw];
		}
	}
}

/** Replace only proven owned values; preserve unrelated frontmatter bytes. */
export function replaceTags(markdown: string, values: string[]): string {
	const match = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(markdown);
	if (!match) return markdown;
	const property = /^(["']?)tags\1[ \t]*:[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]*|-[^\r\n]*))*/m;
	const line = `tags: ${JSON.stringify(values)}`;
	const frontmatter = property.test(match[1])
		? match[1].replace(property, line)
		: [match[1], line].filter(Boolean).join("\n");
	const opening = match[0].indexOf("\n") + 1;
	return markdown.slice(0, opening) + frontmatter + markdown.slice(opening + match[1].length);
}
