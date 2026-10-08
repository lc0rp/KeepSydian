jest.mock("@app/sync-ui");
jest.mock("@app/logging", () => ({
	logSync: jest.fn().mockResolvedValue(undefined),
	flushLogSync: jest.fn().mockResolvedValue(undefined),
	prepareSyncLog: jest.fn().mockResolvedValue(true),
}));
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import type KeepSidianPlugin from "@app/main";
import { DEFAULT_SETTINGS } from "../../../../types/keepsidian-plugin-settings";
import { buildManualSyncPlan, runPreparedSyncPlan, runImportNotesFlow } from "@app/main-sync-flows";
import * as keepApi from "@integrations/server/keepApi";
import { extractFrontmatter } from "../../domain/note";
import { initializeLocalDeletionTracking } from "../../local-deletions/tracking";
import { resolveNoteFolder } from "@services/note-path-resolver";
import { hash } from "../state";
import { chooseLegacyTags, type LegacyTagConsent } from "../consent";
import { EnrichmentLedger, getEnrichmentLedger } from "../ledger";

beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterEach(() => jest.restoreAllMocks());

async function fixture(pattern: string, ai = true) {
	const source = {
		version: 1 as const,
		id: "n1",
		incarnation: await hash("birth"),
		body_hash: await hash("Body"),
		source_hash: await hash("source"),
		title: "Human title",
		labels: [],
		has_body: true,
	};
	const note = {
		title: "Human title",
		created: "2024-01-01T12:00:00Z",
		text: "---\nGoogleKeepUrl: https://keep.google.com/#NOTE/n1\n---\nBody",
		enrichment_source: source,
	};
	const disk = new Map<string, string>();
	const directories = new Set<string>([""]);
	const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
	const mkdir = async (path: string) => {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join("/"));
	};
	const adapter = {
		exists: async (path: string) => disk.has(path) || directories.has(path),
		read: jest.fn(async (path: string) => {
			if (!disk.has(path)) throw new Error("Missing file");
			return disk.get(path)!;
		}),
		write: async (path: string, content: string) => {
			disk.set(path, content);
		},
		mkdir,
		stat: async () => ({ ctime: 1, mtime: 1, size: 100, type: "file" }),
		list: jest.fn(async (path: string) => {
			if (!directories.has(path)) throw new Error(`Missing directory ${path}`);
			return {
				files: [...disk.keys()].filter((key) => parent(key) === path),
				folders: [...directories].filter((key) => key !== path && parent(key) === path),
			};
		}),
	};
	const metadataCache = { getFileCache: jest.fn(() => null as { frontmatter?: Record<string, unknown> } | null) };
	const plugin = {
		settings: {
			...DEFAULT_SETTINGS,
			email: "synthetic@example.test",
			token: "synthetic",
			saveLocation: pattern,
			saveLocationMode: "custom",
			noteFileNamePattern: "{title}",
			frontmatterPascalCaseFixApplied: true,
			premiumFeatures: { ...DEFAULT_SETTINGS.premiumFeatures, updateTitle: ai, suggestTags: ai },
		},
		manifest: { id: "keepsidian" },
		app: {
			vault: {
				adapter,
				configDir: ".obsidian",
				createFolder: mkdir,
				read: async (file: { path: string }) => adapter.read(file.path),
				getMarkdownFiles: () => [...disk.keys()].filter((path) => path.endsWith(".md")).map((path) => ({ path })),
			},
			metadataCache,
		},
		saveSettings: jest.fn(async () => {}),
		throwIfSyncCancelled: jest.fn(),
		subscriptionService: { isSubscriptionActive: jest.fn(async () => true) },
	} as unknown as KeepSidianPlugin;
	const provider: jest.MockedFunction<typeof keepApi.enrichLocalNotes> = jest.fn(async (_email, _token, rows) => ({
		results: rows.map((row) => ({
			source: row.source,
			status: "ready" as const,
			outputs: {
				...(row.features.suggest_title ? { title: "AI title" } : {}),
				...(row.features.suggest_tags ? { tags: ["topic"] } : {}),
			},
		})),
	}));
	jest
		.spyOn(keepApi, "fetchNotesWithPremiumFeatures")
		.mockImplementation(async () => ({ notes: [note], total_notes: 1 }));
	jest.spyOn(keepApi, "fetchNotes").mockImplementation(async () => ({ notes: [note], total_notes: 1 }));
	jest.spyOn(keepApi, "getReplayEpoch").mockResolvedValue(undefined);
	jest.spyOn(keepApi, "enrichLocalNotes").mockImplementation(provider);
	const run = async (legacyTagConsent?: LegacyTagConsent, currentPlugin = plugin) => {
		const plan = await buildManualSyncPlan(currentPlugin, "import", { legacyTagConsent }, { kind: "all" });
		return runPreparedSyncPlan(
			currentPlugin,
			plan!,
			() => "failed",
			() => {}
		);
	};
	return { note, disk, directories, adapter, plugin, provider, run, mkdir, metadataCache };
}

