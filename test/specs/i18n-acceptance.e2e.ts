import { browser, expect } from "@wdio/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTranslator } from "../../src/lang/index";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "../../src/test-utils/fixtures/sync-plan";
import { focusVaultWindow, routeAppCommandsToVault } from "../helpers/vault-window";

const mobile = process.env.KEEPSIDIAN_I18N_MOBILE === "1";
let evidenceDir: string;
const title = "Synthetic 中文 Русский عربي é";
const language = '[data-keepsidian-role="language"]';
const drafts = '[data-keepsidian-role="draft-translations"]';

async function settleAnimations() {
	await browser.waitUntil(async () =>
		browser.execute(
			() =>
				document
					.getAnimations()
					.filter(
						(animation) => animation.effect?.getTiming().iterations !== Infinity && animation.playState === "running"
					).length === 0
		)
	);
}

async function audit(selector: string) {
	const controls = [];
	for (const control of await browser.$$(
		selector + " button, " + selector + " input, " + selector + " select, " + selector + " .checkbox-container"
	)) {
		if (!(await control.isDisplayed())) continue;
		controls.push({
			label: await control.getComputedLabel(),
			role: await control.getComputedRole(),
			disabled: !(await control.isEnabled()),
		});
	}
	const layout = await browser.execute((rootSelector) => {
		const root = document.querySelector(rootSelector)!;
		const rect = root.getBoundingClientRect();
		return {
			width: innerWidth,
			height: innerHeight,
			overflow: root.scrollWidth - root.clientWidth,
			left: rect.left,
			right: rect.right,
			lang: root.closest("[lang]")?.getAttribute("lang"),
			focus: document.activeElement?.outerHTML.slice(0, 500),
			mobileClass: document.body.classList.contains("is-mobile"),
			phoneClass: document.body.classList.contains("is-phone"),
			tabletClass: document.body.classList.contains("is-tablet"),
			maxTouchPoints: navigator.maxTouchPoints,
		};
	}, selector);
	return { controls, layout };
}

function assertLayout(result: Awaited<ReturnType<typeof audit>>) {
	expect(result.layout.overflow).toBeLessThanOrEqual(2);
	expect(result.layout.left).toBeGreaterThanOrEqual(-2);
	expect(result.layout.right).toBeLessThanOrEqual(result.layout.width + 2);
	expect(result.layout.mobileClass).toBe(mobile);
}

