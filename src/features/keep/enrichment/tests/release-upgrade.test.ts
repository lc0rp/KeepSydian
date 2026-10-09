jest.mock("@app/sync-ui");
// Two bundles import the same source with different release-injected URL values.
// The getter models an app restart into the next build without changing disk.
jest.mock("../../../../config", () => ({
	get KEEPSIDIAN_SERVER_URL() {
		return process.env.REVIEW_RELEASE_URL;
	},
}));
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import type KeepSidianPlugin from "@app/main";
import { enrichImportNotes } from "@features/keep/enrichment/reuse";
import { EnrichmentLedger } from "@features/keep/enrichment/ledger";
import { hash } from "@features/keep/enrichment/state";
import * as api from "@integrations/server/keepApi";

const URL7 = "https://v2-1-0-beta-7---keepsidianserver-i55qr5tvea-uc.a.run.app";
const URL8 = "https://v2-1-0-beta-8---keepsidianserver-i55qr5tvea-uc.a.run.app";
// Release tooling accepts a numeric or alphanumeric/hyphen second identifier.
const releaseRoutes = [
	URL8,
	URL8.replace("beta-8", "beta-8a1"),
	URL8.replace("beta-8", "beta-8aa"),
	URL8.replace("beta-8", "alpha-preview"),
	URL8.replace("beta-8", "beta-build-42"),
];
const flags = { suggest_title: {}, suggest_tags: { max_tags: 5, prefix: "auto-", restrict_tags: false } };
const path = ".obsidian/plugins/keepsidian/enrichment-v1.json";
beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
beforeEach(() => {
	process.env.REVIEW_RELEASE_URL = URL7;
});
afterEach(() => {
	jest.restoreAllMocks();
	delete process.env.REVIEW_RELEASE_URL;
});
async function fixture() {
	const disk = new Map<string, string>();
	const adapter = {
		exists: jest.fn(async (p: string) => disk.has(p)),
		read: jest.fn(async (p: string) => {
			if (!disk.has(p)) throw new Error("missing");
			return disk.get(p)!;
		}),
		write: jest.fn(async (p: string, v: string) => {
			disk.set(p, v);
		}),
		mkdir: jest.fn(async (p: string) => {
			disk.set(p, "");
		}),
		list: jest.fn(async () => ({ files: [], folders: [] })),
	};
	const plugin = {
		settings: { email: "review@example.test", token: "synthetic", saveLocation: "Keep" },
		manifest: { id: "keepsidian" },
		app: { vault: { adapter, configDir: ".obsidian" } },
		saveSettings: jest.fn(async () => {}),
	} as unknown as KeepSidianPlugin;
	const note = {
		title: "Original",
		text: "---\nGoogleKeepUrl: https://keep.google.com/#NOTE/review-upgrade\n---\nBody",
		enrichment_source: {
			version: 1 as const,
			id: "review-upgrade",
			incarnation: await hash("birth"),
			body_hash: await hash("body"),
			source_hash: await hash("source"),
			title: "Original",
			labels: [],
			has_body: true,
		},
	};
	const preflight = jest.spyOn(api, "prepareLocalEnrichment").mockResolvedValue("synthetic-operation");
	const provider = jest.spyOn(api, "enrichLocalNotes").mockImplementation(async (_email, _token, rows) => ({
		results: rows.map((row) => ({
			source: row.source,
			status: "ready" as const,
			outputs: { title: "Accepted title", tags: ["accepted"] },
		})),
	}));
	const run = () => enrichImportNotes(plugin, [note], flags, new EnrichmentLedger(plugin));
	return { disk, plugin, note, preflight, provider, run };
}

it.each(releaseRoutes)("reuses an accepted result after a release upgrade to %s", async (endpoint) => {
	const f = await fixture();
	await f.run();
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
	// Completed output is durably cached, but the app stopped before note apply.
	expect(
		Object.values(JSON.parse(f.disk.get(path)!).state.cache).every((x) => (x as { status: string }).status === "ready")
	).toBe(true);
	process.env.REVIEW_RELEASE_URL = endpoint;
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
});

it.each(releaseRoutes)("retains an uncertain paid-attempt guard after a release upgrade to %s", async (endpoint) => {
	const f = await fixture();
	f.provider.mockRejectedValueOnce(new Error("paid result response lost"));
	await f.run();
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
	expect(
		Object.values(JSON.parse(f.disk.get(path)!).state.cache).every(
			(x) => (x as { status: string }).status === "uncertain"
		)
	).toBe(true);
	process.env.REVIEW_RELEASE_URL = endpoint;
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
});