const invalidIdentities = [
	["sequence", '["https://keep.google.com/#NOTE/n1"]'],
	["mapping", '{url: "https://keep.google.com/#NOTE/n1"}'],
	["null", "null"],
	["empty", '""'],
	["number", "1"],
	["boolean", "true"],
	["missing-id", '"https://keep.google.com/#NOTE/"'],
	["foreign-host", '"https://example.test/#NOTE/n1"'],
];
const invalidIdentityCases = invalidIdentities.flatMap(([kind, value]) =>
	[false, true].flatMap((ai) => ["legacy", "review"].map((caller) => ({ kind, value, ai, caller })))
);

it.each(invalidIdentityCases)("holds invalid identity $kind through $caller import (AI=$ai)", async ({ value, ai, caller }) => {
	const f = await fixture("Keep/{note.year}", ai);
	await f.mkdir("Keep/2020");
	const path = "Keep/2020/Manual.md";
	const text = f.note.text.replace("GoogleKeepUrl: https://keep.google.com/#NOTE/n1", `GoogleKeepUrl: ${value}`);
	f.disk.set(path, text);
	await initializeLocalDeletionTracking(f.plugin);
	f.plugin.settings.keepSidianLastSuccessfulSyncDate = "2024-01-01T00:00:00.000Z";
	const cutoff = f.plugin.settings.keepSidianLastSuccessfulSyncDate;
	if (caller === "review") await expect(f.run()).rejects.toThrow(/GoogleKeepUrl/);
	else {
		await runImportNotesFlow(f.plugin, false, () => "failed");
		expect(f.plugin.settings.lastSyncAttempt?.outcome).toBe("failed");
	}
	expect(f.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(cutoff);
	expect(f.provider).not.toHaveBeenCalled();
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(f.disk.get(path)).toBe(text);
});

it.each(["---\n---\nBody", "---\n# empty mapping\n---\nBody", "Body"])(
	"preserves legitimate unlinked Markdown during import: %j",
	async (text) => {
		const f = await fixture("Keep/{note.year}", false);
		await f.mkdir("Keep/2020");
		const path = "Keep/2020/Unrelated.md";
		f.disk.set(path, text);
		await initializeLocalDeletionTracking(f.plugin);
		await runImportNotesFlow(f.plugin, false, () => "failed");
		expect(f.plugin.settings.lastSyncAttempt?.outcome).toBe("success");
		expect(f.disk.get(path)).toBe(text);
		expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toHaveLength(2);
		expect(f.provider).not.toHaveBeenCalled();
	}
);

it.each(["google-keep-url: null", "GoogleKeepUrl: https://keep.google.com/#NOTE/n1\ngoogle-keep-url: null"].flatMap((identity) =>
	[false, true].flatMap((ai) => ["legacy", "review"].map((caller) => ({ identity, ai, caller })))
))("preserves invalid identity before pending migration through $caller (AI=$ai): $identity", async ({ identity, ai, caller }) => {
	const f = await fixture("Keep", ai);
	f.plugin.settings.frontmatterPascalCaseFixApplied = false;
	await f.mkdir("Keep");
	const path = "Keep/Manual.md";
	const text = `---\n${identity}\n---\nLocal body\n`;
	f.disk.set(path, text);
	await initializeLocalDeletionTracking(f.plugin);
	f.plugin.settings.keepSidianLastSuccessfulSyncDate = "2023-01-01T00:00:00.000Z";
	if (caller === "review") await expect(f.run()).rejects.toThrow(/GoogleKeepUrl/);
	else {
		await runImportNotesFlow(f.plugin, false, () => "failed");
		expect(f.plugin.settings.lastSyncAttempt?.outcome).toBe("failed");
	}
	expect(f.disk.get(path)).toBe(text);
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(f.provider).not.toHaveBeenCalled();
	expect(f.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe("2023-01-01T00:00:00.000Z");
});

it.each([false, true].flatMap((ai) => ["legacy", "review"].map((caller) => ({ ai, caller }))))(
	"preserves equivalent aliases during pending migration through $caller (AI=$ai)", async ({ ai, caller }) => {
		const f = await fixture("Keep", ai);
		f.plugin.settings.frontmatterPascalCaseFixApplied = false;
		await f.mkdir("Keep");
		const path = "Keep/Manual.md";
		f.disk.set(path, f.note.text.replace("\n---\nBody", '\ngoogle-keep-url: https://keep.google.com/u/0/#NOTE/%6E1\nTitle: "Manual title"\ntags: ["manual"]\n---\nBody'));
		await initializeLocalDeletionTracking(f.plugin);
		if (caller === "review") await f.run();
		else await runImportNotesFlow(f.plugin, false, () => "failed");
		expect(f.plugin.settings.lastSyncAttempt?.outcome).toBe("success");
		expect(extractFrontmatter(f.disk.get(path)!, true)[2]).toMatchObject({ Title: "Manual title", tags: ["manual"] });
		expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
		expect(f.provider).not.toHaveBeenCalled();
	}
);

it.each([
	["n1", "https://keep.google.com/u/7/?source=fixture#NOTE/%6E1"],
	["part-one", "https://keep.google.com/u/7/#NOTE/part%2Done"],
])("preserves a linked canonical identity %s without new AI work", async (id, url) => {
	const f = await fixture("Keep/{note.year}");
	f.note.enrichment_source.id = id;
	f.note.text = f.note.text.replace("#NOTE/n1", `#NOTE/${encodeURIComponent(id)}`);
	await f.mkdir("Keep/2020");
	const path = "Keep/2020/Manual.md";
	f.disk.set(path, f.note.text.replace(`https://keep.google.com/#NOTE/${encodeURIComponent(id)}`, url));
	await initializeLocalDeletionTracking(f.plugin);
	await f.run();
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(f.provider).not.toHaveBeenCalled();
});

it("holds an identity that becomes invalid between discovery and enrichment", async () => {
	const f = await fixture("Keep/{note.year}");
	await f.mkdir("Keep/2020");
	const path = "Keep/2020/Manual.md";
	f.disk.set(path, f.note.text);
	await initializeLocalDeletionTracking(f.plugin);
	const read = f.adapter.read.getMockImplementation()!;
	let reads = 0;
	f.adapter.read.mockImplementation(async (candidate) => {
		if (candidate === path && ++reads === 2)
			f.disk.set(path, f.note.text.replace("GoogleKeepUrl: https://keep.google.com/#NOTE/n1", "GoogleKeepUrl: null"));
		return read(candidate);
	});
	await expect(f.run()).rejects.toThrow(/GoogleKeepUrl/);
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(f.disk.get(path)).toContain("GoogleKeepUrl: null");
	expect(f.provider).not.toHaveBeenCalled();
});

it("holds a same-title late manual import through retries and restart, then reuses cached tags after consent", async () => {
	const f = await fixture("Keep/{note.year}");
	await initializeLocalDeletionTracking(f.plugin);
	const path = "Keep/2025/Manual.md";
	f.provider.mockImplementationOnce(async (_email, _token, rows) => {
		await f.mkdir("Keep/2025");
		f.disk.set(path, f.note.text.replace("\n---\nBody", '\nTitle: "Human title"\ntags: ["manual"]\n---\nBody'));
		return { results: rows.map((row) => ({ source: row.source, status: "ready" as const, outputs: { title: "AI title", tags: ["topic"] } })) };
	});
	await f.run();
	await f.run();
	const restarted = { ...f.plugin, settings: { ...f.plugin.settings } } as KeepSidianPlugin;
	await f.run(undefined, restarted);
	expect(extractFrontmatter(f.disk.get(path)!)[2]).toMatchObject({ Title: "Human title", tags: ["manual"] });
	expect(f.provider).toHaveBeenCalledTimes(1);
	await f.run(chooseLegacyTags(), restarted);
	await f.run(undefined, restarted);
	expect(extractFrontmatter(f.disk.get(path)!)[2]).toMatchObject({ Title: "Human title", tags: ["manual", "auto-topic"] });
	expect(f.provider).toHaveBeenCalledTimes(1);
	await getEnrichmentLedger(restarted).transaction(async (state) => {
		expect(Object.values(state.records)[0]).toMatchObject({ tagsAdmitted: true, owned: { topic: "auto-topic" } });
	});
});

it("persists cached tag consent when every suggestion is already a manual tag", async () => {
	const f = await fixture("Keep/{note.year}");
	await initializeLocalDeletionTracking(f.plugin);
	const path = "Keep/2020/Human title.md";
	f.provider.mockImplementationOnce(async (_email, _token, rows) => {
		await f.mkdir("Keep/2020");
		f.disk.set(path, f.note.text.replace("\n---\nBody", '\nTitle: "Human title"\ntags: ["auto-topic"]\n---\nBody'));
		return {
			results: rows.map((row) => ({
				source: row.source,
				status: "ready" as const,
				outputs: { title: "AI title", tags: ["topic"] },
			})),
		};
	});
	await f.run();
	await runImportNotesFlow(f.plugin, false, () => "failed");
	await runImportNotesFlow(f.plugin, false, () => "failed", {
		...f.plugin.settings.premiumFeatures,
		legacyTagConsent: chooseLegacyTags(),
	});
	expect(f.plugin.settings.lastSyncAttempt?.outcome).toBe("success");
	expect(f.provider).toHaveBeenCalledTimes(1);
	await new EnrichmentLedger(f.plugin).transaction(async (state) => {
		expect(Object.values(state.records)[0]).toMatchObject({ tagsAdmitted: true, owned: {} });
	});
	const restarted = { ...f.plugin, settings: { ...f.plugin.settings } } as KeepSidianPlugin;
	f.note.text = f.note.text.replace("Body", "Updated body");
	f.note.enrichment_source.body_hash = await hash("Updated body");
	f.note.enrichment_source.source_hash = await hash("Updated source");
	await f.run(undefined, restarted);
	expect(f.provider).toHaveBeenCalledTimes(2);
	expect(extractFrontmatter(f.disk.get(path)!)[2]).toMatchObject({ Title: "Human title", tags: ["auto-topic"] });
});

it.each([false, true])("uses current root identity instead of stale metadata (AI=%s)", async (ai) => {
	const f = await fixture("/", ai);
	await f.mkdir("Elsewhere");
	const path = "Elsewhere/Manual.md";
	f.disk.set(path, f.note.text);
	await initializeLocalDeletionTracking(f.plugin);
	f.metadataCache.getFileCache.mockReturnValue({ frontmatter: {} });
	await f.run();
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	f.metadataCache.getFileCache.mockReturnValue({ frontmatter: { GoogleKeepUrl: "https://keep.google.com/#NOTE/other" } });
	await f.run();
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(f.provider).not.toHaveBeenCalled();
});

it.each([false, true])("holds a byte-order marker before identity admission (AI=%s)", async (ai) => {
	const f = await fixture("/", ai);
	await f.mkdir("Elsewhere");
	const path = "Elsewhere/Manual.md";
	const text = "\uFEFF" + f.note.text;
	f.disk.set(path, text);
	await initializeLocalDeletionTracking(f.plugin);
	await expect(f.run()).rejects.toThrow(/byte-order marker/i);
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(f.disk.get(path)).toBe(text);
	expect(f.provider).not.toHaveBeenCalled();
});

it.each(["review", "legacy"])("holds unreadable identity candidates with AI off through %s", async (caller) => {
	const f = await fixture("Keep/{note.year}", false);
	await f.mkdir("Keep/2025");
	const path = "Keep/2025/Manual.md";
	f.disk.set(path, f.note.text);
	await initializeLocalDeletionTracking(f.plugin);
	const read = f.adapter.read.getMockImplementation()!;
	f.adapter.read.mockImplementation(async (candidate) => {
		if (candidate === path) throw new Error("Synthetic unreadable identity");
		return read(candidate);
	});
	if (caller === "review") await expect(f.run()).rejects.toThrow("Synthetic unreadable identity");
	else {
		await runImportNotesFlow(f.plugin, false, () => "failed");
		expect(f.plugin.settings.lastSyncAttempt?.outcome).toBe("failed");
	}
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(f.disk.get(path)).toBe(f.note.text);
	expect(f.provider).not.toHaveBeenCalled();
});

it.each(["bad-yaml", "unclosed-header"])("holds an uncertain identity in %s before AI or import", async (malformation) => {
	const f = await fixture("Keep/{note.year}");
	await f.mkdir("Keep/2025");
	const path = "Keep/2025/Manual.md";
	const text = f.note.text.replace("\n---\nBody", malformation === "bad-yaml" ? '\ntags: ["manual"\n---\nBody' : "\nBody");
	f.disk.set(path, text);
	await initializeLocalDeletionTracking(f.plugin);
	await expect(f.run()).rejects.toThrow(/frontmatter/i);
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(f.disk.get(path)).toBe(text);
	expect(f.provider).not.toHaveBeenCalled();
});

it.each(["review", "legacy"])("holds duplicate identities with AI disabled through %s", async (caller) => {
	const f = await fixture("Keep/{note.year}", false);
	for (const year of ["2024", "2025"]) {
		await f.mkdir(`Keep/${year}`);
		f.disk.set(`Keep/${year}/Manual.md`, f.note.text.replace("Body", "Earlier body"));
	}
	await initializeLocalDeletionTracking(f.plugin);
	const before = [...f.disk.entries()].filter(([path]) => path.endsWith(".md"));
	if (caller === "review") await expect(f.run()).rejects.toThrow("Multiple local notes share a Keep identity");
	else {
		await runImportNotesFlow(f.plugin, false, () => "failed");
		expect(f.plugin.settings.lastSyncAttempt?.outcome).toBe("failed");
	}
	expect([...f.disk.entries()].filter(([path]) => path.endsWith(".md"))).toEqual(before);
	expect(f.provider).not.toHaveBeenCalled();
});

it.each([false, true])("finds linked notes at the literal vault root with cold metadata (AI=%s)", async (ai) => {
	const f = await fixture("/", ai);
	await f.mkdir("Elsewhere");
	const path = "Elsewhere/Manual.md";
	f.disk.set(path, f.note.text.replace("\n---\nBody", '\nTitle: "Manual title"\ntags: ["manual"]\n---\nBody'));
	await initializeLocalDeletionTracking(f.plugin);
	await f.run();
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
	expect(extractFrontmatter(f.disk.get(path)!)[2]).toMatchObject({ Title: "Manual title", tags: ["manual"] });
	expect(f.provider).not.toHaveBeenCalled();
});

it.each([false, true])(
	"rechecks legacy tag admission for a manual import during AI (fresh choice=%s)",
	async (consent) => {
		const f = await fixture("Keep/{note.year}");
		await initializeLocalDeletionTracking(f.plugin);
		const path = "Keep/2025/Manual.md";
		f.provider.mockImplementationOnce(async (_email, _token, rows) => {
			await f.mkdir("Keep/2025");
			f.disk.set(path, f.note.text.replace("\n---\nBody", '\nTitle: "Manual title"\ntags: ["manual"]\n---\nBody'));
			return {
				results: rows.map((row) => ({
					source: row.source,
					status: "ready" as const,
					outputs: { title: "AI title", tags: ["topic"] },
				})),
			};
		});
		await f.run(consent ? chooseLegacyTags() : undefined);
		expect(f.provider).toHaveBeenCalledTimes(1);
		expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
		expect(extractFrontmatter(f.disk.get(path)!)[2]).toMatchObject({
			Title: "Manual title",
			tags: consent ? ["manual", "auto-topic"] : ["manual"],
		});
		const ledger = getEnrichmentLedger(f.plugin);
		await ledger.transaction(async (state) => {
			expect(Object.values(state.records)).toEqual([
				expect.objectContaining({
					manualTitle: true,
					tagsAdmitted: consent,
					owned: consent ? { topic: "auto-topic" } : {},
				}),
			]);
		});
		if (!consent) {
			await f.run();
			expect(f.provider).toHaveBeenCalledTimes(1);
		}
	}
);

it("holds a stale linked path that changed ownership after enumeration", async () => {
	const f = await fixture("Keep/{note.year}", false);
	await f.mkdir("Keep/2025");
	const path = "Keep/2025/Manual.md";
	const original = f.note.text.replace("Body", "Earlier body");
	f.disk.set(path, original);
	await initializeLocalDeletionTracking(f.plugin);
	const plan = await buildManualSyncPlan(f.plugin, "import", undefined, { kind: "all" });
	let moved = false;
	const createFolder = f.plugin.app.vault.createFolder;
	f.plugin.app.vault.createFolder = async (folder) => {
		const created = await createFolder(folder);
		if (folder === "Keep/2024" && !moved) {
			moved = true;
			f.disk.set("Keep/2025/Moved.md", original);
			f.disk.set(path, original.replace("#NOTE/n1", "#NOTE/n2").replace("Earlier body", "Other Keep note body"));
		}
		return created;
	};
	await expect(
		runPreparedSyncPlan(
			f.plugin,
			plan!,
			() => "failed",
			() => {}
		)
	).resolves.toMatchObject({ failed: true });
	expect(f.plugin.settings.lastSyncAttempt?.outcome).toBe("failed");
	expect(moved).toBe(true);
	expect(f.disk.get(path)).toContain("#NOTE/n2");
	expect(f.disk.get(path)).toContain("Other Keep note body");
	expect(f.disk.get("Keep/2025/Moved.md")).toBe(original);
	expect(f.provider).not.toHaveBeenCalled();
});

it.each(["Keep/{note.year}", "Keep/{now.date}", "Keep/{title}", "{note.year}/Keep", "Keep:Archive/{note.year}"])(
	"holds legacy AI and preserves the linked path for %s",
	async (pattern) => {
		const f = await fixture(pattern);
		const folder = resolveNoteFolder(f.plugin.app, f.plugin.settings, {
			...f.note,
			title: "Old title",
			now: "2024-01-02T12:00:00Z",
		});
		await f.mkdir(folder);
		const path = `${folder}/My Manual Title.md`;
		f.disk.set(path, f.note.text.replace("\n---\nBody", '\nTitle: "My Manual Title"\ntags: ["manual"]\n---\nBody'));
		await initializeLocalDeletionTracking(f.plugin);
		await f.run();
		expect(f.provider).not.toHaveBeenCalled();
		expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
		expect(extractFrontmatter(f.disk.get(path)!)[2]).toMatchObject({
			Title: "My Manual Title",
			tags: ["manual"],
			GoogleKeepUrl: "https://keep.google.com/#NOTE/n1",
		});
		await f.run();
		expect(f.provider).not.toHaveBeenCalled();
	}
);

it("reuses admitted results after a move between dated folders and a source date change", async () => {
	const f = await fixture("Keep/{note.year}");
	await initializeLocalDeletionTracking(f.plugin);
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
	const [path] = [...f.disk.keys()].filter((key) => key.endsWith(".md"));
	const moved = "Keep/2025/Moved.md";
	await f.mkdir("Keep/2025");
	f.disk.set(moved, f.disk.get(path)!.replace("\n---\nBody", '\nTitle: "AI title"\n---\nBody'));
	f.disk.delete(path);
	f.note.created = "2023-01-01T12:00:00Z";
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([moved]);
});

it.each([false, true])("blocks uncertain enumeration under a pattern before import (AI=%s)", async (ai) => {
	const f = await fixture("Keep/{note.year}", ai);
	await f.mkdir("Keep/2024");
	f.adapter.list.mockImplementation(async (path) => {
		if (path === "Keep/2024") throw new Error("Synthetic unreadable folder");
		return { files: [], folders: path === "Keep" ? ["Keep/2024"] : ["Keep"] };
	});
	await expect(f.run()).rejects.toThrow("Synthetic unreadable folder");
	expect([...f.disk.keys()].filter((path) => path.endsWith(".md"))).toEqual([]);
	expect(f.provider).not.toHaveBeenCalled();
});

it("grants only tags for a selected legacy note in a dated folder and reuses the result", async () => {
	const f = await fixture("Keep/{note.year}");
	await f.mkdir("Keep/2024");
	const path = "Keep/2024/Manual.md";
	f.disk.set(path, f.note.text.replace("\n---\nBody", '\nTitle: "My manual title"\ntags: ["manual"]\n---\nBody'));
	await initializeLocalDeletionTracking(f.plugin);
	await f.run(chooseLegacyTags());
	expect(f.provider).toHaveBeenCalledTimes(1);
	expect(f.provider.mock.calls[0][2][0].features).toEqual({
		suggest_tags: { max_tags: 5, prefix: "auto-", restrict_tags: false },
	});
	expect(extractFrontmatter(f.disk.get(path)!)[2]).toMatchObject({
		Title: "My manual title",
		tags: ["manual", "auto-topic"],
	});
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toEqual([path]);
});

it("holds ambiguous linked copies across dated folders before generating or choosing a target", async () => {
	const f = await fixture("Keep/{note.year}");
	for (const year of ["2024", "2025"]) {
		await f.mkdir(`Keep/${year}`);
		f.disk.set(`Keep/${year}/Manual.md`, f.note.text);
	}
	await initializeLocalDeletionTracking(f.plugin);
	await expect(f.run()).rejects.toThrow("Multiple local notes share a Keep identity");
	expect(f.provider).not.toHaveBeenCalled();
	expect([...f.disk.keys()].filter((key) => key.endsWith(".md"))).toHaveLength(2);
});
