import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import type KeepSidianPlugin from "@app/main";
import type { PreNormalizedNote } from "../../domain/note";
import { extractFrontmatter } from "../../domain/note";
import type { PremiumFeatureFlags, enrichLocalNotes } from "@integrations/server/keepApi";
import { EnrichmentLedger } from "../ledger";
import { enrichImportNotes, fetchFirstFlags } from "../reuse";
import { hash } from "../state";

beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});

const FLAGS: PremiumFeatureFlags = {
	suggest_title: {},
	suggest_tags: { max_tags: 5, prefix: "auto-", restrict_tags: false },
};
const METADATA = ".obsidian/plugins/keepsidian/enrichment-v1.json";

async function note(index = 0, text = "Decision: pause."): Promise<PreNormalizedNote> {
	return {
		title: `Human ${index}`,
		text: `---\nGoogleKeepUrl: https://keep.google.com/#NOTE/note-${index}\n---\n${text}`,
		enrichment_source: {
			version: 1,
			id: `note-${index}`,
			incarnation: await hash([index, "creation"]),
			body_hash: await hash(text),
			source_hash: await hash([index, text]),
			title: `Human ${index}`,
			labels: [],
			has_body: true,
		},
	};
}

function fixture() {
	const stored = new Map<string, string>();
	const adapter = {
		exists: jest.fn(async (path: string) => stored.has(path)),
		read: jest.fn(async (path: string) => {
			if (!stored.has(path)) throw new Error("Missing file");
			return stored.get(path)!;
		}),
		write: jest.fn(async (path: string, value: string) => {
			stored.set(path, value);
		}),
		mkdir: jest.fn(async (path: string) => {
			stored.set(path, "");
		}),
		list: jest.fn(async () => ({
			files: [...stored.keys()].filter((path) => path.startsWith("Keep/") && path.endsWith(".md")),
			folders: [],
		})),
	};
	const plugin = {
		settings: {
			email: "synthetic@example.test",
			token: "fake-token",
			saveLocation: "Keep",
			supporterKeyConfigured: false,
		},
		manifest: { id: "keepsidian" },
		app: { vault: { adapter, configDir: ".obsidian" } },
		saveSettings: jest.fn(async () => {}),
	} as unknown as KeepSidianPlugin;
	let generated = 0;
	const provider: jest.MockedFunction<typeof enrichLocalNotes> = jest.fn(async (_email, _token, rows) => {
		generated += rows.length;
		return {
			results: rows.map((row) => ({
				source: row.source,
				status: "ready" as const,
				outputs: {
					...(row.features.suggest_title ? { title: "AI Proposed" } : {}),
					...(row.features.suggest_tags ? { tags: ["work", "topic"] } : {}),
				},
			})),
		};
	});
	const ledger = new EnrichmentLedger(plugin);
	const run = (notes: PreNormalizedNote[], flags = FLAGS, candidate = ledger, generate = true) =>
		enrichImportNotes(plugin, notes, flags, candidate, provider, generate);
	const apply = async (incoming: PreNormalizedNote, path = "Keep/AI Proposed.md") => {
		const before = stored.get(path);
		const after = await ledger.stage(incoming, path, before, incoming.text!);
		stored.set(path, after);
		await ledger.finish(incoming);
		return after;
	};
	return { stored, adapter, plugin, provider, ledger, run, apply, generated: () => generated };
}

it("fetches premium filters without sending AI generation flags", () => {
	expect(fetchFirstFlags({ ...FLAGS, filter_notes: { terms: ["work"] } })).toEqual({
		filter_notes: { terms: ["work"] },
	});
});

it("reuses 650 notes across more than 600 repeated and overlapping requests", async () => {
	const f = fixture(),
		notes = await Promise.all(Array.from({ length: 650 }, (_, index) => note(index)));
	await f.run(notes);
	expect(f.generated()).toBe(650);
	await f.run(notes.slice(200));
	await f.run(notes);
	expect(f.generated()).toBe(650);
	expect(f.provider).toHaveBeenCalledTimes(41);
	expect(f.stored.get(METADATA)).not.toContain("Decision: pause.");
	expect(f.stored.get(METADATA)).not.toContain("fake-token");
});

it("defers generation until execution and only charges the selected notes", async () => {
	const f = fixture(),
		notes = await Promise.all([note(0), note(1)]);
	const planned = await f.run(notes, FLAGS, f.ledger, false);
	expect(f.provider).not.toHaveBeenCalled();
	expect(planned.every((item) => item.enrichment_pending)).toBe(true);
	await f.run([planned[1]]);
	expect(f.generated()).toBe(1);
	expect(f.provider.mock.calls[0][2][0].source.id).toBe("note-1");
});

it("reconstructs the service against persisted results and credential rotation", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current]);
	f.plugin.settings.token = "rotated-token";
	const reused = await f.run([current], FLAGS, new EnrichmentLedger(f.plugin));
	expect(f.generated()).toBe(1);
	expect(reused[0].title).toBe("AI Proposed");
});

