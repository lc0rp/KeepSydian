import { browser, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createTranslator } from "../../src/lang/index";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "../../src/test-utils/fixtures/sync-plan";
import { focusVaultWindow, routeAppCommandsToVault } from "../helpers/vault-window";

describe("Multilingual UI in an isolated Obsidian vault", () => {
	before(async () => {
		routeAppCommandsToVault();
		await focusVaultWindow();
		await browser.executeObsidian(({ app }) => {
			const plugin = app.plugins.getPlugin("keepsidian") as any;
			if (!plugin || plugin.settings.email || plugin.settings.token) throw new Error("Expected blank synthetic vault");
			document.querySelectorAll(".modal-close-button").forEach((el: HTMLElement) => el.click());
			plugin.subscriptionService.isSubscriptionActive = async () => false;
			plugin.subscriptionService.checkSubscription = async () => null;
			plugin.settings.autoSyncEnabled = false;
			plugin.settings.useDraftTranslations = false;
		});
		mkdirSync(resolve("output/i18n"), { recursive: true });
	});

	it("requires explicit draft opt-in through the settings control", async () => {
		await browser.executeObsidian(({ app }) => {
			app.setting.open();
			app.setting.openTabById("keepsidian");
		});
		await browser.$('[data-keepsidian-role="language"]').waitForExist();
		await browser.$('[data-keepsidian-role="language"]').selectByAttribute("value", "zh");
		await expect(browser.$(".keepsidian-localized-settings")).toHaveText(expect.stringContaining("Interface language"));
		await browser.$(".keepsidian-draft-translations .checkbox-container").click();
		await browser.waitUntil(async () =>
			(await browser.$(".keepsidian-localized-settings").getText()).includes("界面语言")
		);
		await browser.executeObsidian(({ app }) => {
			app.setting.close();
		});
	});

	for (const locale of ["en", "zh", "ru", "de"] as const) {
		it(`renders ${locale} controls, persists preference, reviews synthetic notes without translating them`, async () => {
			const tr = createTranslator(locale, { includeDrafts: true });
			await focusVaultWindow();
			await browser.executeObsidian(({ app }) => {
				app.setting.open();
				app.setting.openTabById("keepsidian");
			});
			await browser.$('[data-keepsidian-role="language"]').waitForExist();
			await browser.$('[data-keepsidian-role="language"]').selectByAttribute("value", locale);
			await browser.waitUntil(async () =>
				(await browser.$(".keepsidian-localized-settings").getText()).includes(tr.t("language.name"))
			);
			await expect(browser.$(".keepsidian-localized-settings")).toHaveText(
				expect.stringContaining(tr.t("language.draftDescription"))
			);
			const saved = await browser.executeObsidian(async ({ app }) => {
				const p = app.plugins.getPlugin("keepsidian") as any;
				return (await p.loadData()).language;
			});
			expect(saved).toBe(locale);
			const commandName = await browser.executeObsidian(
				({ app }) => app.commands.commands["keepsidian:open-sync-center"].name
			);
			expect(commandName).toContain(tr.t("commands.openSyncCenter"));
			await browser.saveScreenshot(resolve(`output/i18n/${locale}-settings.png`));
			const title = '<img src=x onerror="window.noteExecuted=true"> 中文 Русский عربي é';
			const plan = createPreparedSyncPlanFixture("import", "import", [
				createSyncPlanEntryFixture("create", "Create", { title, path: "Synthetic/中文 Русский عربي.md" }),
				createSyncPlanEntryFixture("delete", "Delete", { id: "delete", title: "Synthetic removal" }),
			]);
			await browser.executeObsidian(({ app }, fixture) => {
				(window as any).noteExecuted = false;
				app.setting.close();
				const p = app.plugins.getPlugin("keepsidian") as any;
				p.progressModal?.close();
				p.progressModal = null;
				p.settings.lastSyncAttempt = null;
				p.lastSyncSummary = null;
				p.openSyncCenter();
				Object.assign(p.progressModal.options, {
					createSyncAttempt: undefined,
					getLastAttempt: () => null,
					isSupporterActive: async () => true,
					renderImportOptions: async () => undefined,
					buildSyncPlan: async () => fixture,
					runSyncPlan: async () => {
						throw new Error("Synthetic network error");
					},
				});
			}, plan);
			await browser.$(".keepsidian-modal-action--primary").waitForExist();
			await browser.$(".keepsidian-modal-action--primary").click();
			await browser.$(".keepsidian-sync-plan-row").waitForExist();
			await expect(browser.$(".keepsidian-sync-plan-list")).toHaveText(expect.stringContaining(title));
			await expect(browser.$('[data-keepsidian-role="deletion-summary"]')).toHaveText(
				tr.t("deletion.download", { selected: 1 })
			);
			expect(await browser.execute(() => (window as any).noteExecuted)).toBe(false);
			expect(await browser.$(".keepsidian-sync-plan-list img").isExisting()).toBe(false);
			await browser.executeObsidian(() => {
				const remote = require("electron").remote ?? require("@electron/remote");
				remote.getCurrentWindow().setSize(430, 860);
			});
			await browser.saveScreenshot(resolve(`output/i18n/${locale}-review-narrow.png`));
			const overflow = await browser.execute(() => {
				const el = document.querySelector(".keepsidian-modal")!;
				return el.scrollWidth - el.clientWidth;
			});
			expect(overflow).toBeLessThanOrEqual(2);
			await browser.$(".keepsidian-modal-action--primary").click();
			await browser.waitUntil(async () =>
				(await browser.$(".keepsidian-modal-alert").getText()).includes(tr.t("sync.error.connection"))
			);
			await browser.saveScreenshot(resolve(`output/i18n/${locale}-error.png`));
			if (locale === "ru") {
				await browser.executeObsidian(({ app }) => {
					(app.plugins.getPlugin("keepsidian") as any).settings.useDraftTranslations = false;
				});
				await browser.waitUntil(async () =>
					(await browser.$(".keepsidian-modal-alert").getText()).includes(
						createTranslator("en").t("sync.error.connection")
					)
				);
				await browser.executeObsidian(({ app }) => {
					(app.plugins.getPlugin("keepsidian") as any).settings.useDraftTranslations = true;
				});
				await browser.waitUntil(async () =>
					(await browser.$(".keepsidian-modal-alert").getText()).includes(tr.t("sync.error.connection"))
				);
			}
			const upload = createPreparedSyncPlanFixture("push", "upload", [
				createSyncPlanEntryFixture("conflict-copy", "Conflict copy", {
					stage: "upload",
					mode: "push",
					title,
					path: "Synthetic/中文 Русский عربي.md",
					meta: { attachmentCount: 2, missingAttachmentCount: 1, uploadDetail: { pendingMerge: true } },
				}),
			]);
			await browser.executeObsidian(async ({ app }, fixture) => {
				const modal = (app.plugins.getPlugin("keepsidian") as any).progressModal;
				modal.options.getTwoWayGate = () => ({ allowed: true, reasons: [] });
				modal.options.buildSyncPlan = async () => fixture;
				await modal.beginReview("push");
			}, upload);
			await expect(browser.$(".keepsidian-sync-plan-list")).toHaveText(
				expect.stringContaining(tr.t("upload.conflictCopy"))
			);
			await expect(browser.$(".keepsidian-sync-plan-list")).toHaveText(
				expect.stringContaining(tr.t("upload.missingAttachments", { count: 1 }))
			);
			await expect(browser.$(".keepsidian-sync-plan-list")).toHaveText(expect.stringContaining(title));
			await browser.saveScreenshot(resolve(`output/i18n/${locale}-upload-review.png`));
			await browser.executeObsidian(({ app }) => {
				(app.plugins.getPlugin("keepsidian") as any).progressModal.close();
			});
			await browser.executeObsidian(() => {
				const remote = require("electron").remote ?? require("@electron/remote");
				remote.getCurrentWindow().setSize(1100, 900);
			});
		});
	}

	it("reloads the saved choice and returns to English when drafts are disabled", async () => {
		await browser.executeObsidian(async ({ app }) => {
			await app.plugins.disablePlugin("keepsidian");
			await app.plugins.enablePlugin("keepsidian");
			app.setting.open();
			app.setting.openTabById("keepsidian");
		});
		await browser.$('[data-keepsidian-role="language"]').waitForExist();
		expect(await browser.$('[data-keepsidian-role="language"]').getValue()).toBe("de");
		await browser.$(".keepsidian-draft-translations .checkbox-container").click();
		await browser.waitUntil(async () =>
			(await browser.$(".keepsidian-localized-settings").getText()).includes("Interface language")
		);
		await browser.executeObsidian(({ app }) => {
			app.setting.close();
		});
	});
});
