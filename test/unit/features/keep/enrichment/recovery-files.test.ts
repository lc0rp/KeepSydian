jest.mock("@app/logging", () => ({
	logSync: jest.fn().mockResolvedValue(undefined),
	flushLogSync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../../../src/services/http", () => {
	const actual = jest.requireActual("../../../../../src/services/http");
	return {
		...actual,
		httpGetArrayBuffer: jest.fn(
			async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer
		),
	};
});
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type KeepSidianPlugin from "@app/main";
import type { PreNormalizedNote } from "../../../../../src/features/keep/domain/note";
import { buildExistingKeepNoteIndex } from "../../../../../src/features/keep/domain/noteLookup";
import { commitLastSuccessfulSyncDate, processAndSaveNote } from "../../../../../src/features/keep/sync";
import { EnrichmentLedger, getEnrichmentLedger } from "../../../../../src/features/keep/enrichment/ledger";
import { enrichImportNotes } from "../../../../../src/features/keep/enrichment/reuse";
import { ENRICHMENT_RECOVERY_RETENTION_MS, hash } from "../../../../../src/features/keep/enrichment/state";
import { KEEPSIDIAN_SERVER_URL } from "../../../../../src/config";
import { httpGetArrayBuffer } from "@services/http";
import { AccessV1RequestError } from "@services/errors";
import * as keepApi from "@integrations/server/keepApi";

beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
const FLAGS = { suggest_title: {}, suggest_tags: { max_tags: 5, prefix: "auto-", restrict_tags: false } };

async function harness() {
	const directory = await fs.mkdtemp(join(tmpdir(), "keepsidian-review-"));
	const full = (path: string) => join(directory, path);
	const adapter = {
		exists: async (path: string) =>
			fs.stat(full(path)).then(
				() => true,
				() => false
			),
		read: async (path: string) => fs.readFile(full(path), "utf8"),
		readBinary: async (path: string) => {
			const b = await fs.readFile(full(path));
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		},
		write: async (path: string, value: string) => {
			await fs.mkdir(join(full(path), ".."), { recursive: true });
			await fs.writeFile(full(path), value);
		},
		writeBinary: async (path: string, value: ArrayBuffer) => {
			await fs.mkdir(join(full(path), ".."), { recursive: true });
			await fs.writeFile(full(path), Buffer.from(value));
		},
		mkdir: async (path: string) => {
			await fs.mkdir(full(path), { recursive: true });
		},
		list: async (path: string) => {
			const entries = await fs.readdir(full(path), { withFileTypes: true }).catch(() => []);
			const files: string[] = [],
				folders: string[] = [];
			for (const e of entries) (e.isDirectory() ? folders : files).push(`${path}/${e.name}`);
			return { files, folders };
		},
		stat: async (path: string) => {
			const v = await fs.stat(full(path)).catch(() => null);
			return v && { ctime: v.birthtimeMs, mtime: v.mtimeMs, size: v.size, type: v.isDirectory() ? "folder" : "file" };
		},
	};
	const plugin = {
		settings: {
			keepSidianLastSuccessfulSyncDate: "2026-11-01T00:00:00.000Z",
			email: "synthetic@example.test",
			token: "synthetic",
			saveLocation: "Keep",
			saveLocationMode: "custom",
			noteFileNamePattern: "{title}",
			embedImportedImages: true,
		},
		manifest: { id: "keepsidian" },
		app: { vault: { adapter, configDir: ".obsidian", createFolder: adapter.mkdir } },
		saveSettings: jest.fn(async () => {}),
		throwIfSyncCancelled: jest.fn(),
	} as unknown as KeepSidianPlugin;
	return { adapter, plugin, directory };
}
async function keep(body: string, blobs = true): Promise<PreNormalizedNote> {
	return {
		title: "Human",
		id: "n1",
		updated: "2099-01-01T00:00:00.000Z",
		text: `---\nGoogleKeepUrl: https://keep.google.com/#NOTE/n1\n---\n${body}`,
		...(blobs ? { blob_urls: [`${KEEPSIDIAN_SERVER_URL}/keep/media/n1/b1`], blob_names: ["pic.png"] } : {}),
		enrichment_source: {
			version: 1 as const,
			id: "n1",
			incarnation: await hash(["n1", "birth"]),
			body_hash: await hash(body),
			source_hash: await hash(["n1", body]),
			title: "Human",
			labels: [],
			has_body: true,
		},
	};
}
beforeEach(() => {
	provider.mockClear();
	jest.mocked(httpGetArrayBuffer).mockClear();
});

const provider: jest.MockedFunction<typeof keepApi.enrichLocalNotes> = jest.fn(async (_e, _t, rows) => ({
	results: rows.map((row) => ({
		source: row.source,
		status: "ready" as const,
		outputs: {
			...(row.features.suggest_title ? { title: "Suggested" } : {}),
			...(row.features.suggest_tags ? { tags: ["topic"] } : {}),
		},
	})),
}));

it("updates an existing attachment note without treating its own first write as a manual edit", async () => {
	const { plugin, adapter, directory } = await harness();
	try {
		const ledger = getEnrichmentLedger(plugin);
		const [first] = await enrichImportNotes(plugin, [await keep("Body one", false)], FLAGS, ledger, provider);
		await processAndSaveNote(plugin, first, "Keep", undefined, await buildExistingKeepNoteIndex(plugin.app, "Keep"));
		const [second] = await enrichImportNotes(plugin, [await keep("Body two from Keep")], FLAGS, ledger, provider);
		await processAndSaveNote(plugin, second, "Keep", undefined, await buildExistingKeepNoteIndex(plugin.app, "Keep"));
		const saved = await adapter.read("Keep/Suggested.md");
		expect(saved).toContain("Body two from Keep");
		expect(httpGetArrayBuffer).toHaveBeenCalled();
		expect(saved).toContain("pic.png");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

it("preserves a real manual edit made while the attachment is downloading", async () => {
	const { plugin, adapter, directory } = await harness();
	try {
		const ledger = getEnrichmentLedger(plugin);
		const [first] = await enrichImportNotes(plugin, [await keep("Body one", false)], FLAGS, ledger, provider);
		await processAndSaveNote(plugin, first, "Keep", undefined, await buildExistingKeepNoteIndex(plugin.app, "Keep"));
		const [second] = await enrichImportNotes(plugin, [await keep("Body two from Keep")], FLAGS, ledger, provider);
		jest.mocked(httpGetArrayBuffer).mockImplementationOnce(async () => {
			const content = await adapter.read("Keep/Suggested.md");
			await adapter.write("Keep/Suggested.md", content + "\nMy manual edit during download");
			return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer;
		});
		await processAndSaveNote(plugin, second, "Keep", undefined, await buildExistingKeepNoteIndex(plugin.app, "Keep"));
		expect(httpGetArrayBuffer).toHaveBeenCalled();
		expect(await adapter.read("Keep/Suggested.md")).toContain("My manual edit during download");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

it.each([false, true])(
	"recovers a lost result after its own import, holds the incremental checkpoint until application, attachments=%s",
	async (blobs) => {
		const { plugin, adapter, directory } = await harness();
		let operation = 0;
		const prep = jest.spyOn(keepApi, "prepareLocalEnrichment").mockImplementation(async (_e, _t, _s, window) => {
			window?.(45_000);
			return `op-${++operation}`;
		});
		const paid = jest
			.spyOn(keepApi, "enrichLocalNotes")
			.mockImplementationOnce(provider)
			.mockRejectedValue(new Error("response lost after server finished"));
		const lookup = jest
			.spyOn(keepApi, "lookupLocalEnrichment")
			.mockImplementation(async (e, t, rows) => provider(e, t, rows));
		try {
			const ledger = getEnrichmentLedger(plugin);
			const [first] = await enrichImportNotes(plugin, [await keep("Body one", false)], FLAGS, ledger);
			await processAndSaveNote(plugin, first, "Keep", undefined, await buildExistingKeepNoteIndex(plugin.app, "Keep"));
			const changed = await keep("Body two from Keep", blobs);
			const [uncertain] = await enrichImportNotes(plugin, [changed], FLAGS, ledger);
			expect(uncertain.enrichment_uncertain).toBe(true);
			await processAndSaveNote(
				plugin,
				uncertain,
				"Keep",
				undefined,
				await buildExistingKeepNoteIndex(plugin.app, "Keep")
			);
			const prior = plugin.settings.keepSidianLastSuccessfulSyncDate;
			const completed = "2099-01-02T00:00:00.000Z";
			await commitLastSuccessfulSyncDate(plugin, completed);
			expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(prior);
			// The next default incremental fetch still includes this unchanged source.
			expect(Date.parse(changed.updated!)).toBeGreaterThan(Date.parse(prior!));
			const restarted = { ...plugin, settings: { ...plugin.settings } } as KeepSidianPlugin;
			const reopened = getEnrichmentLedger(restarted);
			expect(await reopened.hasRecoverableOperations()).toBe(true);
			const [recovered] = await enrichImportNotes(restarted, [uncertain], FLAGS, reopened, undefined, false);
			expect(recovered.enrichment_uncertain).toBe(false);
			expect(recovered.processing_warnings ?? []).not.toContain("local_enrichment_uncertain");
			expect(recovered.tags).toEqual(["auto-topic"]);
			await commitLastSuccessfulSyncDate(restarted, completed);
			expect(restarted.settings.keepSidianLastSuccessfulSyncDate).toBe(prior); // preview is not application
			await processAndSaveNote(
				restarted,
				recovered,
				"Keep",
				undefined,
				await buildExistingKeepNoteIndex(plugin.app, "Keep")
			);
			expect(await adapter.read("Keep/Suggested.md")).toContain("auto-topic");
			expect(await new EnrichmentLedger(restarted).hasRecoverableOperations()).toBe(false);
			await commitLastSuccessfulSyncDate(restarted, completed);
			expect(restarted.settings.keepSidianLastSuccessfulSyncDate).toBe(completed);
			expect(paid).toHaveBeenCalledTimes(2); // first content, then changed content; no replay
		} finally {
			prep.mockRestore();
			paid.mockRestore();
			lookup.mockRestore();
			await fs.rm(directory, { recursive: true, force: true });
		}
	}
);

it.each(["expired", "terminal", "other-account"])(
	"releases only the checkpoint hold on %s without granting paid retries",
	async (reason) => {
		const { plugin, directory } = await harness();
		const initial = Date.now();
		const clock = jest.spyOn(Date, "now").mockReturnValue(initial);
		const prep = jest.spyOn(keepApi, "prepareLocalEnrichment").mockImplementation(async (_e, _t, _s, window) => {
			window?.(45_000);
			return "lost-operation";
		});
		const paid = jest.spyOn(keepApi, "enrichLocalNotes").mockRejectedValue(new Error("lost"));
		const lookup = jest
			.spyOn(keepApi, "lookupLocalEnrichment")
			.mockRejectedValue(new AccessV1RequestError(410, "enrichment_replay_expired"));
		try {
			const ledger = getEnrichmentLedger(plugin),
				current = await keep("Body", false);
			await enrichImportNotes(plugin, [current], FLAGS, ledger);
			expect(await ledger.hasRecoverableOperations()).toBe(true);
			if (reason === "expired") clock.mockReturnValue(initial + ENRICHMENT_RECOVERY_RETENTION_MS);
			if (reason === "terminal") {
				clock.mockReturnValue(initial + 60_000);
				await enrichImportNotes(plugin, [current], FLAGS, ledger, undefined, false);
				await enrichImportNotes(plugin, [current], FLAGS, ledger, undefined, false);
				expect(lookup).toHaveBeenCalledTimes(1);
			}
			if (reason === "other-account") plugin.settings.email = "other@example.test";
			expect(await ledger.hasRecoverableOperations()).toBe(false);
			await commitLastSuccessfulSyncDate(plugin, "2099-01-02T00:00:00.000Z");
			expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe("2099-01-02T00:00:00.000Z");
			expect(paid).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
			prep.mockRestore();
			paid.mockRestore();
			lookup.mockRestore();
			await fs.rm(directory, { recursive: true, force: true });
		}
	}
);