it("serializes concurrent overlapping requests in one local ledger", async () => {
	const f = fixture(),
		current = await note();
	await Promise.all([f.run([current]), f.run([current])]);
	expect(f.generated()).toBe(1);
});

it("shares admission across two ledger instances using the same vault adapter", async () => {
	const f = fixture(),
		current = await note();
	await Promise.all([f.run([current]), f.run([current], FLAGS, new EnrichmentLedger(f.plugin))]);
	expect(f.generated()).toBe(1);
});

it("keeps an earlier successful result after an uncertain maximum upgrade", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current]);
	f.provider.mockRejectedValueOnce(new Error("Upgrade response lost"));
	const upgraded = { ...FLAGS, suggest_tags: { ...FLAGS.suggest_tags!, max_tags: 10 } };
	await f.run([current], upgraded);
	const [prior] = await f.run([current], FLAGS, new EnrichmentLedger(f.plugin));
	expect(prior.tags).toEqual(["auto-work", "auto-topic"]);
	await f.run([current], upgraded, new EnrichmentLedger(f.plugin));
	expect(f.provider).toHaveBeenCalledTimes(2);
});

it("invalidates body edits but not transport metadata or note path changes", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current]);
	await f.run([{ ...current, updated: "2030-01-01", archived: true }]);
	expect(f.generated()).toBe(1);
	await f.run([await note(0, "Decision: approved.")]);
	expect(f.generated()).toBe(2);
});

it("renders a changed prefix and reduces maximum from cached raw tags", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current]);
	const reused = await f.run([current], {
		...FLAGS,
		suggest_tags: { ...FLAGS.suggest_tags!, max_tags: 1, prefix: "ai-" },
	});
	expect(f.generated()).toBe(1);
	expect(reused[0].tags).toEqual(["ai-work"]);
});

it("generates only missing tags when they are enabled after title success", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current], { suggest_title: {} });
	await f.run([current]);
	expect(f.provider.mock.calls[1][2][0].features).toEqual({ suggest_tags: FLAGS.suggest_tags });
	expect(f.provider.mock.calls[1][2][0].title_context).toBe("AI Proposed");
});

it("protects a legacy manual title and existing overlapping manual tags", async () => {
	const f = fixture(),
		current = await note();
	f.stored.set(
		"Keep/My Manual Title.md",
		current.text!.replace("---\nDecision", 'tags: ["manual", "auto-work"]\n---\nDecision')
	);
	const [result] = await f.run([current]);
	expect(f.provider.mock.calls[0][2][0].features.suggest_title).toBeUndefined();
	const after = await f.apply(result, "Keep/My Manual Title.md");
	expect(extractFrontmatter(after)[2].tags).toEqual(["manual", "auto-work", "auto-topic"]);
	expect(extractFrontmatter(after)[2].Title).toBeUndefined();
});

it("keeps deliberately removed AI tags removed across content and prefix changes", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	const after = await f.apply(first);
	f.stored.set("Keep/AI Proposed.md", after.replace('["auto-work","auto-topic"]', '["auto-topic","manual"]'));
	const [changed] = await f.run([await note(0, "Decision: approved.")], {
		...FLAGS,
		suggest_tags: { ...FLAGS.suggest_tags!, prefix: "ai-" },
	});
	const applied = await f.apply(changed);
	expect(extractFrontmatter(applied)[2].tags).toEqual(["manual", "ai-topic"]);
});

it("protects a local title edited after an AI application", async () => {
	const f = fixture(),
		[first] = await f.run([await note()]);
	await f.apply(first);
	const old = f.stored.get("Keep/AI Proposed.md")!;
	f.stored.delete("Keep/AI Proposed.md");
	f.stored.set("Keep/My Name.md", old);
	const [changed] = await f.run([await note(0, "Changed body")]);
	expect(f.provider.mock.calls[1][2][0].features.suggest_title).toBeUndefined();
	const after = await f.apply(changed, "Keep/My Name.md");
	expect(extractFrontmatter(after)[2].Title).toBeUndefined();
});

it("keeps ownership through a direct file move before the next download", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	const after = await f.apply(first);
	f.stored.delete("Keep/AI Proposed.md");
	f.stored.set("Keep/Renamed.md", after);
	await f.ledger.assertUploadAllowed("Keep/Renamed.md");
	await f.ledger.acknowledgeUpload("Keep/Renamed.md", after, {
		...current.enrichment_source!,
		title: "Renamed",
		labels: ["auto-work", "auto-topic"],
		body_hash: "a".repeat(64),
		source_hash: "b".repeat(64),
	});
	const disk = JSON.parse(f.stored.get(METADATA)!);
	const record = Object.values(disk.state.records)[0] as {
		local: { path: string };
		manualTitle: boolean;
		alias?: unknown;
	};
	expect(record.local.path).toBe("Keep/Renamed.md");
	expect(record.manualTitle).toBe(true);
	expect(record.alias).toBeDefined();
});

