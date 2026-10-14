import type KeepSidianPlugin from "@app/main";
import { buildManualSyncPlan, runPreparedSyncPlan } from "@app/main-sync-flows";
import { buildImportSyncPlan, RecoverablePreparationError } from "@features/keep/sync";
import { NetworkError, ParseError } from "@services/errors";
import { SyncCancellationError } from "@app/sync-cancel";
import { createMockPlugin } from "@test-utils/mocks/plugin";
import { DEFAULT_SETTINGS } from "../../types/keepsidian-plugin-settings";
import * as retryPolicy from "@features/keep/download-retry";
import type { GoogleKeepImportResponse, PremiumFeatureFlags } from "@integrations/server/keepApi";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { requestUrl, Notice } from "obsidian";

jest.mock("@app/sync-ui");
jest.mock("obsidian", () => ({
	...jest.requireActual<typeof import("../../../__mocks__/obsidian")>("../../../__mocks__/obsidian"),
	requestUrl: jest.fn(),
	Notice: jest.fn(),
}));

const runRetryPolicy = retryPolicy.retryDownload;
const checkpoint = "2024-01-01T00:00:00.000Z";
const startedAt = Date.parse("2026-06-01T12:00:00.000Z");

function response(data: unknown, status = 200): RequestUrlResponse {
	return { status, headers: {}, arrayBuffer: new ArrayBuffer(0), json: data, text: JSON.stringify(data) };
}

/** Transport fixture: real caller, API encoding/schema validation and retry policy run unchanged. */
function replayServer(total = 597, replay = true) {
	const requests: RequestUrlParam[] = [];
	const cached = new Map<string, GoogleKeepImportResponse>();
	const generatedPages: number[] = [];
	let enrichedNotes = 0;
	let failures = 0;
	let failPage = 40;
	let failStatus = 503;
	let failCode: string | undefined;
	let dropAfterProcessing = false;
	let epoch = "worker-a";
	let beforeResponse: (() => void) | undefined;
	(requestUrl as jest.Mock).mockImplementation(async (request: RequestUrlParam) => {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/capabilities")) {
			return response(replay ? { replay_version: 1, replay_epoch: epoch } : { replay_version: 0 });
		}
		if (!url.pathname.endsWith("/sync/premium/v2")) throw new Error(`Unexpected fixture request: ${url.pathname}`);
		requests.push(request);
		const page = Number(
			url.searchParams.get("cursor")?.split(":")[1] ?? Number(url.searchParams.get("offset")) / 4 + 1
		);
		const operation = request.headers?.["X-Sync-Operation"];
		if (operation && !operation.startsWith(`${epoch}:`)) {
			return response({ code: "sync_session_expired" }, 410);
		}
		const fails = page === failPage && failures > 0;
		if (fails && !dropAfterProcessing) {
			failures -= 1;
			beforeResponse?.();
			return response({ code: failCode }, failStatus);
		}
		const key = `${operation ?? "unsafe"}:${page}`;
		let data = cached.get(key);
		if (!data) {
			const flags = (JSON.parse(String(request.body)) as { feature_flags: PremiumFeatureFlags }).feature_flags;
			const offset = (page - 1) * 4;
			const notes = Array.from({ length: Math.max(0, Math.min(4, total - offset)) }, (_, index) => ({
				id: `note-${offset + index}`,
				title: `Note ${offset + index}`,
				text: `Body ${offset + index}`,
				archived: false,
			}));
			if (flags.suggest_title || flags.suggest_tags) enrichedNotes += notes.length;
			generatedPages.push(page);
			data = {
				notes,
				total_notes: total,
				...(offset + notes.length < total ? { next_cursor: `page:${page + 1}` } : {}),
			};
			if (replay) cached.set(key, data);
		}
		beforeResponse?.();
		if (fails) {
			failures -= 1;
			return response({ code: failCode }, failStatus);
		}
		return response(data);
	});
	return {
		requests,
		generatedPages,
		get enrichedNotes() {
			return enrichedNotes;
		},
		fail(page: number, count: number, status = 503, processed = false, code?: string) {
			failPage = page;
			failures = count;
			failStatus = status;
			dropAfterProcessing = processed;
			failCode = code;
		},
		setEpoch(value: string) {
			epoch = value;
		},
		beforeResponse(callback: () => void) {
			beforeResponse = callback;
		},
	};
}

