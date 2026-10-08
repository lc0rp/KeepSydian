jest.mock("@app/logging", () => ({
	logSync: jest.fn().mockResolvedValue(undefined),
	flushLogSync: jest.fn().mockResolvedValue(undefined),
}));
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type KeepSidianPlugin from "@app/main";
import type { PreNormalizedNote } from "../../domain/note";
import { extractFrontmatter } from "../../domain/note";
import { buildExistingKeepNoteIndex } from "../../domain/noteLookup";
import { processAndSaveNote } from "../../sync";
import { getEnrichmentLedger } from "../ledger";
import { enrichImportNotes } from "../reuse";
import { hash } from "../state";
import type { enrichLocalNotes } from "@integrations/server/keepApi";

beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});

it("uses real file writes and production download receipts for 650 notes and restart reuse", async () => {
	const directory = await fs.mkdtemp(join(tmpdir(), "keepsydian-enrichment-"));
	const full = (path: string) => join(directory, path);
	let writtenBytes = 0;
	let writeCount = 0;
	const adapter = {
		exists: async (path: string) => {
			try {
				await fs.stat(full(path));
				return true;
			} catch {
				return false;
			}
		},
		read: async (path: string) => fs.readFile(full(path), "utf8"),
		write: async (path: string, value: string) => {
			writtenBytes += Buffer.byteLength(value, "utf8");
			writeCount += 1;
			await fs.writeFile(full(path), value);
		},
		mkdir: async (path: string) => {
			await fs.mkdir(full(path), { recursive: true });
		},
		list: async (path: string) => {
			let entries: string[];
			try {
				entries = await fs.readdir(full(path));
			} catch {
				return { files: [], folders: [] };
			}
			const files: string[] = [],
				folders: string[] = [];
			for (const name of entries)
				((await fs.stat(full(`${path}/${name}`))).isDirectory() ? folders : files).push(`${path}/${name}`);
			return { files, folders };
		},
		stat: async (path: string) => {
			const value = await fs.stat(full(path));
			return {
				ctime: value.birthtimeMs,
				mtime: value.mtimeMs,
				size: value.size,
				type: value.isDirectory() ? "folder" : "file",
			};
		},
	};
	const plugin = {
		settings: {
			email: "synthetic@example.test",
			token: "synthetic",
			saveLocation: "Keep",
			saveLocationMode: "custom",
			noteFileNamePattern: "{title}",
		},
		manifest: { id: "keepsidian" },
		app: { vault: { adapter, configDir: ".obsidian", createFolder: adapter.mkdir } },
		saveSettings: jest.fn(async () => {}),
		throwIfSyncCancelled: jest.fn(),
	} as unknown as KeepSidianPlugin;
	const provider: jest.MockedFunction<typeof enrichLocalNotes> = jest.fn(async (_email, _token, rows) => ({
		results: rows.map((row) => ({
			source: row.source,
			status: "ready" as const,
			outputs: { title: `Suggested ${row.source.id}`, tags: ["topic"] },
		})),
	}));
	try {
		const notes: PreNormalizedNote[] = await Promise.all(
			Array.from({ length: 650 }, async (_, index) => ({
				title: `Human ${index}`,
				text: `---\nGoogleKeepUrl: https://keep.google.com/#NOTE/n${index}\n---\nBody ${index}`,
				enrichment_source: {
					version: 1 as const,
					id: `n${index}`,
					incarnation: await hash([index, "birth"]),
					body_hash: await hash(`Body ${index}`),
					source_hash: await hash([index, "Body"]),
					title: `Human ${index}`,
					labels: [],
					has_body: true,
				},
			}))
		);
		const flags = { suggest_title: {}, suggest_tags: { max_tags: 5, prefix: "auto-", restrict_tags: false } };
		const enriched = await enrichImportNotes(plugin, notes, flags, getEnrichmentLedger(plugin), provider);
		const index = await buildExistingKeepNoteIndex(plugin.app, "Keep");
		for (const note of enriched) await processAndSaveNote(plugin, note, "Keep", undefined, index);
		expect((await adapter.list("Keep")).files).toHaveLength(650);
		const first = await adapter.read("Keep/Suggested n0.md");
		expect(extractFrontmatter(first)[2].tags).toEqual(["auto-topic"]);
		expect(extractFrontmatter(first)[2].KeepSidianLocalBaseline).toMatch(/^sha256:/);
		await adapter.write(
			"Keep/Suggested n0.md",
			first.replace('tags: ["auto-topic"]', 'tags: ["manual"]') + "\nLocal body edit"
		);
		const restartedPlugin = { ...plugin, settings: { ...plugin.settings } } as KeepSidianPlugin;
		const restarted = getEnrichmentLedger(restartedPlugin);
		const repeated = await enrichImportNotes(restartedPlugin, notes.slice(20), flags, restarted, provider);
		const repeatIndex = await buildExistingKeepNoteIndex(restartedPlugin.app, "Keep");
		const writesBeforeRepeat = writeCount;
		for (const note of repeated) await processAndSaveNote(restartedPlugin, note, "Keep", undefined, repeatIndex);
		expect(writeCount).toBe(writesBeforeRepeat);
		await enrichImportNotes(restartedPlugin, notes, flags, restarted, provider);
		expect(repeated).toHaveLength(630);
		expect(provider).toHaveBeenCalledTimes(41);
		const disk = await adapter.read(getEnrichmentLedger(plugin).path);
		expect(disk.length).toBeLessThan(8 * 1024 * 1024);
		expect(disk).not.toContain("Local body edit");
		console.info(
			JSON.stringify({
				syntheticNotes: 650,
				repeatedAppliedNotes: 630,
				providerBatches: provider.mock.calls.length,
				ledgerBytes: Buffer.byteLength(disk, "utf8"),
				totalWrittenBytes: writtenBytes,
				fileWrites: writeCount,
			})
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 60000);
