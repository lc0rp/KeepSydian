import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { browser, expect } from "@wdio/globals";
import type KeepSidianPlugin from "../../src/app/main";
import type { LastSyncAttempt } from "../../src/types/sync-attempt";

describe("Sync attempt observability in installed Obsidian", function () {
	let server: Server | undefined;
	let activeScenario = "";
	let page = 0;
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
		// A real loopback server exercises Obsidian requestUrl, including non-2xx handling.
		// Only the isolated WDIO vault receives a bundle configured for this server.
		server = createServer((request, response) => {
			if (!request.url?.startsWith("/keep/sync/")) {
				response.writeHead(404).end();
				return;
			}
			page += 1;
			const firstPage = activeScenario === "later-cursor" && page === 1;
			const json = firstPage
				? {
						notes: [{ title: "private-note-title", text: "private-note-body" }],
						total_notes: 501,
						next_cursor: "private-cursor-value",
					}
				: { error: "observability-secret-token observability@example.invalid private-note-body" };
			response.writeHead(firstPage ? 200 : 504, { "Content-Type": "application/json" });
			response.end(JSON.stringify(json));
		});
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No loopback server address");
		const bundle = await build({
			entryPoints: ["src/main.ts"],
			bundle: true,
			write: false,
			platform: "node",
			format: "cjs",
			target: "es2018",
			tsconfig: "tsconfig.json",
			external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
			define: {
				"process.env.KEEPSIDIAN_SERVER_URL": JSON.stringify(`http://127.0.0.1:${address.port}`),
			},
		});
		await browser.executeObsidian(async ({ app }, source) => {
			const plugin = app.plugins.getPlugin("keepsidian") as KeepSidianPlugin;
			const dir = plugin.manifest.dir;
			if (!dir) throw new Error("Isolated plugin directory unavailable");
			await app.plugins.disablePlugin("keepsidian");
			await app.vault.adapter.write(`${dir}/main.js`, source);
			await app.plugins.enablePlugin("keepsidian");
		}, bundle.outputFiles[0].text);
	});

	after(async () => {
		if (server)
			await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
	});

	afterEach(async function () {
		if (this.currentTest?.state === "failed") {
			await browser.saveScreenshot(`test-results/sync-attempt-${activeScenario}-failed.png`);
		}
		await browser.executeObsidian(({ app }) => {
			const state = window as Window & { __attemptRestore?: () => void };
			state.__attemptRestore?.();
			delete state.__attemptRestore;
			const plugin = app.plugins.getPlugin("keepsidian") as KeepSidianPlugin;
			plugin.progressModal?.close();
		});
	});

	for (const scenario of ["first-debug-off", "first-debug-on", "later-cursor"] as const) {
		it(`records ${scenario} HTTP 504, opens its log, and retains the download checkpoint`, async () => {
			activeScenario = scenario;
			page = 0;
			await browser.executeObsidian(
				async ({ app }, testScenario, savedCheckpoint) => {
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
					const originalSubscription = plugin.subscriptionService.isSubscriptionActive;
					plugin.subscriptionService.isSubscriptionActive = async () => false;
					(window as Window & { __attemptRestore?: () => void }).__attemptRestore = () => {
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
