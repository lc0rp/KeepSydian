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
import { buildManualSyncPlan, runPreparedSyncPlan } from "@app/main-sync-flows";
import * as keepApi from "@integrations/server/keepApi";
import { extractFrontmatter } from "../../domain/note";
import { initializeLocalDeletionTracking } from "../../local-deletions/tracking";
import { resolveNoteFolder } from "@services/note-path-resolver";
import { hash } from "../state";
import { chooseLegacyTags, type LegacyTagConsent } from "../consent";

beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterEach(() => jest.restoreAllMocks());

async function fixture(pattern: string) {
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
		read: async (path: string) => {
			if (!disk.has(path)) throw new Error("Missing file");
			return disk.get(path)!;
		},
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
	const plugin = {
		settings: {
			...DEFAULT_SETTINGS,
			email: "synthetic@example.test",
			token: "synthetic",
			saveLocation: pattern,
			saveLocationMode: "custom",
			noteFileNamePattern: "{title}",
			frontmatterPascalCaseFixApplied: true,
			premiumFeatures: { ...DEFAULT_SETTINGS.premiumFeatures, updateTitle: true, suggestTags: true },
		},
		manifest: { id: "keepsidian" },
		app: {
			vault: {
				adapter,
				configDir: ".obsidian",
				createFolder: mkdir,
				getMarkdownFiles: () => [...disk.keys()].filter((path) => path.endsWith(".md")).map((path) => ({ path })),
			},
			metadataCache: { getFileCache: () => null },
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
	jest.spyOn(keepApi, "getReplayEpoch").mockResolvedValue(undefined);
	jest.spyOn(keepApi, "enrichLocalNotes").mockImplementation(provider);
	const run = async (legacyTagConsent?: LegacyTagConsent) => {
		const plan = await buildManualSyncPlan(plugin, "import", { legacyTagConsent }, { kind: "all" });
		return runPreparedSyncPlan(
			plugin,
			plan!,
			() => "failed",
			() => {}
		);
	};
	return { note, disk, directories, adapter, plugin, provider, run, mkdir };
}

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

it("blocks uncertain enumeration under a pattern before any AI request", async () => {
	const f = await fixture("Keep/{note.year}");
	await f.mkdir("Keep/2024");
	f.adapter.list.mockImplementation(async (path) => {
		if (path === "Keep/2024") throw new Error("Synthetic unreadable folder");
		return { files: [], folders: path === "Keep" ? ["Keep/2024"] : ["Keep"] };
	});
	await expect(f.run()).rejects.toThrow("Synthetic unreadable folder");
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