it("never retries a lost/uncertain response during normal sync or restart", async () => {
	const f = fixture(),
		current = await note();
	f.provider.mockRejectedValueOnce(new Error("Lost response"));
	await f.run([current]);
	await f.run([current], FLAGS, new EnrichmentLedger(f.plugin));
	expect(f.provider).toHaveBeenCalledTimes(1);
});

it("blocks corrupt or missing initialized metadata without paid fallback", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current]);
	f.stored.set(METADATA, "corrupt");
	await expect(f.run([current], FLAGS, new EnrichmentLedger(f.plugin))).rejects.toThrow();
	f.stored.delete(METADATA);
	await expect(f.run([current], FLAGS, new EnrichmentLedger(f.plugin))).rejects.toThrow();
	expect(f.provider).toHaveBeenCalledTimes(1);
});

it("does not dispatch if its durable uncertainty write fails", async () => {
	const f = fixture();
	f.adapter.write.mockRejectedValue(new Error("Disk full"));
	await expect(f.run([await note()])).rejects.toThrow("Disk full");
	expect(f.provider).not.toHaveBeenCalled();
});

it("recovers an application completed before its receipt was finalized", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	const after = await f.ledger.stage(first, "Keep/AI Proposed.md", undefined, first.text!);
	f.stored.set("Keep/AI Proposed.md", after);
	const restarted = new EnrichmentLedger(f.plugin);
	const [second] = await f.run([current], FLAGS, restarted);
	expect(second.local_enrichment?.tags).toEqual({ work: "auto-work", topic: "auto-topic" });
	expect(f.generated()).toBe(1);
});

it("isolates the same content under a different account and note incarnation", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current]);
	f.plugin.settings.email = "another@example.test";
	await f.run([current]);
	await f.run([{ ...current, enrichment_source: { ...current.enrichment_source!, incarnation: "f".repeat(64) } }]);
	expect(f.generated()).toBe(3);
});

it("freezes the allowed vocabulary so newly discovered AI tags do not cause churn", async () => {
	const f = fixture(),
		current = await note();
	const flags = { ...FLAGS, suggest_tags: { ...FLAGS.suggest_tags!, restrict_tags: ["work", "topic"] } };
	await f.run([current], flags);
	await f.run([current], {
		...flags,
		suggest_tags: { ...flags.suggest_tags, restrict_tags: ["topic", "work", "auto-topic"] },
	});
	expect(f.generated()).toBe(1);
});

it("uses a manual local title as tag context without overwriting it", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	const after = await f.apply(first);
	f.stored.set("Keep/AI Proposed.md", after.replace("---\nDecision", 'Title: "My decision"\n---\nDecision'));
	await f.run([current]);
	expect(f.provider.mock.calls[1][2][0].features.suggest_title).toBeUndefined();
	expect(f.provider.mock.calls[1][2][0].title_context).toBe("My decision");
});

it("uses an accepted cached title when only tags are enabled later", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current], { suggest_title: {} });
	const [result] = await f.run([current], { suggest_tags: FLAGS.suggest_tags });
	expect(f.provider.mock.calls[1][2][0].title_context).toBe("AI Proposed");
	expect(result.title).toBe(current.title);
});

it("excludes acknowledged AI feedback even after the user removes an AI tag", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	const after = await f.apply(first);
	const uploaded = {
		...current.enrichment_source!,
		title: "AI Proposed",
		labels: ["auto-work", "auto-topic"],
		body_hash: "e".repeat(64),
		source_hash: "d".repeat(64),
	};
	await f.ledger.acknowledgeUpload("Keep/AI Proposed.md", after, uploaded);
	f.stored.set("Keep/AI Proposed.md", after.replace('["auto-work","auto-topic"]', '["auto-topic"]'));
	const [reused] = await f.run([{ ...current, enrichment_source: uploaded }]);
	expect(f.generated()).toBe(1);
	expect(extractFrontmatter(await f.apply(reused))[2].tags).toEqual(["auto-topic"]);
});

it("propagates a Keep title edit and blocks a concurrent local title conflict", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	await f.apply(first);
	const changed = {
		...current,
		enrichment_source: { ...current.enrichment_source!, title: "Keep manual", source_hash: "c".repeat(64) },
	};
	const [incoming] = await f.run([changed]);
	expect(extractFrontmatter(await f.apply(incoming))[2].Title).toBe("Keep manual");
	f.stored.set(
		"Keep/AI Proposed.md",
		f.stored.get("Keep/AI Proposed.md")!.replace('"Keep manual"', '"Obsidian manual"')
	);
	await f.run([
		{
			...changed,
			enrichment_source: { ...changed.enrichment_source!, title: "Another Keep title", source_hash: "b".repeat(64) },
		},
	]);
	await expect(f.ledger.assertUploadAllowed("Keep/AI Proposed.md")).rejects.toThrow("both sides");
});