describe("premium recovery through the manual sync caller", () => {
	let plugin: KeepSidianPlugin;
	let files: Map<string, string>;
	let folders: Set<string>;
	let elapsed: number;
	let cancel: boolean;
	let duringSleep: (() => void) | undefined;
	let now: jest.SpyInstance;

	beforeEach(() => {
		jest.restoreAllMocks();
		jest.clearAllMocks();
		now = jest.spyOn(Date, "now").mockReturnValue(startedAt);
		elapsed = 0;
		cancel = false;
		duringSleep = undefined;
		jest.spyOn(retryPolicy, "retryDownload").mockImplementation((fetch, options) =>
			runRetryPolicy(fetch, {
				...options,
				now: () => elapsed,
				random: () => 0.5,
				sleep: async (ms) => {
					elapsed += ms;
					duringSleep?.();
				},
			})
		);
		files = new Map();
		folders = new Set();
		const mock = createMockPlugin();
		mock.app.vault.adapter.exists.mockImplementation(async (path) => files.has(path) || folders.has(path));
		mock.app.vault.adapter.read.mockImplementation(async (path) => files.get(path) ?? "");
		mock.app.vault.adapter.write.mockImplementation(async (path, text) => {
			files.set(path, text);
		});
		mock.app.vault.createFolder.mockImplementation(async (path) => {
			folders.add(path);
		});
		plugin = Object.assign(mock, {
			settings: {
				...DEFAULT_SETTINGS,
				email: "fixture@example.com",
				token: "fixture-token",
				saveLocation: "Keep",
				frontmatterPascalCaseFixApplied: true,
				keepSidianLastSuccessfulSyncDate: checkpoint,
				premiumFeatures: {
					...DEFAULT_SETTINGS.premiumFeatures,
					includeNotesTerms: [],
					excludeNotesTerms: [],
					includeColors: [],
					archivedStatus: "all",
				},
			},
			subscriptionService: { isSubscriptionActive: jest.fn().mockResolvedValue(true) },
			processedNotes: 0,
			requireTwoWaySafeguards: jest.fn().mockResolvedValue({ allowed: true }),
			showTwoWaySafeguardNotice: jest.fn(),
			throwIfSyncCancelled: () => {
				if (cancel) throw new SyncCancellationError();
			},
		}) as unknown as KeepSidianPlugin;
	});

	afterEach(() => jest.restoreAllMocks());
	const records = () =>
		[...files.values()]
			.join("\n")
			.split("\n")
			.filter((line) => line.includes("Sync attempt "))
			.map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
	const assertNoImport = () => {
		expect([...files.keys()].every((path) => path.includes("_KeepSidianLogs"))).toBe(true);
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	};
	const prepare = (mode: "import" | "two-way" = "import") =>
		buildManualSyncPlan(plugin, mode, undefined, { kind: "all" });

	it.each(["import", "two-way"] as const)("fails page 40 safely with replay unavailable (%s)", async (mode) => {
		const server = replayServer(597, false);
		server.fail(40, 1);
		await expect(prepare(mode)).rejects.toBeInstanceOf(NetworkError);
		expect(server.requests).toHaveLength(40);
		expect(server.requests.every((request) => !request.headers?.["X-Sync-Operation"])).toBe(true);
		expect(records().filter((record) => record.event === "retry")).toHaveLength(0);
		expect(records().find((record) => record.event === "outcome")).toMatchObject({
			outcome: "failed",
			pageOrdinal: 40,
			fetchedCount: 156,
			total: 597,
			httpStatus: 503,
		});
		expect(elapsed).toBe(0);
		assertNoImport();
		expect(plugin.saveSettings).toHaveBeenCalled();
		expect(folders.size).toBeGreaterThan(0);
	});

	it.each([
		[false, "import"],
		[true, "import"],
		[false, "two-way"],
		[true, "two-way"],
	] as const)("resumes retained page 40 and imports exactly 597 notes (AI=%s, mode=%s)", async (ai, mode) => {
		plugin.settings.premiumFeatures.updateTitle = ai;
		plugin.settings.premiumFeatures.suggestTags = ai;
		const server = replayServer();
		server.fail(40, 3, 503, true);
		await expect(prepare(mode)).rejects.toBeInstanceOf(RecoverablePreparationError);
		const originalAttempt = plugin.settings.lastSyncAttempt?.id;
		expect(server.requests).toHaveLength(42);
		expect(elapsed).toBe(6000);
		expect(records().filter((record) => record.event === "retry")).toHaveLength(2);
		expect(records().find((record) => record.event === "outcome")).toMatchObject({
			pageOrdinal: 40,
			fetchedCount: 156,
			total: 597,
		});
		assertNoImport();
		const originalRequest = server.requests[0];
		now.mockReturnValue(startedAt + 60_000);
		const plan = (await prepare(mode))!;
		expect(server.requests[42].url).toBe(server.requests[39].url);
		expect(new Set(server.requests.map((request) => request.headers?.["X-Sync-Operation"]))).toEqual(
			new Set([originalRequest.headers?.["X-Sync-Operation"]])
		);
		expect(server.requests.every((request) => request.body === originalRequest.body)).toBe(true);
		for (const request of server.requests) {
			const query = new URL(request.url).searchParams;
			expect(query.get("created_lt")).toBe(new Date(startedAt).toISOString());
			expect(query.get("updated_lt")).toBe(query.get("created_lt"));
			expect(query.has("changed_gt")).toBe(false);
		}
		expect(JSON.parse(String(originalRequest.body))).toEqual({
			feature_flags: {
				keep_state_filter: { archived: "all" },
			},
		});
		expect(plan.importNotes?.map((note) => note.id)).toEqual(
			Array.from({ length: 597 }, (_, index) => `note-${index}`)
		);
		expect(server.generatedPages).toHaveLength(150);
		// Fetch and replay are always free of AI work, even when AI is enabled.
		expect(server.enrichedNotes).toBe(0);
		expect(records().some((record) => record.event === "review-ready" && record.resumedFrom === originalAttempt)).toBe(
			true
		);
		assertNoImport();
		await expect(
			runPreparedSyncPlan(
				plugin,
				plan,
				() => "unused",
				() => {}
			)
		).resolves.toEqual({});
		expect([...files.keys()].filter((path) => !path.includes("_KeepSidianLogs"))).toHaveLength(597);
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(new Date(startedAt - 1).toISOString());
	});

	it.each([1, 40, 150])("replays a lost successful response on page %s without repeating enrichment", async (page) => {
		plugin.settings.premiumFeatures.suggestTags = true;
		const server = replayServer();
		server.fail(page, 1, 504, true);
		const plan = (await prepare())!;
		expect(server.requests).toHaveLength(151);
		expect(server.requests[page - 1]).toEqual(server.requests[page]);
		expect(plan.importNotes).toHaveLength(597);
		expect(new Set(plan.importNotes?.map((note) => note.id)).size).toBe(597);
		expect(server.enrichedNotes).toBe(0);
		assertNoImport();
	});

	it.each([1, 150])("explicitly resumes after all responses for page %s are lost", async (page) => {
		plugin.settings.premiumFeatures.suggestTags = true;
		const server = replayServer();
		server.fail(page, 3, 504, true);
		await expect(prepare()).rejects.toBeInstanceOf(RecoverablePreparationError);
		expect(server.requests).toHaveLength(page + 2);
		assertNoImport();
		const plan = (await prepare())!;
		expect(server.requests[page + 2]).toEqual(server.requests[page - 1]);
		expect(plan.importNotes?.map((note) => note.id)).toEqual(
			Array.from({ length: 597 }, (_, index) => `note-${index}`)
		);
		expect(server.generatedPages).toHaveLength(150);
		expect(server.enrichedNotes).toBe(0);
		assertNoImport();
	});

	it("bounds repeated failures across an explicit resume", async () => {
		const server = replayServer();
		server.fail(40, 6);
		await expect(prepare()).rejects.toBeInstanceOf(RecoverablePreparationError);
		await expect(prepare()).rejects.toBeInstanceOf(RecoverablePreparationError);
		expect(server.requests).toHaveLength(45);
		expect(records().filter((record) => record.event === "retry")).toHaveLength(4);
		expect(
			records()
				.filter((record) => record.event === "outcome")
				.every((record) => record.fetchedCount === 156)
		).toBe(true);
		assertNoImport();
	});

	it("resumes a slow 650-note preparation after its original fourteen-minute window", async () => {
		plugin.settings.premiumFeatures.updateTitle = true;
		plugin.settings.premiumFeatures.suggestTags = true;
		const server = replayServer(650);
		server.beforeResponse(() => now.mockReturnValue(startedAt + server.requests.length * 35_000));
		server.fail(163, 3, 504, true);
		await expect(prepare()).rejects.toBeInstanceOf(RecoverablePreparationError);
		expect(Date.now() - startedAt).toBeGreaterThan(14 * 60_000);
		const original = server.requests[0];
		const plan = (await prepare())!;
		expect(plan.importNotes).toHaveLength(650);
		expect(new Set(plan.importNotes?.map((note) => note.id)).size).toBe(650);
		expect(server.generatedPages).toHaveLength(163);
		expect(server.enrichedNotes).toBe(0);
		expect(
			server.requests.every(
				(request) => request.headers?.["X-Sync-Operation"] === original.headers?.["X-Sync-Operation"]
			)
		).toBe(true);
		assertNoImport();
	});

	it("retains the resolved vault tag allowlist when resuming a lost initial response", async () => {
		plugin.settings.premiumFeatures.suggestTags = true;
		plugin.settings.premiumFeatures.limitToExistingTags = true;
		const lookup = jest.fn().mockReturnValue([]);
		plugin.app.vault.getMarkdownFiles = lookup;
		const server = replayServer(8);
		server.fail(1, 3, 504, true);
		const prepareImport = () => buildImportSyncPlan(plugin, plugin.settings.premiumFeatures);
		await expect(prepareImport()).rejects.toBeInstanceOf(RecoverablePreparationError);
		lookup.mockImplementation(() => {
			throw new Error("A retained preparation must not reread the vault allowlist");
		});
		const plan = await prepareImport();
		expect(plan.notes).toHaveLength(8);
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(server.requests.every((request) => request.body === server.requests[0].body)).toBe(true);
		expect(server.enrichedNotes).toBe(0);
		assertNoImport();
	});

	it.each([400, 401, 403, 410, 413])(
		"does not retry permanent HTTP %s and discards retained preparation",
		async (status) => {
			const server = replayServer(8);
			server.fail(2, 1, status, false, status === 413 ? "sync_snapshot_too_large" : "sync_session_expired");
			await expect(prepare()).rejects.toMatchObject({ status });
			expect(server.requests).toHaveLength(2);
			assertNoImport();
			await prepare();
			expect(new URL(server.requests[2].url).searchParams.get("offset")).toBe("0");
			expect(server.requests[2].headers?.["X-Sync-Operation"]).not.toBe(
				server.requests[0].headers?.["X-Sync-Operation"]
			);
		}
	);

	it("cancels during real policy backoff and restarts without retained pages", async () => {
		const server = replayServer(8);
		server.fail(2, 1);
		duringSleep = () => {
			cancel = true;
		};
		await expect(prepare()).rejects.toBeInstanceOf(SyncCancellationError);
		expect(server.requests).toHaveLength(2);
		assertNoImport();
		cancel = false;
		duringSleep = undefined;
		await prepare();
		expect(new URL(server.requests[2].url).searchParams.get("offset")).toBe("0");
	});

	it.each(["local-expiry", "epoch-change", "account", "flags", "scope", "restart"] as const)(
		"invalidates a paused snapshot after %s",
		async (change) => {
			const server = replayServer(8);
			server.fail(2, 3);
			await expect(prepare()).rejects.toBeInstanceOf(RecoverablePreparationError);
			const operation = server.requests[0].headers?.["X-Sync-Operation"];
			if (change === "local-expiry") now.mockReturnValue(startedAt + 14 * 60_000);
			if (change === "epoch-change") server.setEpoch("worker-b");
			if (change === "account") plugin.settings.email = "another-fixture@example.com";
			if (change === "flags") plugin.settings.premiumFeatures.suggestTags = true;
			if (change === "restart") plugin = { ...plugin } as KeepSidianPlugin;
			if (change === "epoch-change") {
				await expect(prepare()).rejects.toMatchObject({ status: 410, code: "sync_session_expired" });
				expect(server.requests[4].headers?.["X-Sync-Operation"]).toBe(operation);
			}
			const requestIndex = server.requests.length;
			const plan =
				change === "scope"
					? await buildManualSyncPlan(plugin, "import", undefined, { kind: "last-sync" })
					: await prepare();
			expect(new URL(server.requests[requestIndex].url).searchParams.get("offset")).toBe("0");
			expect(server.requests[requestIndex].headers?.["X-Sync-Operation"]).not.toBe(operation);
			expect(plan?.importNotes).toHaveLength(8);
			assertNoImport();
		}
	);

	it("freezes flags before backoff even if the settings object is mutated", async () => {
		plugin.settings.premiumFeatures.includeNotesTerms = ["original"];
		const server = replayServer(8);
		server.fail(1, 1);
		duringSleep = () => {
			plugin.settings.premiumFeatures.includeNotesTerms.push("changed");
			plugin.settings.premiumFeatures.suggestTags = true;
		};
		await prepare();
		expect(server.requests.every((request) => request.body === server.requests[0].body)).toBe(true);
		expect(server.enrichedNotes).toBe(0);
	});

	it("freezes flags before asynchronous subscription discovery", async () => {
		const server = replayServer(4);
		jest.spyOn(plugin.subscriptionService, "isSubscriptionActive").mockImplementation(async () => {
			plugin.settings.premiumFeatures.suggestTags = true;
			return true;
		});
		await prepare();
		expect(server.enrichedNotes).toBe(0);
	});

	it("allows only one preparation while replay capabilities are pending", async () => {
		let resolve!: (value: RequestUrlResponse) => void;
		let observed!: () => void;
		const called = new Promise<void>((done) => {
			observed = done;
		});
		(requestUrl as jest.Mock).mockImplementation(() => {
			observed();
			return new Promise((done) => {
				resolve = done;
			});
		});
		const first = buildImportSyncPlan(plugin, plugin.settings.premiumFeatures);
		await called;
		await expect(buildImportSyncPlan(plugin, plugin.settings.premiumFeatures)).rejects.toThrow("already running");
		(requestUrl as jest.Mock).mockResolvedValue(response({ notes: [], total_notes: 0 }));
		resolve(response({ replay_version: 1, replay_epoch: "worker-a" }));
		await first;
	});

	it.each([
		["empty continuation", { notes: [], total_notes: 3, next_cursor: "next:2" }],
		["repeated cursor", { notes: [{ id: "second" }], total_notes: 3, next_cursor: "next:1" }],
		["incomplete final page", { notes: [{ id: "second" }], total_notes: 3 }],
		["changed total", { notes: [{ id: "second" }], total_notes: 2 }],
		["duplicate identity", { notes: [{ id: "first" }, { id: "third" }], total_notes: 3 }],
		["exceeded total", { notes: [{ id: "second" }, { id: "third" }, { id: "fourth" }], total_notes: 3 }],
	] as const)("rejects %s before review or writes", async (_scenario, second) => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce(response({ replay_version: 1, replay_epoch: "worker-a" }))
			.mockResolvedValueOnce(response({ notes: [{ id: "first" }], total_notes: 3, next_cursor: "next:1" }))
			.mockResolvedValueOnce(response(second))
			.mockResolvedValue(response({ code: "sync_cursor_invalid" }, 400));
		await expect(prepare()).rejects.toBeInstanceOf(ParseError);
		expect(requestUrl).toHaveBeenCalledTimes(3);
		expect(records().filter((record) => record.event === "review-ready")).toHaveLength(0);
		assertNoImport();
	});

	it("rejects a cursor cycle through an earlier page", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce(response({ replay_version: 1, replay_epoch: "worker-a" }))
			.mockResolvedValueOnce(response({ notes: [{ id: "first" }], total_notes: 4, next_cursor: "next:1" }))
			.mockResolvedValueOnce(response({ notes: [{ id: "second" }], total_notes: 4, next_cursor: "next:2" }))
			.mockResolvedValueOnce(response({ notes: [{ id: "third" }], total_notes: 4, next_cursor: "next:1" }));
		await expect(prepare()).rejects.toBeInstanceOf(ParseError);
		expect(requestUrl).toHaveBeenCalledTimes(4);
		assertNoImport();
	});

	it.each(["total", "cursor"])("keeps the expected %s through a paused preparation", async (invariant) => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce(response({ replay_version: 1, replay_epoch: "worker-a" }))
			.mockResolvedValueOnce(response({ notes: [{ id: "first" }], total_notes: 3, next_cursor: "next:1" }))
			.mockResolvedValue(response({}, 503));
		await expect(prepare()).rejects.toBeInstanceOf(RecoverablePreparationError);
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce(
				response({ notes: [{ id: "second" }], ...(invariant === "cursor" ? { next_cursor: "next:1" } : {}) })
			)
			.mockResolvedValue(response({ code: "sync_cursor_invalid" }, 400));
		await expect(prepare()).rejects.toBeInstanceOf(ParseError);
		assertNoImport();
	});

	it("does not accept an offset snapshot that ends below its advertised total", async () => {
		(requestUrl as jest.Mock)
			.mockResolvedValueOnce(response({ replay_version: 0 }))
			.mockResolvedValueOnce(response({ notes: [{ id: "first" }], total_notes: 2 }))
			.mockResolvedValue(response({ notes: [] }));
		await expect(prepare()).rejects.toBeInstanceOf(ParseError);
		assertNoImport();
	});

	it("accepts a complete single-page snapshot without refetching it", async () => {
		const server = replayServer(4);
		const plan = await prepare();
		expect(plan?.importNotes).toHaveLength(4);
		expect(server.requests).toHaveLength(1);
		assertNoImport();
	});
});
