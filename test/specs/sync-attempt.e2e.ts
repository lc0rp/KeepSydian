import { mkdir } from "node:fs/promises";
import { browser, expect } from "@wdio/globals";
import type KeepSidianPlugin from "../../src/app/main";
import type { LastSyncAttempt } from "../../src/types/sync-attempt";

describe("Sync attempt observability in installed Obsidian", function () {
	const checkpoint = "2024-01-01T00:00:00.000Z";
	const button = (label: string) => browser.$(`//button[normalize-space(.)="${label}"]`);

	before(async function () {
		if ((browser.capabilities as { platformName?: string }).platformName?.toLowerCase() === "android") {
			this.skip();
			return;
		}
		await mkdir("test-results", { recursive: true });
		await browser.reloadObsidian({ vault: "./test/vaults/simple" });
		await browser.$(".keepsidian-feedback-modal").waitForExist({ timeout: 20000 });
		await button("Maybe later").click();
	});

	afterEach(async () => {
		await browser.executeObsidian(({ app, obsidian }) => {
			const state = window as Window & { __attemptRestore?: () => void };
			state.__attemptRestore?.();
			delete state.__attemptRestore;
			const plugin = app.plugins.getPlugin("keepsidian") as KeepSidianPlugin;
			plugin.progressModal?.close();
		});
	});

	for (const scenario of ["first-debug-off", "first-debug-on", "later-cursor"] as const) {
		it(`records ${scenario} HTTP 504, opens its log, and retains the download checkpoint`, async () => {
			await browser.executeObsidian(
				async ({ app, obsidian }, testScenario, savedCheckpoint) => {
					const plugin = app.plugins.getPlugin("keepsidian") as KeepSidianPlugin;
					plugin.stopAutoSync();
					plugin.progressModal?.close();
					plugin.progressModal = null;
					Object.assign(plugin.settings, {
						email: "observability@example.invalid",
						token: "observability-secret-token",
						supporterKeyConfigured: false,
						saveLocation: `AttemptE2E/${testScenario}`,
						frontmatterPascalCaseFixApplied: true,
						oauthDebugMode: testScenario === "first-debug-on",
						keepSidianLastSuccessfulSyncDate: savedCheckpoint,
						lastSyncAttempt: undefined,
						lastSyncSummary: null,
					});
					plugin.lastSyncSummary = null;
					const originalRequest = obsidian.requestUrl;
					const originalSubscription = plugin.subscriptionService.isSubscriptionActive;
					plugin.subscriptionService.isSubscriptionActive = async () => false;
					let page = 0;
					// Intercept transport only: real HTTP wrapper, pagination, lifecycle, disk and modal run unchanged.
					Object.defineProperty(obsidian, "requestUrl", {
						configurable: true,
						writable: true,
						value: async () => {
							page += 1;
							const firstPage = testScenario === "later-cursor" && page === 1;
							const json = firstPage
								? {
										notes: [{ title: "private-note-title", text: "private-note-body" }],
										total_notes: 501,
										next_cursor: "private-cursor-value",
									}
								: { error: "observability-secret-token observability@example.invalid private-note-body" };
							return {
								status: firstPage ? 200 : 504,
								json,
								text: JSON.stringify(json),
								headers: {},
								arrayBuffer: new ArrayBuffer(0),
							};
						},
					});
					(window as Window & { __attemptRestore?: () => void }).__attemptRestore = () => {
						Object.defineProperty(obsidian, "requestUrl", {
							configurable: true,
							writable: true,
							value: originalRequest,
						});
						plugin.subscriptionService.isSubscriptionActive = originalSubscription;
					};
					plugin.openSyncCenter({ mode: "import" });
				},
				scenario,
				checkpoint
			);

			await button("Start sync").click();
			const alert = browser.$(".keepsidian-modal-alert");
			await browser.waitUntil(async () => (await alert.getText()).includes("HTTP 504"), { timeout: 20000 });
			expect(await alert.getText()).toContain("Download preparation failed");
			const result = await browser.executeObsidian(async ({ app }) => {
				const plugin = app.plugins.getPlugin("keepsidian") as KeepSidianPlugin;
				const persisted = await plugin.loadData();
				const attempt = persisted.lastSyncAttempt as LastSyncAttempt;
				return {
					attempt,
					text: await app.vault.adapter.read(attempt.logPath!),
					checkpoint: persisted.keepSidianLastSuccessfulSyncDate,
					noteFiles: app.vault
						.getMarkdownFiles()
						.filter(
							(file) => file.path.startsWith(plugin.settings.saveLocation) && !file.path.includes("_KeepSidianLogs")
						).length,
				};
			});
			expect(result.attempt).toMatchObject({
				outcome: "failed",
				phase: "fetch",
				httpStatus: 504,
				logUnavailable: false,
			});
			expect(await alert.getText()).toContain(result.attempt.id);
			expect(result.checkpoint).toBe(checkpoint);
			expect(result.noteFiles).toBe(0);
			expect(result.text).not.toMatch(
				/observability-secret-token|observability@example.invalid|private-note|private-cursor/
			);
			const records = result.text
				.split("\n")
				.filter((line) => line.includes("Sync attempt "))
				.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
			expect(records.filter((record) => record.event === "outcome")).toEqual([
				expect.objectContaining({
					attemptId: result.attempt.id,
					outcome: "failed",
					pageOrdinal: scenario === "later-cursor" ? 2 : 1,
					fetchedCount: scenario === "later-cursor" ? 1 : 0,
				}),
			]);
			await browser.saveScreenshot(`test-results/sync-attempt-${scenario}.png`);
			await button("View log").click();
			await browser.waitUntil(
				async () =>
					(await browser.executeObsidian(({ app }) => app.workspace.getActiveFile()?.path)) === result.attempt.logPath,
				{ timeout: 10000 }
			);
			await browser.executeObsidian(({ app }) => {
				const plugin = app.plugins.getPlugin("keepsidian") as KeepSidianPlugin;
				plugin.progressModal?.close();
				plugin.openSyncCenter({ mode: "import" });
			});
			expect(await browser.$(".keepsidian-modal").getText()).toContain(`Last attempt ${result.attempt.id}: failed`);
			await browser.saveScreenshot(`test-results/sync-attempt-${scenario}-reopened.png`);
		});
	}
});
