jest.mock("@app/sync-ui");
import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import type KeepSidianPlugin from "@app/main";
import type { PreNormalizedNote } from "../../domain/note";
import { extractFrontmatter } from "../../domain/note";
import type { PremiumFeatureFlags, enrichLocalNotes } from "@integrations/server/keepApi";
import { EnrichmentLedger } from "../ledger";
import { enrichImportNotes, fetchFirstFlags } from "../reuse";
import { hash } from "../state";
import { pushGoogleKeepNotes } from "../../push";
import * as keepApi from "@integrations/server/keepApi";
import { chooseLegacyTags } from "../consent";
import { DEFAULT_SETTINGS } from "../../../../types/keepsidian-plugin-settings";
import { buildManualSyncPlan, runPreparedSyncPlan, runImportNotesFlow } from "@app/main-sync-flows";

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
		list: jest.fn(async (_path: string) => ({
			files: [...stored.keys()].filter((path) => path.startsWith("Keep/") && path.endsWith(".md")),
			folders: [] as string[],
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

it("blocks paid work after a lost upload acknowledgement until an upload is confirmed", async () => {
	const f = fixture(),
		current = await note();
	const [first] = await f.run([current]);
	const applied = await f.apply(first);
	const [frontmatter, body] = extractFrontmatter(applied);
	const dispatch = jest.spyOn(keepApi, "pushNotes").mockRejectedValueOnce(new Error("Upload response lost"));
	try {
		await expect(
			pushGoogleKeepNotes(f.plugin, undefined, [
				{
					fullPath: "Keep/AI Proposed.md",
					relativePath: "AI Proposed.md",
					title: "AI Proposed",
					content: applied,
					frontmatter,
					body,
					lastSyncedDate: null,
					modifiedSinceLastSync: true,
					attachments: [],
					updatedAttachmentNames: [],
					missingAttachments: [],
				},
			])
		).rejects.toThrow("Upload response lost");
		expect(dispatch).toHaveBeenCalledTimes(1);
	} finally {
		dispatch.mockRestore();
	}
	const uploaded = {
		...current.enrichment_source!,
		title: "AI Proposed",
		labels: ["auto-work", "auto-topic"],
		source_hash: "c".repeat(64),
	};
	const restarted = new EnrichmentLedger(f.plugin);
	await expect(f.run([{ ...current, enrichment_source: uploaded }], FLAGS, restarted)).rejects.toThrow(
		"earlier upload"
	);
	expect(f.generated()).toBe(1);
	await restarted.acknowledgeUpload("Keep/AI Proposed.md", applied, uploaded);
	await f.run([{ ...current, enrichment_source: uploaded }], FLAGS, restarted);
	expect(f.generated()).toBe(1);
});

it("cannot stage an upload when its durable intent write fails", async () => {
	const f = fixture(),
		current = await note();
	const [first] = await f.run([current]);
	await f.apply(first);
	f.adapter.write.mockRejectedValueOnce(new Error("Disk full"));
	await expect(f.ledger.stageUpload("Keep/AI Proposed.md")).rejects.toThrow("Disk full");
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

it("does not generate legacy titles or tags from saved AI options", async () => {
	const f = fixture(),
		current = await note();
	f.stored.set(
		"Keep/My Manual Title.md",
		current.text!.replace("---\nDecision", 'tags: ["manual", "auto-work"]\n---\nDecision')
	);
	const [result] = await f.run([current]);
	expect(f.provider).not.toHaveBeenCalled();
	const after = await f.apply(result, "Keep/My Manual Title.md");
	expect(extractFrontmatter(after)[2].tags).toEqual(["manual", "auto-work"]);
	expect(extractFrontmatter(after)[2].Title).toBeUndefined();
	await f.run([await note(0, "Changed body")], FLAGS, new EnrichmentLedger(f.plugin));
	expect(f.provider).not.toHaveBeenCalled();
});

it("does not admit AI work when an existing note folder cannot be listed", async () => {
	const f = fixture(),
		current = await note();
	f.stored.set("Keep/Manual.md", current.text!);
	f.adapter.list.mockRejectedValueOnce(new Error("Synthetic folder IO failure"));
	await expect(f.run([current])).rejects.toThrow("Synthetic folder IO failure");
	expect(f.generated()).toBe(0);
});

it("an abandoned preview cannot admit a later manual import", async () => {
	const f = fixture(),
		current = await note();
	await f.run([current], FLAGS, f.ledger, false);
	f.stored.set("Keep/Manual.md", current.text!.replace("\n---\nDecision", '\nTitle: "My manual title"\n---\nDecision'));
	await f.run([current]);
	expect(f.generated()).toBe(0);
});

it("admits a new note only when a readable ancestor proves its destination absent", async () => {
	const f = fixture(),
		current = await note();
	f.adapter.list.mockRejectedValueOnce(new Error("Destination absent"));
	await f.run([current]);
	expect(f.generated()).toBe(1);
});

it("keeps an unreadable nested folder from admitting existing notes", async () => {
	const f = fixture(),
		current = await note();
	f.stored.set("Keep/Nested/Manual.md", current.text!);
	f.adapter.list.mockImplementation(async (path: string) => {
		if (path === "Keep/Nested") throw new Error("Nested folder IO failure");
		return { files: [], folders: path === "Keep" ? ["Keep/Nested"] : [] };
	});
	await expect(f.run([current])).rejects.toThrow("Nested folder IO failure");
	expect(f.generated()).toBe(0);
});

it("refuses an empty tag replacement that would invalidate a YAML alias", async () => {
	const f = fixture(),
		current = await note();
	current.enrichment_source!.labels = ["manual"];
	const before = current.text!.replace(
		"\n---\nDecision",
		'\nTitle: "Human 0"\ntags: &labels ["manual"]\ncustom: *labels\n---\nDecision'
	);
	f.stored.set("Keep/Manual.md", before);
	const [initial] = await f.run([current], { suggest_title: {} });
	const first = await f.ledger.stage(initial, "Keep/Manual.md", before, before);
	f.stored.set("Keep/Manual.md", first);
	await f.ledger.finish(initial);
	const changed = {
		...current,
		enrichment_source: { ...current.enrichment_source!, labels: [], source_hash: "d".repeat(64) },
	};
	const [incoming] = await f.run([changed], { suggest_title: {} });
	await expect(f.ledger.stage(incoming, "Keep/Manual.md", first, first)).rejects.toThrow("frontmatter");
	expect(f.stored.get("Keep/Manual.md")).toBe(first);
	expect(f.generated()).toBe(0);
});

it.each([false, true])(
	"refuses unsafe tag aliases before writing, tag generation enabled: %s",
	async (generateTags) => {
		const f = fixture(),
			current = await note();
		current.enrichment_source!.labels = generateTags ? [] : ["manual", "new-label"];
		const before = current.text!.replace(
			"\n---\nDecision",
			'\nTitle: "Human 0"\ntags: &labels ["manual"]\ncustom: *labels\n---\nDecision'
		);
		f.stored.set("Keep/Manual.md", before);
		const [incoming] = await f.run(
			[{ ...current, enrichment_legacy_consent: chooseLegacyTags() }],
			generateTags ? FLAGS : { suggest_title: {} }
		);
		f.adapter.write.mockClear();
		await expect(f.ledger.stage(incoming, "Keep/Manual.md", before, before)).rejects.toThrow("frontmatter");
		expect(f.stored.get("Keep/Manual.md")).toBe(before);
		expect(f.adapter.write).not.toHaveBeenCalled();
		expect(f.generated()).toBe(generateTags ? 1 : 0);
	}
);

it("admits only selected legacy tags after a fresh choice and reuses them without another choice", async () => {
	const f = fixture(),
		notes = await Promise.all([note(0), note(1)]);
	for (const current of notes) f.stored.set(`Keep/Manual ${current.enrichment_source!.id}.md`, current.text!);
	const consent = chooseLegacyTags();
	const planned = await f.run(
		notes.map((current) => ({ ...current, enrichment_legacy_consent: consent })),
		FLAGS,
		f.ledger,
		false
	);
	expect(f.provider).not.toHaveBeenCalled();
	await f.run([planned[0]]);
	expect(f.generated()).toBe(1);
	expect(f.provider.mock.calls[0][2][0].features).toEqual({ suggest_tags: FLAGS.suggest_tags });
	await f.run(notes, FLAGS, new EnrichmentLedger(f.plugin));
	expect(f.generated()).toBe(1);
});

it("rejects serialized or reused consent for another account, note or content snapshot", async () => {
	const f = fixture(),
		current = await note();
	f.stored.set("Keep/Manual.md", current.text!);
	const consent = chooseLegacyTags();
	await f.run([{ ...current, enrichment_legacy_consent: consent }], FLAGS, f.ledger, false);
	const changed = await note(0, "Different source");
	await f.run([{ ...changed, enrichment_legacy_consent: consent }]);
	await f.run([{ ...current, enrichment_legacy_consent: JSON.parse(JSON.stringify(consent)) }]);
	f.plugin.settings.email = "different@example.test";
	await f.run([{ ...current, enrichment_legacy_consent: consent }]);
	expect(f.provider).not.toHaveBeenCalled();
});

it("holds 650 legacy notes through repeats, date metadata, body changes and restart", async () => {
	const f = fixture(),
		notes = await Promise.all(Array.from({ length: 650 }, (_, index) => note(index)));
	for (const current of notes) f.stored.set(`Keep/Manual ${current.enrichment_source!.id}.md`, current.text!);
	await f.run(notes);
	await f.run(notes.slice(200), FLAGS, new EnrichmentLedger(f.plugin));
	await f.run(notes.map((current) => ({ ...current, updated: "2030-01-01" })));
	expect(f.provider).not.toHaveBeenCalled();
});

it.each(["legacy", "review"] as const)(
	"keeps saved AI options from admitting legacy notes through the %s import caller",
	async (caller) => {
		const f = fixture(),
			current = await note();
		f.plugin.settings = {
			...DEFAULT_SETTINGS,
			...f.plugin.settings,
			frontmatterPascalCaseFixApplied: true,
			premiumFeatures: { ...DEFAULT_SETTINGS.premiumFeatures, updateTitle: true, suggestTags: true },
		};
		Object.assign(f.plugin, { subscriptionService: { isSubscriptionActive: jest.fn(async () => true) } });
		Object.assign(f.plugin.app.vault, { createFolder: f.adapter.mkdir });
		Object.assign(f.adapter, { stat: jest.fn(async () => ({ ctime: 1, mtime: 1, size: 100, type: "file" })) });
		f.stored.set("Keep/My Manual Title.md", current.text!);
		const fetch = jest
			.spyOn(keepApi, "fetchNotesWithPremiumFeatures")
			.mockResolvedValue({ notes: [current], total_notes: 1 });
		const capability = jest.spyOn(keepApi, "getReplayEpoch").mockResolvedValue(undefined);
		const generate = jest.spyOn(keepApi, "enrichLocalNotes").mockImplementation(f.provider);
		try {
			if (caller === "legacy") await runImportNotesFlow(f.plugin, false, () => "failed");
			else {
				const plan = await buildManualSyncPlan(f.plugin, "import", undefined, { kind: "all" });
				expect(plan).not.toBeNull();
				const result = await runPreparedSyncPlan(
					f.plugin,
					plan!,
					() => "failed",
					() => {}
				);
				expect(result.failed).not.toBe(true);
			}
			expect(fetch).toHaveBeenCalled();
			expect(generate).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			capability.mockRestore();
			generate.mockRestore();
		}
	}
);

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

it("treats an unknown in-flight application image as manual without another AI charge", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	const staged = await f.ledger.stage(first, "Keep/AI Proposed.md", undefined, first.text!);
	const edited = staged + "\nManual work before completion";
	f.stored.set("Keep/AI Proposed.md", edited);
	const restarted = new EnrichmentLedger(f.plugin);
	const [reused] = await f.run([current], FLAGS, restarted);
	expect(f.generated()).toBe(1);
	const protectedContent = await restarted.stage(reused, "Keep/AI Proposed.md", edited, edited);
	expect(extractFrontmatter(protectedContent)[2].tags).toEqual(["auto-work", "auto-topic"]);
	expect(protectedContent).toContain("Manual work before completion");
});

it("keeps a completed receipt durable through restart and a pure path move", async () => {
	const f = fixture(),
		current = await note();
	current.text = current.text!.replace("---\nDecision", 'Title: "AI Proposed"\n---\nDecision');
	const [first] = await f.run([current]);
	const after = await f.apply(first);
	f.stored.delete("Keep/AI Proposed.md");
	f.stored.set("Keep/Moved.md", after);
	const restarted = new EnrichmentLedger(f.plugin);
	await restarted.assertUploadAllowed("Keep/Moved.md");
	const uploaded = {
		...current.enrichment_source!,
		title: "AI Proposed",
		labels: ["auto-work", "auto-topic"],
		source_hash: "a".repeat(64),
	};
	await restarted.acknowledgeUpload("Keep/Moved.md", after, uploaded);
	await f.run([{ ...current, enrichment_source: uploaded }], FLAGS, restarted);
	expect(f.generated()).toBe(1);
});

it.each(["snapshot-response-lost", "journal-reset-fails", "journal-reset-response-lost"] as const)(
	"recovers snapshot-first application compaction after %s without new provider work",
	async (fault) => {
		const f = fixture(),
			notes = await Promise.all(Array.from({ length: 16 }, (_, index) => note(index)));
		const enriched = await f.run(notes);
		for (let index = 0; index < 15; index++) {
			const incoming = {
				...enriched[index],
				text: enriched[index].text!.replace("---\nDecision", 'Title: "AI Proposed"\n---\nDecision'),
			};
			await f.apply(incoming, `Keep/Note ${index}.md`);
		}
		f.adapter.write.mockImplementation(async (path, value) => {
			if (path === METADATA && fault === "snapshot-response-lost") {
				f.stored.set(path, value);
				throw new Error("Snapshot reply lost");
			}
			if (path === f.ledger.applicationPath && Object.keys(JSON.parse(value).journal.records).length === 0) {
				if (fault === "journal-reset-response-lost") f.stored.set(path, value);
				throw new Error("Journal reset interrupted");
			}
			f.stored.set(path, value);
		});
		await expect(f.ledger.stage(enriched[15], "Keep/Note 15.md", undefined, enriched[15].text!)).rejects.toThrow();
		f.adapter.write.mockImplementation(async (path, value) => {
			f.stored.set(path, value);
		});
		const restarted = new EnrichmentLedger(f.plugin);
		const reused = await f.run(notes, { ...FLAGS, suggest_tags: { ...FLAGS.suggest_tags!, prefix: "ai-" } }, restarted);
		expect(f.generated()).toBe(16);
		const before = f.stored.get("Keep/Note 0.md")!;
		const after = await restarted.stage(reused[0], "Keep/Note 0.md", before, before);
		expect(extractFrontmatter(after)[2].tags).toEqual(["ai-work", "ai-topic"]);
	}
);

it.each(["missing", "truncated", "checksum", "wrong-base"] as const)(
	"blocks %s application metadata without paid fallback",
	async (fault) => {
		const f = fixture(),
			current = await note(),
			[first] = await f.run([current]);
		await f.apply(first);
		const path = f.ledger.applicationPath;
		if (fault === "missing") f.stored.delete(path);
		else if (fault === "truncated") f.stored.set(path, "{");
		else {
			const envelope = JSON.parse(f.stored.get(path)!);
			if (fault === "checksum") envelope.checksum = "0".repeat(64);
			else {
				envelope.journal.base = "0".repeat(64);
				envelope.checksum = await hash(envelope.journal);
			}
			f.stored.set(path, JSON.stringify(envelope));
		}
		await expect(f.run([await note(0, "Changed content")], FLAGS, new EnrichmentLedger(f.plugin))).rejects.toThrow();
		expect(f.generated()).toBe(1);
	}
);

it("detects another writer's application journal change before paid dispatch", async () => {
	const f = fixture(),
		[first] = await f.run([await note()]);
	await f.apply(first);
	f.stored.set(f.ledger.applicationPath, f.stored.get(f.ledger.applicationPath)! + "\n");
	await expect(f.run([await note(0, "Changed content")])).rejects.toThrow("outside this session");
	expect(f.generated()).toBe(1);
});

it("does not alias an ungrounded legacy local body to the fetched source body", async () => {
	const f = fixture(),
		current = await note();
	const local = current.text!.replace("Decision: pause.", "My pending local body");
	f.stored.set("Keep/Manual.md", local);
	await f.run([{ ...current, enrichment_legacy_consent: chooseLegacyTags() }]);
	const uploaded = {
		...current.enrichment_source!,
		title: "Manual",
		body_hash: await hash("My pending local body"),
		source_hash: "b".repeat(64),
	};
	await f.ledger.acknowledgeUpload("Keep/Manual.md", local, uploaded);
	await f.run([{ ...current, enrichment_source: uploaded }]);
	expect(f.generated()).toBe(2);
});

it("rejects a cached application after its account changes", async () => {
	const f = fixture(),
		[first] = await f.run([await note()]);
	f.plugin.settings.email = "different@example.test";
	await expect(f.ledger.stage(first, "Keep/AI Proposed.md", undefined, first.text!)).rejects.toThrow("account");
});

it("rejects a superseded application after a newer source was observed", async () => {
	const f = fixture(),
		[first] = await f.run([await note()]);
	await f.run([await note(0, "Newer source")]);
	await expect(f.ledger.stage(first, "Keep/AI Proposed.md", undefined, first.text!)).rejects.toThrow("source");
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

it("keeps an unresolved tag conflict when a later title conflict is resolved", async () => {
	const f = fixture(),
		current = await note();
	current.enrichment_source!.labels = ["manual"];
	f.stored.set(
		"Keep/Manual.md",
		current.text!.replace("\n---\nDecision", '\nTitle: "Human 0"\ntags: []\n---\nDecision')
	);
	const run = async (source = current.enrichment_source!) =>
		(await f.run([{ ...current, enrichment_source: source }], { suggest_title: {} }))[0];
	const apply = async (incoming: PreNormalizedNote) => {
		const before = f.stored.get("Keep/Manual.md")!;
		const after = await f.ledger.stage(incoming, "Keep/Manual.md", before, before);
		f.stored.set("Keep/Manual.md", after);
		await f.ledger.finish(incoming);
	};
	await apply(await run());
	f.stored.set("Keep/Manual.md", f.stored.get("Keep/Manual.md")!.replace('tags: ["manual"]', "tags: []"));
	await apply(await run());
	f.stored.set("Keep/Manual.md", f.stored.get("Keep/Manual.md")!.replace("tags: []", 'tags: ["manual"]'));
	const removed = { ...current.enrichment_source!, labels: [], source_hash: "c".repeat(64) };
	await apply(await run(removed));
	await expect(f.ledger.assertUploadAllowed("Keep/Manual.md")).rejects.toThrow("both sides");
	f.stored.set(
		"Keep/Manual.md",
		f.stored.get("Keep/Manual.md")!.replace('Title: "Human 0"', 'Title: "Obsidian changed"')
	);
	const retitled = { ...removed, title: "Keep changed", source_hash: "d".repeat(64) };
	await run(retitled);
	f.stored.set(
		"Keep/Manual.md",
		f.stored.get("Keep/Manual.md")!.replace('Title: "Obsidian changed"', 'Title: "Keep changed"')
	);
	await run(retitled);
	await expect(f.ledger.assertUploadAllowed("Keep/Manual.md")).rejects.toThrow("both sides");
	expect(f.generated()).toBe(0);
});

it("retains Keep field changes through review preparation and selected execution", async () => {
	const f = fixture(),
		current = await note();
	current.enrichment_source!.labels = ["manual"];
	const [first] = await f.run([current]);
	await f.apply(first);
	const changed = {
		...current,
		enrichment_source: { ...current.enrichment_source!, title: "Keep edited", labels: [], source_hash: "d".repeat(64) },
	};
	const [prepared] = await f.run([changed], FLAGS, f.ledger, false);
	expect(prepared.local_enrichment?.title).toBe("Keep edited");
	expect(prepared.local_enrichment?.removeValues).toEqual(["manual"]);
	const [selected] = await f.run([prepared]);
	const applied = extractFrontmatter(await f.apply(selected))[2];
	expect(applied.Title).toBe("Keep edited");
	expect(applied.tags).toEqual(["auto-work", "auto-topic"]);
});

it.each([
	'Title: "Human 0"',
	'"Title": "Human 0"',
	"'Title': 'Human 0'",
	'title: "Human 0"',
	"Title: >-\n  Human 0",
	"'Title': |-\n  Human 0",
	'Title : "Human 0"',
])("preserves frontmatter when a Keep title edit updates %s", async (property) => {
	const f = fixture(),
		current = await note();
	const before = current.text!.replace("\n---\nDecision", `\n${property}\ncustom: preserved\n---\nDecision`);
	f.stored.set("Keep/Manual.md", before);
	const [initial] = await f.run([current], { suggest_title: {} });
	const first = await f.ledger.stage(initial, "Keep/Manual.md", before, before);
	f.stored.set("Keep/Manual.md", first);
	await f.ledger.finish(initial);
	const changed = {
		...current,
		enrichment_source: { ...current.enrichment_source!, title: "Keep edited", source_hash: "d".repeat(64) },
	};
	const [incoming] = await f.run([changed], { suggest_title: {} });
	const after = await f.ledger.stage(incoming, "Keep/Manual.md", first, first);
	const properties = extractFrontmatter(after)[2];
	expect(properties.Title).toBe("Keep edited");
	expect(properties.GoogleKeepUrl).toBe("https://keep.google.com/#NOTE/note-0");
	expect(properties.custom).toBe("preserved");
	expect(after).toContain("Decision: pause.");
	expect(f.generated()).toBe(0);
});

it("refuses a title replacement that would break a YAML alias before changing the note", async () => {
	const f = fixture(),
		current = await note();
	const before = current.text!.replace("\n---\nDecision", '\nTitle: &name "Human 0"\ncustom: *name\n---\nDecision');
	f.stored.set("Keep/Manual.md", before);
	const [initial] = await f.run([current], { suggest_title: {} });
	const first = await f.ledger.stage(initial, "Keep/Manual.md", before, before);
	f.stored.set("Keep/Manual.md", first);
	await f.ledger.finish(initial);
	const changed = {
		...current,
		enrichment_source: { ...current.enrichment_source!, title: "Keep edited", source_hash: "d".repeat(64) },
	};
	const [incoming] = await f.run([changed], { suggest_title: {} });
	f.adapter.write.mockClear();
	await expect(f.ledger.stage(incoming, "Keep/Manual.md", first, first)).rejects.toThrow("frontmatter");
	expect(f.stored.get("Keep/Manual.md")).toBe(first);
	expect(f.adapter.write).not.toHaveBeenCalled();
	expect(f.generated()).toBe(0);
});

it("advances the human field receipt only after a confirmed upload", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	const initial = await f.apply(first);
	const edited = initial.replace("---\nDecision", 'Title: "My uploaded title"\n---\nDecision');
	f.stored.set("Keep/AI Proposed.md", edited);
	const acknowledged = {
		...current.enrichment_source!,
		title: "My uploaded title",
		labels: ["auto-work", "auto-topic"],
		source_hash: "a".repeat(64),
	};
	await f.ledger.acknowledgeUpload("Keep/AI Proposed.md", edited, acknowledged);
	const remote = {
		...current,
		enrichment_source: { ...acknowledged, title: "Later Keep title", source_hash: "b".repeat(64) },
	};
	const [prepared] = await f.run([remote], FLAGS, f.ledger, false);
	const [selected] = await f.run([prepared]);
	expect(extractFrontmatter(await f.apply(selected))[2].Title).toBe("Later Keep title");
	await expect(f.ledger.assertUploadAllowed("Keep/AI Proposed.md")).resolves.toBeUndefined();
});

it("honors a Keep AI-tag removal after a local prefix change", async () => {
	const f = fixture(),
		current = await note(),
		[first] = await f.run([current]);
	const after = await f.apply(first);
	const uploaded = {
		...current.enrichment_source!,
		title: "AI Proposed",
		labels: ["auto-work", "auto-topic"],
		source_hash: "e".repeat(64),
	};
	await f.ledger.acknowledgeUpload("Keep/AI Proposed.md", after, uploaded);
	const flags = { ...FLAGS, suggest_tags: { ...FLAGS.suggest_tags!, prefix: "ai-" } };
	const [prefixed] = await f.run([{ ...current, enrichment_source: uploaded }], flags);
	await f.apply(prefixed);
	const [removed] = await f.run(
		[{ ...current, enrichment_source: { ...uploaded, labels: ["auto-topic"], source_hash: "f".repeat(64) } }],
		flags
	);
	expect(extractFrontmatter(await f.apply(removed))[2].tags).toEqual(["ai-topic"]);
	expect(f.generated()).toBe(1);
});

it("does not rewrite receipts for an identical applied image", async () => {
	const f = fixture(),
		[incoming] = await f.run([await note()]);
	const before = await f.apply(incoming);
	expect(incoming.processing_warnings).toBeUndefined();
	f.adapter.write.mockClear();
	expect(await f.ledger.stage(incoming, "Keep/AI Proposed.md", before, before)).toBe(before);
	await f.ledger.finish(incoming);
	expect(f.adapter.write).not.toHaveBeenCalled();
});