describe("Multilingual responsive and accessibility acceptance (synthetic services)", () => {
	before(async () => {
		routeAppCommandsToVault();
		await focusVaultWindow();
		await browser.executeObsidian(({ app }) => {
			const p = app.plugins.getPlugin("keepsidian") as any;
			if (!p || p.settings.email || p.settings.token) throw new Error("Expected blank synthetic vault");
			document.querySelectorAll(".modal-close-button").forEach((el: HTMLElement) => el.click());
			p.subscriptionService.isSubscriptionActive = async () => false;
			p.subscriptionService.checkSubscription = async () => null;
			p.settings.autoSyncEnabled = false;
		});
		const width = await browser.execute(() => innerWidth);
		evidenceDir = resolve(`output/i18n-acceptance/${mobile ? "mobile-emulation" : "desktop"}-${width}`);
		mkdirSync(evidenceDir, { recursive: true });
	});

	afterEach(async () => {
		await browser.saveScreenshot(resolve(evidenceDir, "last-state.png"));
	});
	for (const locale of ["en", "zh", "ru", "de"] as const) {
		it(`checks ${locale} settings, review, warnings and keyboard access`, async () => {
			const tr = createTranslator(locale, { includeDrafts: true });
			await browser.executeObsidian(async ({ app }, value) => {
				const p = app.plugins.getPlugin("keepsidian") as any;
				p.settings.language = value;
				p.settings.useDraftTranslations = true;
				await p.saveSettings();
				app.setting.open();
				app.setting.openTabById("keepsidian");
			}, locale);
			await browser.$(language).waitForExist();
			await settleAnimations();
			expect(await browser.$(language).getComputedLabel()).toBe(tr.t("language.name"));
			expect(await browser.$(language).getComputedRole()).toBe("combobox");
			expect(await browser.$(drafts).getComputedLabel()).toBe(tr.t("language.drafts"));
			expect(await browser.$(drafts).getComputedRole()).toBe("switch");
			await browser.execute((selector) => (document.querySelector(selector) as HTMLElement).focus(), language);
			await browser.keys("Tab");
			expect(await browser.$(drafts).isFocused()).toBe(true);
			await browser.keys("Space");
			await browser.waitUntil(async () => (await browser.$(drafts).getAttribute("aria-checked")) === "false");
			expect(await browser.$(drafts).isFocused()).toBe(true);
			expect(await browser.$(language).getComputedLabel()).toBe(createTranslator("en").t("language.name"));
			await browser.keys("Space");
			await browser.waitUntil(async () => (await browser.$(drafts).getAttribute("aria-checked")) === "true");
			expect(await browser.$(drafts).isFocused()).toBe(true);
			await browser.keys(["Shift", "Tab"]);
			expect(await browser.$(language).isFocused()).toBe(true);
			// Emulation reports existing desktop helper imports. Preserve diagnostics, then
			// wait for transient notices to expire so screenshots show the actual settings.
			const notices = await browser.$$(".notice").map((notice) => notice.getText());
			writeFileSync(resolve(evidenceDir, `${locale}-notices.json`), JSON.stringify(notices, null, 2));
			await browser.waitUntil(async () => (await browser.$$(".notice")).length === 0, { timeout: 15000 });
			const settings = await audit(".keepsidian-localized-settings");
			writeFileSync(resolve(evidenceDir, `${locale}-settings.json`), JSON.stringify(settings, null, 2));
			await browser.saveScreenshot(resolve(evidenceDir, `${locale}-settings.png`));
			assertLayout(settings);
			expect(settings.layout.lang).toBe(locale);

			const fixture = createPreparedSyncPlanFixture("import", "import", [
				createSyncPlanEntryFixture("create", "Create", { title }),
				createSyncPlanEntryFixture("delete", "Delete", { title: "Synthetic removal" }),
			]);
			await browser.executeObsidian(({ app }, plan) => {
				app.setting.close();
				const p = app.plugins.getPlugin("keepsidian") as any;
				p.progressModal?.close();
				p.progressModal = null;
				p.settings.lastSyncAttempt = null;
				p.lastSyncSummary = null;
				document.getElementById("i18n-synthetic-opener")?.remove();
				const opener = document.createElement("button");
				opener.id = "i18n-synthetic-opener";
				opener.textContent = "Synthetic sync opener";
				document.body.appendChild(opener);
				opener.focus();
				p.openSyncCenter();
				Object.assign(p.progressModal.options, {
					createSyncAttempt: undefined,
					getLastAttempt: () => null,
					isSupporterActive: async () => true,
					renderImportOptions: async () => undefined,
					buildSyncPlan: async () => plan,
					runSyncPlan: async () => {
						throw new Error("Synthetic network error");
					},
				});
			}, fixture);
			await browser.$(".keepsidian-modal-action--primary").waitForExist();
			await settleAnimations();
			// Real WebDriver click tests the emulated pointer; later actions test the keyboard.
			await browser.$(".keepsidian-modal-action--primary").waitForClickable({ timeout: 10000 });
			await browser.$(".keepsidian-modal-action--primary").click();
			await browser.$(".keepsidian-sync-plan-row").waitForExist();
			const dialog = await browser.$(".keepsidian-modal").parentElement();
			expect(await dialog.getComputedRole()).toBe("dialog");
			expect(await dialog.getComputedLabel()).toBe(tr.t("sync.reviewDownload"));
			expect(await dialog.getAttribute("aria-modal")).toBe("true");
			expect(await browser.$(".keepsidian-modal-status").getAttribute("aria-live")).toBe("polite");
			await expect(browser.$('[data-keepsidian-role="deletion-summary"]')).toHaveText(
				tr.t("deletion.download", { selected: 1 })
			);
			const row = ".keepsidian-sync-plan-row input";
			expect(await browser.$(row).getComputedLabel()).toContain(title);
			await browser.execute((selector) => (document.querySelector(selector) as HTMLElement).focus(), row);
			await browser.keys("Space");
			expect(await browser.$(row).isSelected()).toBe(false);
			expect(await browser.$(row).isFocused()).toBe(true);
			await browser.keys("Space");
			expect(await browser.$(row).isSelected()).toBe(true);
			expect(await browser.$(row).isFocused()).toBe(true);
			for (let i = 0; i < 14; i++) {
				await browser.keys("Tab");
				expect(await browser.execute(() => !!document.activeElement?.closest(".modal"))).toBe(true);
			}
			await browser.keys(["Shift", "Tab"]);
			expect(await browser.execute(() => !!document.activeElement?.closest(".modal"))).toBe(true);
			const review = await audit(".keepsidian-modal");
			assertLayout(review);
			expect(review.controls.every((control) => control.label.trim())).toBe(true);
			await browser.saveScreenshot(resolve(evidenceDir, `${locale}-review.png`));
			await browser.execute(() => (document.querySelector(".keepsidian-modal-action--primary") as HTMLElement).focus());
			await browser.keys("Enter");
			await browser.waitUntil(async () =>
				(await browser.$(".keepsidian-modal-alert").getText()).includes(tr.t("sync.error.connection"))
			);
			expect(await browser.$(".keepsidian-modal-alert").getAttribute("role")).toBe("alert");
			const error = await audit(".keepsidian-modal");
			assertLayout(error);
			await browser.saveScreenshot(resolve(evidenceDir, `${locale}-error.png`));

			const upload = createPreparedSyncPlanFixture("push", "upload", [
				createSyncPlanEntryFixture("conflict-copy", "Conflict copy", {
					stage: "upload",
					mode: "push",
					title,
					meta: { attachmentCount: 2, missingAttachmentCount: 1, uploadDetail: { pendingMerge: true } },
				}),
			]);
			await browser.executeObsidian(async ({ app }, plan) => {
				const modal = (app.plugins.getPlugin("keepsidian") as any).progressModal;
				modal.options.getTwoWayGate = () => ({ allowed: true, reasons: [] });
				modal.options.buildSyncPlan = async () => plan;
				await modal.beginReview("push");
			}, upload);
			await expect(browser.$(".keepsidian-sync-plan-list")).toHaveText(
				expect.stringContaining(tr.t("upload.conflictCopy"))
			);
			await expect(browser.$(".keepsidian-sync-plan-list")).toHaveText(
				expect.stringContaining(tr.t("upload.missingAttachments", { count: 1 }))
			);
			const uploadReview = await audit(".keepsidian-modal");
			assertLayout(uploadReview);
			await browser.saveScreenshot(resolve(evidenceDir, `${locale}-upload.png`));
			await browser.keys("Escape");
			await browser.waitUntil(async () => !(await browser.$(".keepsidian-modal").isExisting()));
			expect(await browser.$("#i18n-synthetic-opener").isFocused()).toBe(true);
			writeFileSync(
				resolve(evidenceDir, `${locale}.json`),
				JSON.stringify({ locale, mobile, settings, review, error, uploadReview }, null, 2)
			);
		});
	}
});
