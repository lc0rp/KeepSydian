import type KeepSidianPlugin from "@app/main";
import {
	buildManualSyncPlan,
	openLatestSyncLogFlow,
	runPreparedSyncPlan,
	runImportNotesFlow,
} from "@app/main-sync-flows";
import { NetworkError, ParseError } from "@services/errors";
import { createMockPlugin } from "@test-utils/mocks/plugin";
import { DEFAULT_SETTINGS } from "../../types/keepsidian-plugin-settings";
import * as api from "@integrations/server/keepApi";
import * as imports from "@features/keep/sync";
import * as pushes from "@features/keep/push";
import * as lookup from "@features/keep/domain/noteLookup";
import { SyncAttempt, safeSyncError } from "@app/sync-attempt";
import { SyncCancellationError } from "@app/sync-cancel";
import { logSync } from "@app/logging";
import { SyncProgressModal } from "@ui/modals/SyncProgressModal";
import { Notice } from "obsidian";
import { createPreparedSyncPlanFixture } from "@test-utils/fixtures/sync-plan";
import type { NoteForPush } from "@features/keep/push/collectNotes";
import * as retryPolicy from "@features/keep/download-retry";

const runRetryPolicy = retryPolicy.retryDownload;

jest.mock("@app/sync-ui");

describe("persistent sync attempt preparation", () => {
	let plugin: KeepSidianPlugin;
	let files: Map<string, string>;
	let folders: Set<string>;
	let saved: unknown;
	const checkpoint = "2024-01-01T00:00:00.000Z";

	beforeEach(() => {
		jest.restoreAllMocks();
		jest.spyOn(api, "getReplayEpoch").mockResolvedValue(undefined);
		jest.spyOn(retryPolicy, "retryDownload").mockImplementation((fetch, options) => {
			let elapsed = 0;
			return runRetryPolicy(fetch, {
				...options,
				now: () => elapsed,
				random: () => 0.5,
				sleep: async (ms) => {
					elapsed += ms;
				},
			});
		});
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
				email: "dummy@example.com",
				token: "dummy-token",
				saveLocation: "Keep",
				keepSidianLastSuccessfulSyncDate: checkpoint,
				frontmatterPascalCaseFixApplied: true,
			},
			subscriptionService: { isSubscriptionActive: jest.fn().mockResolvedValue(false) },
			processedNotes: 0,
			requireTwoWaySafeguards: jest.fn().mockResolvedValue({ allowed: true }),
			showTwoWaySafeguardNotice: jest.fn(),
		}) as unknown as KeepSidianPlugin;
		plugin.saveSettings = jest.fn(async () => {
			saved = JSON.parse(JSON.stringify(plugin.settings));
		});
	});

	const logs = () => [...files.values()].join("\n");
	const records = () =>
		logs()
			.split("\n")
			.filter((line) => line.includes("Sync attempt "))
			.map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
	const outcomes = () => records().filter((record) => record.event === "outcome");
	const run = (plan: NonNullable<Awaited<ReturnType<typeof buildManualSyncPlan>>>) =>
		runPreparedSyncPlan(
			plugin,
			plan,
			() => "unused",
			() => undefined
		);
	const createModal = () =>
		new SyncProgressModal(plugin.app, {
			createSyncAttempt: (mode) => new SyncAttempt(plugin, mode),
			getLastAttempt: () => plugin.settings.lastSyncAttempt,
			buildSyncPlan: (mode, callbacks, scope) => buildManualSyncPlan(plugin, mode, callbacks, scope),
			runSyncPlan: run,
			onOpenSyncLog: () => openLatestSyncLogFlow(plugin),
			getTwoWayGate: () => ({ allowed: true, reasons: [] }),
			getLastSuccessfulDownloadDate: () => checkpoint,
			openTwoWaySettings: () => undefined,
			getCurrentMode: () => null,
			getCurrentPhaseLabel: () => null,
			isSupporterActive: async () => false,
			renderImportOptions: () => undefined,
		});

	it.each([false, true])(
		"persists an exhausted first-page 504 with debug=%s and retains its original cause",
		async (debug) => {
			plugin.settings.oauthDebugMode = debug;
			const error = new NetworkError("dummy-token dummy@example.com", 504, new Error("dummy-supporter-key"));
			jest.spyOn(api, "fetchNotes").mockRejectedValue(error);
			await expect(buildManualSyncPlan(plugin, "import")).rejects.toMatchObject({ status: 504, cause: error });
			expect(api.fetchNotes).toHaveBeenCalledTimes(3);
			const terminal = records().filter((record) => record.event === "outcome");
			expect(terminal).toHaveLength(1);
			expect(terminal[0]).toMatchObject({
				outcome: "failed",
				phase: "fetch",
				httpStatus: 504,
				pageOrdinal: 1,
				fetchedCount: 0,
			});
			expect(terminal[0].elapsedMs).toEqual(expect.any(Number));
			expect(logs()).not.toMatch(/dummy-token|dummy@example.com|dummy-supporter-key/);
			expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
			expect([...files.keys()].every((path) => path.includes("_KeepSidianLogs"))).toBe(true);
			expect(saved).toMatchObject({ lastSyncAttempt: { outcome: "failed" }, lastSyncLogPath: expect.any(String) });
		}
	);

	it.each(["offset", "cursor"])(
		"records the actual later page and fetched count for %s pagination",
		async (pagination) => {
			const error = new NetworkError("private-note-body", 504);
			jest
				.spyOn(api, "fetchNotes")
				.mockResolvedValueOnce({
					notes: [{ title: "private-note-title", text: "private-note-body" }],
					total_notes: 501,
					...(pagination === "cursor" ? { next_cursor: "private-cursor" } : {}),
				})
				.mockRejectedValue(error);
			await expect(buildManualSyncPlan(plugin, "import", undefined, { kind: "all" })).rejects.toMatchObject({
				status: 504,
				cause: error,
			});
			expect(records().find((record) => record.event === "outcome")).toMatchObject({
				pageOrdinal: 2,
				paginationMode: pagination,
				fetchedCount: 1,
				total: 501,
				requestedLimit: 100,
			});
			expect(logs()).not.toMatch(/private-cursor|private-note-title|private-note-body/);
		}
	);

	it("logs a subscription failure before a plan exists", async () => {
		const error = new Error("dummy-token");
		jest.spyOn(plugin.subscriptionService, "isSubscriptionActive").mockRejectedValue(error);
		await expect(buildManualSyncPlan(plugin, "import")).rejects.toBe(error);
		expect(records().find((record) => record.event === "outcome")).toMatchObject({
			phase: "subscription",
			outcome: "failed",
		});
	});

	it("resumes the failed cursor with the original cutoff and links attempts without writing notes", async () => {
		const fetch = jest
			.spyOn(api, "fetchNotes")
			.mockResolvedValueOnce({ notes: [{ id: "first", title: "First" }], total_notes: 2, next_cursor: "next-page" })
			.mockRejectedValue(new NetworkError("temporary", 504));
		await expect(buildManualSyncPlan(plugin, "import")).rejects.toBeInstanceOf(imports.RecoverablePreparationError);
		const originalAttempt = plugin.settings.lastSyncAttempt?.id;
		expect(fetch).toHaveBeenCalledTimes(4);
		plugin.settings.keepSidianLastSuccessfulSyncDate = "2025-01-01T00:00:00.000Z";
		fetch.mockReset().mockResolvedValue({ notes: [{ id: "second", title: "Second" }], total_notes: 2 });
		const plan = await buildManualSyncPlan(plugin, "import");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][4]).toEqual({ changed_gt: checkpoint });
		expect(fetch.mock.calls[0][5]).toBe("next-page");
		expect(plan?.importNotes?.map((note) => note.id)).toEqual(["first", "second"]);
		expect(records().some((record) => record.resumedFrom === originalAttempt && record.event === "review-ready")).toBe(
			true
		);
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe("2025-01-01T00:00:00.000Z");
		expect([...files.keys()].every((path) => path.includes("_KeepSidianLogs"))).toBe(true);
	});

	it("persists the new failed log navigation across a restart", async () => {
		jest.spyOn(api, "fetchNotes").mockRejectedValue(new NetworkError("timeout", 504));
		await expect(buildManualSyncPlan(plugin, "import")).rejects.toBeInstanceOf(NetworkError);
		const restarted = {
			...plugin,
			settings: saved,
			lastSyncLogPath: plugin.settings.lastSyncLogPath,
			app: { ...plugin.app, workspace: { openLinkText: jest.fn().mockResolvedValue(undefined) } },
		} as unknown as KeepSidianPlugin;
		await openLatestSyncLogFlow(restarted);
		expect(restarted.app.workspace.openLinkText).toHaveBeenCalledWith(plugin.settings.lastSyncLogPath, "", true);
	});

	it("records review readiness without declaring success, then completes one lifecycle", async () => {
		jest.spyOn(api, "fetchNotes").mockResolvedValue({ notes: [] });
		const plan = (await buildManualSyncPlan(plugin, "import"))!;
		expect(outcomes()).toHaveLength(0);
		expect(records().filter((record) => record.event === "start")).toHaveLength(1);
		expect(records().some((record) => record.event === "review-ready")).toBe(true);
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
		await run(plan);
		expect(outcomes()).toHaveLength(1);
		expect(outcomes()[0]).toMatchObject({ outcome: "success", attemptId: plan.attempt?.id });
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(plan.completionDate);
		await plan.attempt?.finish("abandoned");
		expect(outcomes()).toHaveLength(1);
	});

	it.each(["failed", "canceled"])("does not advance the checkpoint on %s execution", async (outcome) => {
		jest.spyOn(api, "fetchNotes").mockResolvedValue({ notes: [] });
		const plan = (await buildManualSyncPlan(plugin, "import"))!;
		jest
			.spyOn(imports, "importSelectedGoogleKeepNotes")
			.mockRejectedValue(outcome === "canceled" ? new SyncCancellationError() : new Error("dummy-token"));
		await run(plan);
		expect(outcomes()).toHaveLength(1);
		expect(outcomes()[0]).toMatchObject({ outcome, phase: "execution" });
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
		expect(logs()).not.toContain("dummy-token");
	});

	it.each([true, false])(
		"shares the two-way attempt and defers its checkpoint through upload (success=%s)",
		async (success) => {
			jest.spyOn(api, "fetchNotes").mockResolvedValue({ notes: [] });
			const push = createPreparedSyncPlanFixture("push", "upload", []);
			jest.spyOn(pushes, "buildPushSyncPlan").mockResolvedValue({ plan: push.plan, notesToPush: [] });
			const plan = (await buildManualSyncPlan(plugin, "two-way"))!;
			const result = await run(plan);
			expect(result.nextPlan?.attempt).toBe(plan.attempt);
			expect(outcomes()).toHaveLength(0);
			expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
			if (!success) jest.spyOn(pushes, "pushGoogleKeepNotes").mockRejectedValue(new NetworkError("dummy-key", 504));
			await run(result.nextPlan!);
			expect(outcomes()).toHaveLength(1);
			expect(outcomes()[0].outcome).toBe(success ? "success" : "failed");
			expect(records().filter((record) => record.event === "start")).toHaveLength(1);
			expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(success ? plan.completionDate : checkpoint);
		}
	);

	it("uses the same context for a scheduled failure", async () => {
		jest.spyOn(api, "fetchNotes").mockRejectedValue(new NetworkError("dummy-token", 504));
		await runImportNotesFlow(plugin, true, () => "unused");
		expect(outcomes()).toHaveLength(1);
		expect(outcomes()[0]).toMatchObject({ source: "scheduled", phase: "fetch", httpStatus: 504, outcome: "failed" });
	});

	it.each(["rejected", "disk-error"])(
		"marks per-note upload %s as failed without advancing the checkpoint",
		async (failure) => {
			const note: NoteForPush = {
				fullPath: "Keep/private-note-title.md",
				relativePath: "private-note-title.md",
				title: "private-note-title",
				content: "private-note-body",
				body: "private-note-body",
				frontmatter: "",
				lastSyncedDate: null,
				modifiedSinceLastSync: true,
				attachments: [],
				updatedAttachmentNames: [],
				missingAttachments: [],
			};
			const prepared = createPreparedSyncPlanFixture("push", "upload", [
				{
					id: `upload:0:${note.fullPath}`,
					path: note.fullPath,
					mode: "push",
					stage: "upload",
					title: note.title,
					action: "upload",
					label: "Upload",
					selectable: true,
					selected: true,
					selectionLocked: false,
				},
			]);
			prepared.pushNotes = [note];
			prepared.completionDate = "2024-03-01T00:00:00.000Z";
			jest.spyOn(api, "pushNotes").mockResolvedValue({
				results: [
					{
						path: note.relativePath,
						success: failure !== "rejected",
						error: "dummy-supporter-key private-note-body",
					},
				],
			});
			if (failure === "disk-error") {
				jest.spyOn(plugin.app.vault.adapter, "write").mockImplementation(async (path, text) => {
					if (path === note.fullPath) throw new Error("private-note-body dummy-supporter-key");
					files.set(path, text);
				});
			}
			expect(await run(prepared)).toMatchObject({ failed: true });
			expect(outcomes()).toMatchObject([{ outcome: "failed", phase: "upload" }]);
			expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
			expect(logs()).not.toMatch(/private-note-title|private-note-body|dummy-supporter-key/);
		}
	);

	it("records schema and plan-building causes without leaking their exception text", async () => {
		const schemaError = new ParseError("dummy-token response body");
		jest.spyOn(api, "fetchNotes").mockRejectedValueOnce(schemaError).mockResolvedValue({ notes: [] });
		await expect(buildManualSyncPlan(plugin, "import")).rejects.toBe(schemaError);
		const planError = new Error("dummy-note-title");
		jest.spyOn(lookup, "buildExistingKeepNoteIndex").mockRejectedValue(planError);
		await expect(buildManualSyncPlan(plugin, "import")).rejects.toBe(planError);
		expect(outcomes()).toMatchObject([
			{ phase: "fetch", errorKind: "parse" },
			{ phase: "plan", outcome: "failed" },
		]);
		expect(logs()).not.toMatch(/dummy-token|dummy-note-title|response body/);
	});

	it("does not mask a preparation error when append and settings persistence also fail", async () => {
		const original = new NetworkError("dummy-original", 504);
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		jest.spyOn(api, "fetchNotes").mockRejectedValue(original);
		jest.spyOn(plugin.app.vault.adapter, "write").mockImplementation(async (path, text) => {
			if (text) throw new Error("dummy-storage-secret");
			files.set(path, text);
		});
		jest.spyOn(plugin, "saveSettings").mockRejectedValue(new Error("dummy-settings-secret"));
		await expect(buildManualSyncPlan(plugin, "import")).rejects.toMatchObject({ status: 504, cause: original });
		expect(plugin.settings.lastSyncAttempt).toMatchObject({ outcome: "failed", httpStatus: 504, logUnavailable: true });
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/dummy-original|dummy-storage-secret|dummy-settings-secret/);
		expect(Notice).toHaveBeenCalledWith(expect.stringContaining("sync log or attempt history unavailable"));
		await openLatestSyncLogFlow(plugin);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining(`sync log unavailable for attempt ${plugin.settings.lastSyncAttempt?.id}`)
		);
	});

	it("retains the original storage initialization failure using the safe fallback", async () => {
		const error = new Error("dummy-storage-secret");
		jest.spyOn(console, "warn").mockImplementation(() => undefined);
		jest.spyOn(plugin.app.vault, "createFolder").mockRejectedValue(error);
		await expect(buildManualSyncPlan(plugin, "import")).rejects.toBe(error);
		expect(saved).toMatchObject({ lastSyncAttempt: { outcome: "failed", phase: "storage", logUnavailable: true } });
	});

	it("flushes queued entries before the terminal record and serializes concurrent appends", async () => {
		const attempt = new SyncAttempt(plugin, "import");
		await attempt.start();
		await Promise.all(Array.from({ length: 20 }, (_, index) => logSync(plugin, `safe-line-${index}`)));
		await logSync(plugin, "safe-queued-line", { batchSize: 100 });
		await Promise.all([attempt.finish("failed"), attempt.finish("canceled"), attempt.fail(new Error("dummy-secret"))]);
		for (let index = 0; index < 20; index += 1) expect(logs()).toContain(`safe-line-${index}\n`);
		expect(logs().indexOf("safe-queued-line")).toBeLessThan(logs().indexOf('"event":"outcome"'));
		expect(outcomes()).toHaveLength(1);
	});

	it("does not let an older attempt overwrite the latest attempt with identical timestamps", async () => {
		jest.spyOn(Date, "now").mockReturnValue(1000);
		const first = new SyncAttempt(plugin, "import");
		const second = new SyncAttempt(plugin, "push");
		await first.start();
		await second.start();
		await first.finish("abandoned");
		expect(plugin.settings.lastSyncAttempt?.id).toBe(second.id);
		expect(first.id).not.toBe(second.id);
	});

	it("classifies nested and cyclic exceptions without reading or serializing secret fields", () => {
		const cause = {
			status: 504,
			kind: "network",
			cause: {} as unknown,
			message: "dummy-token",
			headers: "dummy-authorization",
		};
		cause.cause = cause;
		expect(safeSyncError({ cause, message: "dummy-email@example.com" })).toEqual({
			errorKind: "network",
			httpStatus: 504,
		});
		expect(
			safeSyncError(
				Object.defineProperty({}, "status", {
					get: () => {
						throw new Error("dummy-secret");
					},
				})
			)
		).toEqual({ errorKind: "unknown" });
	});

	it("persists a failure before rendering its phase-aware error and retains it when reopened", async () => {
		jest.spyOn(api, "fetchNotes").mockRejectedValue(new NetworkError("dummy-secret", 504));
		const modal = createModal();
		await modal.beginReview();
		expect(outcomes()).toHaveLength(1);
		expect(modal.contentEl.textContent).toContain("Download paused");
		expect(modal.contentEl.textContent).toContain("Resume download");
		expect(modal.contentEl.textContent).toContain("HTTP 504");
		expect(modal.contentEl.textContent).toContain(plugin.settings.lastSyncAttempt?.id);
		expect(modal.contentEl.textContent).not.toContain("dummy-secret");
		const reopened = createModal();
		reopened.onOpen();
		await Promise.resolve();
		expect(reopened.contentEl.textContent).toContain("Last attempt");
		expect(reopened.contentEl.textContent).toContain("failed");
	});

	it("abandons a prepared review once without changing the checkpoint", async () => {
		jest.spyOn(api, "fetchNotes").mockResolvedValue({ notes: [] });
		const modal = createModal();
		await modal.beginReview();
		expect(outcomes()).toHaveLength(0);
		modal.onClose();
		// Let the actual serialized persistence pipeline settle.
		for (let index = 0; index < 50; index += 1) await Promise.resolve();
		expect(outcomes()).toHaveLength(1);
		expect(outcomes()[0]).toMatchObject({ outcome: "abandoned", phase: "review" });
		expect(plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	});

	it("ignores an in-flight preparation result after its modal is closed", async () => {
		let resolve!: (result: api.GoogleKeepImportResponse) => void;
		const fetch = jest.spyOn(api, "fetchNotes").mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				})
		);
		const modal = createModal();
		const pending = modal.beginReview();
		for (let index = 0; index < 200 && !fetch.mock.calls.length; index += 1) await Promise.resolve();
		expect(fetch).toHaveBeenCalledTimes(1);
		modal.onClose();
		resolve({ notes: [] });
		await pending;
		expect(outcomes()).toHaveLength(1);
		expect(outcomes()[0].outcome).toBe("abandoned");
		expect(modal.contentEl.textContent).toBe("");
	});
});