it("preserves ownership and removals in the same record after a release upgrade", async () => {
	const f = await fixture();
	await f.run();
	const ledger = new EnrichmentLedger(f.plugin);
	const key = await ledger.key(f.note.enrichment_source);
	await ledger.transaction(async (state, save) => {
		state.records[key].manualTitle = true;
		state.records[key].suppressed = ["accepted"];
		state.records[key].suppressedValues = ["auto-accepted"];
		state.records[key].owned = { accepted: "auto-accepted" };
		await save();
	});
	process.env.REVIEW_RELEASE_URL = URL8;
	const result = await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
	expect(result[0].local_enrichment?.receipt).toBe(key);
	expect(result[0].title).toBe("Original");
	expect(result[0].tags).not.toContain("auto-accepted");
	const state = JSON.parse(f.disk.get(path)!).state;
	expect(Object.keys(state.records)).toEqual([key]);
	expect(state.records[key]).toMatchObject({
		manualTitle: true,
		suppressed: ["accepted"],
		suppressedValues: ["auto-accepted"],
		owned: { accepted: "auto-accepted" },
	});
});

it.each(["ready", "uncertain"])(
	"preserves an old unversioned %s ledger and blocks ambiguous paid fallback",
	async (status) => {
		const f = await fixture();
		if (status === "uncertain") f.provider.mockRejectedValueOnce(new Error("lost response"));
		await f.run();
		const envelope = JSON.parse(f.disk.get(path)!);
		delete envelope.state.namespaceVersion;
		envelope.checksum = await hash(envelope.state);
		const legacy = JSON.stringify(envelope);
		f.disk.set(path, legacy);
		process.env.REVIEW_RELEASE_URL = URL8;
		await expect(f.run()).rejects.toThrow("Saved AI history needs a compatibility review");
		expect(f.provider).toHaveBeenCalledTimes(1);
		expect(f.disk.get(path)).toBe(legacy);
	}
);

it("allows an empty old ledger to initialize without discarding any history", async () => {
	const f = await fixture();
	const state = { version: 1, records: {}, cache: {}, vocabulary: {} };
	f.disk.set(path, JSON.stringify({ state, checksum: await hash(state) }));
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(1);
	expect(JSON.parse(f.disk.get(path)!).state.namespaceVersion).toBe(1);
});

it("does not share an accepted result across accounts", async () => {
	const f = await fixture();
	await f.run();
	f.plugin.settings.email = "different@example.test";
	await f.run();
	expect(f.provider).toHaveBeenCalledTimes(2);
	expect(Object.keys(JSON.parse(f.disk.get(path)!).state.records)).toHaveLength(2);
});

it.each([
	"https://staging---keepsidianserver-i55qr5tvea-uc.a.run.app",
	"https://v2-1-0-beta-8---keepsidianserver-different-uc.a.run.app",
	"http://v2-1-0-beta-8---keepsidianserver-i55qr5tvea-uc.a.run.app",
	"https://v2-1-0-beta-8---keepsidianserver-i55qr5tvea-uc.a.run.app:8443",
	URL8 + "/staging",
	URL8 + "?environment=staging",
	URL8 + "#staging",
	"https://user@v2-1-0-beta-8---keepsidianserver-i55qr5tvea-uc.a.run.app",
	URL8 + ".evil.example",
	"http://localhost:8080",
])("retains an unrelated environment boundary for %s", async (endpoint) => {
	const f = await fixture();
	const official = await new EnrichmentLedger(f.plugin).namespace();
	process.env.REVIEW_RELEASE_URL = endpoint;
	expect(await new EnrichmentLedger(f.plugin).namespace()).not.toBe(official);
});

it.each([
	...releaseRoutes,
	"https://v2-1-0-beta-9---keepsidianserver-i55qr5tvea-uc.a.run.app",
	"https://v2-1-0-beta-6b---keepsidianserver-i55qr5tvea-uc.a.run.app",
	"https://v2-1-0---keepsidianserver-i55qr5tvea-uc.a.run.app",
	"https://sv0-1-0-beta-8---keepsidianserver-i55qr5tvea-uc.a.run.app",
	"https://keepsidianserver-i55qr5tvea-uc.a.run.app",
])("reuses the same trusted service namespace for %s", async (endpoint) => {
	const f = await fixture();
	const official = await new EnrichmentLedger(f.plugin).namespace();
	process.env.REVIEW_RELEASE_URL = endpoint;
	expect(await new EnrichmentLedger(f.plugin).namespace()).toBe(official);
});
