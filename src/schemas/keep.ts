import { z } from "zod";

export const EnrichmentSourceSchema = z.object({
	version: z.literal(1), id: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/),
	incarnation: z.string().regex(/^[a-f0-9]{64}$/), body_hash: z.string().regex(/^[a-f0-9]{64}$/),
	source_hash: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().max(2000),
	labels: z.array(z.string().max(100)).max(256), has_body: z.boolean(),
});
export type EnrichmentSource = z.infer<typeof EnrichmentSourceSchema>;
export const EnrichmentProvenanceSchema = z.object({
	model_requested: z.string(), model_revision: z.literal("unknown"),
	parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
	request_hash: z.string().regex(/^[a-f0-9]{64}$/), prompt_hash: z.string().regex(/^[a-f0-9]{64}$/), schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const LocalEnrichmentResponseSchema = z.object({ results: z.array(z.object({
	source: EnrichmentSourceSchema, status: z.enum(["ready", "uncertain"]),
	outputs: z.object({ title: z.string().min(1).max(2000).optional(), tags: z.array(z.string().min(1).max(100)).max(20).optional() }),
	provenance: EnrichmentProvenanceSchema.optional(),
})).max(16) });

// Schema for a pre-normalized note as returned by the server
export const PreNormalizedNoteSchema = z.object({
	id: z.string().optional(),
	tags: z.array(z.string()).optional(),
	processing_warnings: z.array(z.string()).optional(),
	title: z.string().optional(),
	text: z.string().optional(),
	body: z.string().optional(),
	created: z.string().nullable().optional(),
	updated: z.string().nullable().optional(),
	remote_revision: z
		.string()
		.regex(/^keep-v1:[a-f0-9]{64}$/)
		.optional(),
	color: z.string().optional(),
	pinned: z.boolean().optional(),
	frontmatter: z.string().optional(),
	frontmatterDict: z.record(z.string(), z.unknown()).optional(),
	archived: z.boolean().optional(),
	trashed: z.boolean().optional(),
	labels: z.array(z.string()).optional(),
	blobs: z.array(z.string()).optional(),
	blob_urls: z.array(z.string().nullable()).optional(),
	blob_names: z.array(z.string()).optional(),
	media: z.array(z.string()).optional(),
	header: z.string().optional(),
	enrichment_source: EnrichmentSourceSchema.optional(),
});

// Response schema for the Keep import endpoints
export const GoogleKeepImportResponseSchema = z.object({
	notes: z.array(PreNormalizedNoteSchema),
	total_notes: z.number().optional(),
	next_cursor: z.string().optional(),
});

// Request schema for premium feature flags (optional; useful for validation/fixtures)
export const PremiumFeatureFlagsSchema = z.object({
	filter_notes: z.object({ terms: z.array(z.string()) }).optional(),
	skip_notes: z.object({ terms: z.array(z.string()) }).optional(),
	keep_state_filter: z
		.object({
			colors: z.array(z.string()).optional(),
			pinned: z.enum(["all", "pinned", "unpinned"]).optional(),
			archived: z.enum(["active-only", "archived-only", "all"]).optional(),
		})
		.optional(),
	// Server expects an empty object if present
	suggest_title: z.object({ prompt: z.string().min(1).max(10000).optional() }).optional(),
	suggest_tags: z
		.object({
			max_tags: z.number(),
			restrict_tags: z.union([z.boolean(), z.array(z.string())]),
			prefix: z.string(),
		})
		.optional(),
});
