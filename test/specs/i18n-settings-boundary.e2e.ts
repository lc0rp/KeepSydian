import { browser, expect } from "@wdio/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { focusVaultWindow, routeAppCommandsToVault } from "../helpers/vault-window";

describe("Narrow desktop settings host boundary (synthetic vault)", () => {
	it("compares host settings without the plugin against localized settings", async () => {
		routeAppCommandsToVault();
		await focusVaultWindow();
		const width = await browser.execute(() => innerWidth);
		const evidenceDir = resolve(`output/i18n-settings-boundary/desktop-${width}`);
		mkdirSync(evidenceDir, { recursive: true });
		const measure = async (name: string) => {
			const result = await browser.execute(() => {
				const rect = (element: Element) => {
					const bounds = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					return {
						className: element.className,
						lang: element.getAttribute("lang"),
						width: bounds.width,
						left: bounds.left,
						right: bounds.right,
						clientWidth: element.clientWidth,
						scrollWidth: element.scrollWidth,
						paddingLeft: style.paddingLeft,
						paddingRight: style.paddingRight,
						minWidth: style.minWidth,
						maxWidth: style.maxWidth,
						flex: style.flex,
						boxSizing: style.boxSizing,
						overflowX: style.overflowX,
					};
				};
				const selectors = [
					".modal.mod-settings",
					".vertical-tabs-container",
					".vertical-tab-header",
					".vertical-tab-content-container",
					".vertical-tab-content",
					".keepsidian-localized-settings",
				];
				return {
					innerWidth,
					outerWidth,
					innerHeight,
					outerHeight,
					mobile: document.body.classList.contains("is-mobile"),
					activeTab: document.querySelector(".vertical-tab-nav-item.is-active")?.textContent,
					pluginStylesPresent: Array.from(document.querySelectorAll("style")).some((style) =>
						style.textContent?.includes(".keepsidian-localized-settings")
					),
					elements: Object.fromEntries(
						selectors.map((selector) => [selector, Array.from(document.querySelectorAll(selector)).map(rect)])
					),
					overflowing: Array.from(document.querySelectorAll(".vertical-tab-content *"))
						.filter((element) => {
							const bounds = element.getBoundingClientRect();
							return bounds.width > 0 && bounds.right > innerWidth;
						})
						.slice(0, 20)
						.map((element) => ({ ...rect(element), tag: element.tagName, text: element.textContent?.slice(0, 100) })),
				};
			});
			writeFileSync(resolve(evidenceDir, `${name}.json`), JSON.stringify(result, null, 2));
			await browser.saveScreenshot(resolve(evidenceDir, `${name}.png`));
			return result;
		};
		await browser.executeObsidian(async ({ app }) => {
			const p = app.plugins.getPlugin("keepsidian") as any;
			if (!p || p.settings.email || p.settings.token) throw new Error("Expected blank synthetic vault");
			document.querySelectorAll(".modal-close-button").forEach((el: HTMLElement) => el.click());
			await app.plugins.disablePlugin("keepsidian");
			app.setting.open();
			app.setting.openTabById("general");
		});
		await browser.$(".vertical-tab-content .setting-item").waitForExist();
		await browser.waitUntil(
			async () =>
				await browser.execute(() => document.getAnimations().every((animation) => animation.playState !== "running"))
		);
		expect(await browser.executeObsidian(({ app }) => !!app.plugins.getPlugin("keepsidian"))).toBe(false);
		const general = await measure("host-general-plugin-disabled");
		expect(general.activeTab).toBe("General");
		expect(general.pluginStylesPresent).toBe(false);
		await browser.executeObsidian(({ app }) => {
			app.setting.openTabById("editor");
		});
		await browser.$(".vertical-tab-content .setting-item").waitForExist();
		const editor = await measure("host-editor-plugin-disabled");
		expect(editor.activeTab).toBe("Editor");
		expect(editor.pluginStylesPresent).toBe(false);
		await browser.executeObsidian(async ({ app }) => {
			await app.plugins.enablePlugin("keepsidian");
			const p = app.plugins.getPlugin("keepsidian") as any;
			p.subscriptionService.isSubscriptionActive = async () => false;
			p.subscriptionService.checkSubscription = async () => null;
		});
		const contentBoxWidth = (result: typeof general) => {
			const box = result.elements[".vertical-tab-content"][0];
			return box.clientWidth - Number.parseFloat(box.paddingLeft) - Number.parseFloat(box.paddingRight);
		};
		// Record the host allocation separately from plugin-internal overflow. This
		// comparison never changes the host navigation, content padding or styles.
		expect(contentBoxWidth(editor)).toBeCloseTo(contentBoxWidth(general), 0);
		if (width === 320) {
			expect(contentBoxWidth(general)).toBeLessThan(44); // narrower than the host's own switch
			for (const baseline of [general, editor]) {
				const content = baseline.elements[".vertical-tab-content"][0];
				expect(content.scrollWidth).toBeGreaterThan(content.clientWidth);
			}
		}
		for (const locale of ["en", "zh", "ru", "de"]) {
			await browser.executeObsidian(async ({ app }, value) => {
				const p = app.plugins.getPlugin("keepsidian") as any;
				p.settings.language = value;
				p.settings.useDraftTranslations = true;
				await p.saveSettings();
				app.setting.openTabById("keepsidian");
			}, locale);
			await browser.$(".keepsidian-localized-settings").waitForExist();
			await browser.waitUntil(
				async () =>
					await browser.execute(() => document.querySelectorAll(".keepsidian-localized-settings > hr").length === 4)
			);
			const plugin = await measure(`plugin-${locale}-host-layout`);
			expect(plugin.pluginStylesPresent).toBe(true);
			expect(contentBoxWidth(plugin)).toBeCloseTo(contentBoxWidth(general), 0);
			expect(plugin.elements[".vertical-tab-header"][0].width).toBeCloseTo(
				general.elements[".vertical-tab-header"][0].width,
				0
			);
			const root = plugin.elements[".keepsidian-localized-settings"][0];
			expect(root.lang).toBe(locale);
			expect(await browser.$('[data-keepsidian-role="language"]').getValue()).toBe(locale);
			expect(root.width).toBeCloseTo(contentBoxWidth(general), 0);
			if (width === 320) expect(root.scrollWidth - root.clientWidth).toBeGreaterThan(2);

			// Diagnostic intervention only: allocate this same plugin subtree 280px,
			// bypassing its host allocation without changing its contents or stylesheet.
			// A pass here is component reflow evidence, not a fix of the host settings UI.
			await browser.execute(() => {
				const root = document.querySelector<HTMLElement>(".keepsidian-localized-settings")!;
				Object.assign(root.style, {
					position: "fixed",
					left: "20px",
					top: "80px",
					width: "280px",
					height: "740px",
					overflow: "auto",
					backgroundColor: "var(--background-primary)",
					zIndex: "1",
				});
			});
			const allotted = await measure(`plugin-${locale}-controlled-280px-allocation`);
			const allottedRoot = allotted.elements[".keepsidian-localized-settings"][0];
			expect(allottedRoot.width).toBe(280);
			expect(allottedRoot.scrollWidth - allottedRoot.clientWidth).toBeLessThanOrEqual(2);
			await browser.execute(() => document.querySelector(".keepsidian-localized-settings")!.removeAttribute("style"));
		}
		expect(await browser.execute(() => document.body.classList.contains("is-mobile"))).toBe(false);
	});
});
