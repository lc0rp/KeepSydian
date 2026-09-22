import { browser, expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "../../src/test-utils/fixtures/sync-plan";
import type { SyncMode } from "../../src/types";
import { focusVaultWindow, routeAppCommandsToVault } from "../helpers/vault-window";

describe("KeepSidian", function () {
	const buttonByText = (label: string): string =>
		`//*[self::button or @role="button"][contains(normalize-space(.),"${label}")]`;
	const exactButtonByText = (label: string): string =>
		`//*[self::button or @role="button"][normalize-space(.)="${label}"]`;

	const triggerSyncCenterBackdropClick = async (): Promise<void> => {
		await browser.executeObsidian(({ app }) => {
			const plugin = app.plugins.getPlugin("keepsidian") as
				| {
						progressModal?: {
							containerEl?: HTMLElement;
						};
				  }
				| undefined;
			const containerEl = plugin?.progressModal?.containerEl;
			if (!containerEl) {
				throw new Error("Sync center container is not available");
			}
			containerEl.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					cancelable: true,
				})
			);
		});
	};

	const openKeepSidianSettingsTab = async (): Promise<void> => {
		await focusVaultWindow();
		await completeMobileOnboardingIfNeeded();
		const feedbackModal = browser.$(".keepsidian-feedback-modal");
		if (await feedbackModal.isExisting()) {
			await feedbackModal.$(exactButtonByText("Maybe later")).click();
			await feedbackModal.waitForExist({ reverse: true, timeout: 20000 });
		}

		const settingsCommandId = await browser.execute(() => {
			type ObsidianWindow = Window & {
				app?: {
					commands?: {
						listCommands?: () => Array<{ id: string; name: string }>;
					};
				};
			};

			const commands = (window as ObsidianWindow).app?.commands?.listCommands?.() ?? [];
			const lower = (value: string) => value.toLowerCase();
			const match =
				commands.find((command) => command.id === "app:open-settings") ??
				commands.find((command) => lower(command.id).includes("open-settings")) ??
				commands.find((command) => lower(command.name).includes("settings"));
			return match?.id ?? null;
		});

		if (!settingsCommandId) {
			throw new Error("Could not find an Obsidian command to open settings");
		}

		await browser.executeObsidianCommand(settingsCommandId);
		await browser.executeObsidian(({ app }) => {
			const settingManager = app?.setting;
			settingManager?.open?.();
			if (settingManager?.openTabById) {
				settingManager.openTabById("keepsidian");
			} else if (settingManager?.openSettingTab) {
				settingManager.openSettingTab("keepsidian");
			}
		});
		await browser.waitUntil(
			async () => {
				const handles = await browser.getWindowHandles();
				if (handles.length === 1) {
					return true;
				}
				for (const handle of handles) {
					await browser.switchToWindow(handle);
					if ((await browser.getTitle()).toLowerCase().includes("settings")) {
						return true;
					}
				}
				return false;
			},
			{ timeout: 20000, interval: 250, timeoutMsg: "Could not find the Obsidian settings window" }
		);

		const emailSetting = browser.$('//*[contains(@class,"setting-item-name") and normalize-space(.)="Email"]');
		await emailSetting.waitForExist({ timeout: 20000 });
	};

	const stubTokenExchange = async (keepToken: string): Promise<void> => {
		await browser.executeObsidian((_, token) => {
			(
				window as Window & {
					__keepsidianTestExchange?: (payload: { email?: string; oauth_token: string }) => {
						keep_token: string;
					};
				}
			).__keepsidianTestExchange = () => ({ keep_token: token });
		}, keepToken);
	};

	const restoreTokenExchange = async (): Promise<void> => {
		await browser.executeObsidian(() => {
			delete (window as Window & { __keepsidianTestExchange?: unknown }).__keepsidianTestExchange;
		});
	};

	const isAndroid = (): boolean => {
		const platform = (browser.capabilities as { platformName?: string }).platformName;
		return typeof platform === "string" && platform.toLowerCase() === "android";
	};

	const completeMobileOnboardingIfNeeded = async (): Promise<void> => {
		if (!isAndroid()) {
			return;
		}

		const clickIfPresent = async (label: string): Promise<boolean> => {
			const candidate = await browser.$(buttonByText(label));
			if (await candidate.isExisting()) {
				await candidate.click();
				return true;
			}
			return false;
		};

		await browser.waitUntil(
			async () => {
				const clickedExistingVault = await clickIfPresent("Use my existing vault");
				if (clickedExistingVault) {
					return false;
				}

				const clickedSkipSync = await clickIfPresent("Continue without sync");
				if (clickedSkipSync) {
					return false;
				}

				return true;
			},
			{ timeout: 30000, interval: 500 }
		);
	};

	const openSeededSyncCenter = async (
		plansByMode: Partial<Record<SyncMode, ReturnType<typeof createPreparedSyncPlanFixture>>>,
		options?: {
			runDelayMs?: number;
			initialMode?: SyncMode;
			gateAllowed?: boolean;
			supportCancel?: boolean;
			attachmentWarnings?: number;
		}
	): Promise<void> => {
		const runDelayMs = options?.runDelayMs ?? 500;
		const initialMode = options?.initialMode ?? "import";
		const gateAllowed = options?.gateAllowed ?? false;
		const supportCancel = options?.supportCancel ?? false;
		const attachmentWarnings = options?.attachmentWarnings ?? 0;
		await browser.executeObsidian(
			({ app }, preparedPlans, delayMs, requestedMode, allowGate, allowCancel, warningCount) => {
				type KeepSidianPluginWindow = Window & {
					app?: {
						plugins?: {
							getPlugin?: (id: string) => {
								openSyncCenter?: (options?: { mode?: SyncMode }) => void;
								lastSyncSummary?: {
									timestamp: number;
									processedNotes: number;
									totalNotes?: number | null;
									success: boolean;
									status?: "success" | "warning" | "failed" | "canceled";
									attachmentWarnings?: number;
									mode: SyncMode;
								} | null;
								settings?: {
									lastSyncSummary?: {
										timestamp: number;
										processedNotes: number;
										totalNotes?: number | null;
										success: boolean;
										status?: "success" | "warning" | "failed" | "canceled";
										attachmentWarnings?: number;
										mode: SyncMode;
									} | null;
								};
								progressModal?: {
									close?: () => void;
									setComplete?: (
										status: "success" | "warning" | "failed" | "canceled",
										processed: number,
										attachmentWarnings?: number
									) => void;
									setIdleSummary?: (summary: unknown) => void;
									options?: {
										buildSyncPlan?: (mode: SyncMode) => Promise<unknown>;
										runSyncPlan?: (
											plan: unknown,
											callbacks?: {
												onEntrySettled?: (entryId: string, success: boolean) => void;
											}
										) => Promise<unknown>;
									};
								};
							} | null;
						};
					};
				};

				const plugin = (window as KeepSidianPluginWindow).app?.plugins?.getPlugin?.("keepsidian");
				if (!plugin?.openSyncCenter) {
					throw new Error("KeepSidian plugin or sync center hook not available");
				}

				plugin.lastSyncSummary = null;
				if (plugin.settings) {
					plugin.settings.lastSyncSummary = null;
				}
				plugin.progressModal?.close?.();
				plugin.progressModal = null;
				plugin.openSyncCenter({ mode: requestedMode });
				const modal = plugin.progressModal;
				if (!modal?.options) {
					throw new Error("KeepSidian sync modal was not created");
				}

				modal.options.getTwoWayGate = () => ({
					allowed: allowGate,
					reasons: allowGate ? [] : ["Confirm backups"],
				});
				// These fixtures exercise presentation. The dedicated attempt spec uses the real lifecycle.
				Object.assign(modal.options, { createSyncAttempt: undefined, getLastAttempt: () => undefined });
				Object.assign(modal.options, {
					isSupporterActive: async () => true,
					renderImportOptions: async () => undefined,
				});
				let cancelRequested = false;
				const setCanceledSummary = (processedNotes: number, totalNotes: number, mode: SyncMode) => {
					const summary = {
						timestamp: Date.now(),
						processedNotes,
						totalNotes,
						success: false,
						status: "canceled" as const,
						mode,
					};
					plugin.lastSyncSummary = summary;
					if (plugin.settings) {
						plugin.settings.lastSyncSummary = summary;
					}
					modal.setComplete?.("canceled", processedNotes);
					modal.setIdleSummary?.(summary);
				};
				modal.options.requestCancelSync = () => {
					if (!allowCancel || cancelRequested) {
						return false;
					}
					cancelRequested = true;
					return true;
				};
				modal.options.buildSyncPlan = async (mode) => {
					const selectedPlan = preparedPlans[mode];
					if (!selectedPlan) {
						throw new Error(`No seeded plan for mode: ${String(mode)}`);
					}
					return selectedPlan;
				};
				modal.options.runSyncPlan = async (_currentPlan, callbacks) => {
					const activePlan = _currentPlan as ReturnType<typeof createPreparedSyncPlanFixture>;
					const selectableEntries = activePlan.plan.entries.filter((entry) => entry.selectable && entry.selected);
					const totalNotes = selectableEntries.length;
					const startedAt = Date.now();
					while (Date.now() - startedAt < delayMs) {
						if (allowCancel && cancelRequested) {
							setCanceledSummary(0, totalNotes, activePlan.mode);
							return { canceled: true };
						}
						await new Promise((resolve) => {
							window.setTimeout(resolve, 50);
						});
					}
					if (allowCancel && cancelRequested) {
						setCanceledSummary(0, totalNotes, activePlan.mode);
						return { canceled: true };
					}
					for (const entry of selectableEntries) {
						callbacks?.onEntrySettled?.(entry.id, true);
					}
					if (warningCount > 0) {
						const summary = {
							timestamp: Date.now(),
							processedNotes: totalNotes,
							totalNotes,
							success: true,
							status: "warning" as const,
							attachmentWarnings: warningCount,
							mode: activePlan.mode,
						};
						plugin.lastSyncSummary = summary;
						if (plugin.settings) {
							plugin.settings.lastSyncSummary = summary;
						}
						modal.setComplete?.("warning", totalNotes, warningCount);
						modal.setIdleSummary?.(summary);
					}
					return {};
				};
			},
			plansByMode,
			runDelayMs,
			initialMode,
			gateAllowed,
			supportCancel,
			attachmentWarnings
		);
	};

	before(async function () {
		// You can create test vaults and open them with reloadObsidian
		// Alternatively if all your tests use the same vault, you can
		// set the default vault in the wdio.conf.mts.
		await browser.reloadObsidian({ vault: "./test/vaults/simple" });
		routeAppCommandsToVault();
	});

	beforeEach(async () => {
		await focusVaultWindow();
		await browser.executeObsidian(({ app }) => app.setting.close());
	});

	it("loads the plugin", async () => {
		const pluginLoaded = await browser.execute(() => {
			type ObsidianWindow = Window & {
				app?: {
					plugins?: { getPlugin?: (id: string) => unknown };
				};
			};

			const app = (window as ObsidianWindow).app;
			return Boolean(app?.plugins?.getPlugin?.("keepsidian"));
		});

		expect(pluginLoaded).toBe(true);
	});

	it("shows the versioned feedback invitation without opening the survey", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const modal = browser.$(".keepsidian-feedback-modal");
		await modal.waitForExist({ timeout: 20000 });
		const pluginVersion = await browser.execute(() => {
			type ObsidianWindow = Window & {
				app?: {
					plugins?: {
						getPlugin?: (id: string) => { manifest?: { version?: string } } | undefined;
					};
				};
			};

			return (window as ObsidianWindow).app?.plugins?.getPlugin?.("keepsidian")?.manifest?.version;
		});
		expect(pluginVersion).toBeTruthy();
		expect(await modal.getText()).toContain(`KeepSydian ${pluginVersion}`);
		expect(await modal.getText()).toContain("What's new");
		expect(await modal.getText()).toContain("Help shape what we build next");
		expect(await modal.$$("li")).toBeElementsArrayOfSize(2);
		expect(await modal.$$("iframe, script[src], img[src], link[href]")).toBeElementsArrayOfSize(0);

		const feedbackLink = modal.$('a[data-keepsidian-link="feedback-survey"]');
		expect(await feedbackLink.getAttribute("href")).toBe("https://forms.gle/pVs8GtohFWmqs5F4A");
		expect(await feedbackLink.getAttribute("target")).toBe("_blank");

		await browser.saveScreenshot("/tmp/keepsidian-feedback-survey.png");
		await modal.$(exactButtonByText("Maybe later")).click();
		await modal.waitForExist({ reverse: true, timeout: 20000 });

		await browser.executeObsidian(async ({ app }) => {
			const plugin = app.plugins.getPlugin("keepsidian") as
				| {
						feedbackPromptLastShownVersion?: string;
						maybeShowFeedbackSurvey?: () => Promise<void>;
				  }
				| undefined;
			await plugin?.maybeShowFeedbackSurvey?.();
		});
		expect(await modal.isExisting()).toBe(false);

		await browser.executeObsidian(async ({ app }) => {
			const plugin = app.plugins.getPlugin("keepsidian") as
				| {
						feedbackPromptLastShownVersion?: string;
						maybeShowFeedbackSurvey?: () => Promise<void>;
				  }
				| undefined;
			if (!plugin?.maybeShowFeedbackSurvey) {
				throw new Error("Feedback prompt integration is not available");
			}
			plugin.feedbackPromptLastShownVersion = "previous-version";
			await plugin.maybeShowFeedbackSurvey();
		});
		await modal.waitForExist({ timeout: 20000 });
		await modal.$(exactButtonByText("Maybe later")).click();
		await modal.waitForExist({ reverse: true, timeout: 20000 });
	});

	it("registers expected commands", async () => {
		const commandIds = await browser.execute(() => {
			type ObsidianWindow = Window & {
				app?: {
					commands?: {
						listCommands?: () => Array<{ id: string }>;
					};
				};
			};

			const app = (window as ObsidianWindow).app;
			const commands = app?.commands?.listCommands?.() ?? [];
			return commands.map((command) => command.id);
		});

		expect(commandIds).toContain("keepsidian:two-way-sync-google-keep");
		expect(commandIds).toContain("keepsidian:import-google-keep-notes");
		expect(commandIds).toContain("keepsidian:push-google-keep-notes");
		expect(commandIds).toContain("keepsidian:open-sync-log-file");
	});

	it("opens a vault note and the KeepSidian settings tab", async function () {
		await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getAbstractFileByPath("Inbox.md");
			if (!file) {
				throw new Error("Expected Inbox.md to exist in the test vault");
			}
			await app.workspace.getLeaf(false).openFile(file);
		});

		const editorView = browser.$(".markdown-source-view, .markdown-preview-view");
		await editorView.waitForExist({ timeout: 20000 });
		await openKeepSidianSettingsTab();
	});

	it("shows token helper wizard controls on desktop", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		await openKeepSidianSettingsTab();

		const emailInput = browser.$(
			'//*[contains(@class,"setting-item-name") and normalize-space(.)="Email"]/ancestor::*[contains(@class,"setting-item")]//input'
		);
		await emailInput.waitForExist({ timeout: 20000 });
		await emailInput.setValue("test@example.com");

		const helperButton = browser.$('//button[normalize-space(.)="Launch wizard"]');
		await helperButton.waitForExist({ timeout: 20000 });
		const helperAvailability = browser.$(".keepsidian-token-helper-availability");
		await helperAvailability.waitForExist({ timeout: 20000 });
	});

	it("exchanges oauth2_4 token on change (desktop)", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		await openKeepSidianSettingsTab();
		await stubTokenExchange("e2e-keep-token");

		const tokenInput = browser.$('//input[@placeholder="Google Keep sync token."]');
		await tokenInput.waitForExist({ timeout: 20000 });
		await tokenInput.setValue("oauth2_4/e2e-token");

		await browser.waitUntil(
			async () => {
				const token = await browser.executeObsidian(({ app }) => {
					const plugin = app.plugins.getPlugin("keepsidian") as { settings?: { token?: string } } | undefined;
					return plugin?.settings?.token ?? "";
				});
				return token === "e2e-keep-token";
			},
			{ timeout: 20000, interval: 200 }
		);

		await restoreTokenExchange();
	});

	it("hides retrieval wizard on mobile", async function () {
		if (!isAndroid()) {
			this.skip();
			return;
		}

		await openKeepSidianSettingsTab();

		const helperButton = browser.$('//button[normalize-space(.)="Launch wizard"]');
		expect(await helperButton.isExisting()).toBe(false);

		const mobileDescription = browser.$(
			'//*[contains(@class,"setting-item-name") and normalize-space(.)="Token retrieval instructions"]/ancestor::*[contains(@class,"setting-item")]//*[contains(@class,"setting-item-description")]'
		);
		await mobileDescription.waitForExist({ timeout: 20000 });
		expect(await mobileDescription.getText()).toContain("Mobile:");
	});

	it("exchanges oauth2_4 token on change (mobile)", async function () {
		if (!isAndroid()) {
			this.skip();
			return;
		}

		await openKeepSidianSettingsTab();
		await stubTokenExchange("e2e-keep-token-mobile");

		const tokenInput = browser.$('//input[@placeholder="Google Keep sync token."]');
		await tokenInput.waitForExist({ timeout: 20000 });
		await tokenInput.setValue("oauth2_4/e2e-token-mobile");

		await browser.waitUntil(
			async () => {
				const token = await browser.executeObsidian(({ app }) => {
					const plugin = app.plugins.getPlugin("keepsidian") as { settings?: { token?: string } } | undefined;
					return plugin?.settings?.token ?? "";
				});
				return token === "e2e-keep-token-mobile";
			},
			{ timeout: 20000, interval: 200 }
		);

		await restoreTokenExchange();
	});

	it("walks setup to review to run to done with a seeded sync plan (desktop)", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const seededPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-1",
				title: "E2E create note",
				path: "Keep/E2E create note.md",
			}),
			createSyncPlanEntryFixture("merge", "Merge", {
				id: "merge-1",
				title: "E2E merge note",
				path: "Keep/E2E merge note.md",
			}),
			createSyncPlanEntryFixture("skipped-identical", "Skipped: identical", {
				id: "skip-1",
				title: "E2E skipped note",
				path: "Keep/E2E skipped note.md",
				selectable: false,
				selected: false,
			}),
		]);

		await openSeededSyncCenter({ import: seededPlan }, { runDelayMs: 700, initialMode: "import" });

		const customizeSyncButton = browser.$(buttonByText("Customize sync"));
		await customizeSyncButton.waitForExist({ timeout: 20000 });
		await customizeSyncButton.click();

		const downloadScopeHeading = browser.$('//*[normalize-space(.)="Start & end date"]');
		await downloadScopeHeading.waitForExist({ timeout: 20000 });
		expect(await browser.$(buttonByText("Last sync → Now")).isExisting()).toBe(true);
		expect(await browser.$(buttonByText("All dates")).isExisting()).toBe(true);
		expect(await browser.$(exactButtonByText("Custom")).isExisting()).toBe(true);

		await browser.$(exactButtonByText("Custom")).click();
		const customSinceInput = browser.$('//input[@data-keepsidian-role="custom-since-input"]');
		await customSinceInput.waitForExist({ timeout: 20000 });
		await customSinceInput.setValue("2025-04-12 09:17");
		expect(await customSinceInput.getValue()).toBe("2025-04-12 09:17");
		const customUntilInput = browser.$('//input[@data-keepsidian-role="custom-until-input"]');
		await customUntilInput.waitForDisplayed({ timeout: 20000 });
		expect(await customUntilInput.getValue()).toBe("");
		expect(await customUntilInput.getAttribute("placeholder")).toBe("Now (at sync start)");
		await customUntilInput.click();
		expect(await browser.execute(() => document.activeElement?.getAttribute("data-keepsidian-role"))).toBe(
			"custom-until-input"
		);
		await customUntilInput.setValue("2025-04-13 10:30");
		expect(await customUntilInput.getValue()).toBe("2025-04-13 10:30");
		expect(await customUntilInput.getAttribute("aria-invalid")).toBe("false");
		mkdirSync(resolve("screenshots/sync-end-date-20260922"), { recursive: true });
		await browser.saveScreenshot("screenshots/sync-end-date-20260922/custom-range.png");
		await browser.$(exactButtonByText("All dates")).click();

		const startSyncButton = browser.$(buttonByText("Start sync"));
		await startSyncButton.waitForExist({ timeout: 20000 });
		await startSyncButton.click();

		const reviewTitle = browser.$('//*[normalize-space(.)="Review download plan"]');
		await reviewTitle.waitForExist({ timeout: 20000 });
		expect(await browser.$(buttonByText("Back")).isExisting()).toBe(true);
		expect(await browser.$(buttonByText("Refresh")).isExisting()).toBe(true);
		expect(await browser.$(buttonByText("Execute")).isExisting()).toBe(true);
		expect(await browser.$('//*[contains(normalize-space(.),"Create 1")]').isExisting()).toBe(true);

		await browser.$(buttonByText("Execute")).click();

		const runningTitle = browser.$('//*[normalize-space(.)="Running download plan"]');
		await runningTitle.waitForExist({ timeout: 20000 });
		expect(await browser.$('//*[contains(normalize-space(.),"Created 0/1")]').isExisting()).toBe(true);

		const completeTitle = browser.$('//*[normalize-space(.)="Download complete"]');
		await completeTitle.waitForExist({ timeout: 20000 });
		expect(await browser.$('//*[contains(normalize-space(.),"Created 1/1")]').isExisting()).toBe(true);
		expect(await browser.$(buttonByText("Open sync log")).isExisting()).toBe(true);
		expect(await browser.$(buttonByText("Close sync center")).isExisting()).toBe(true);
	});

	it("aligns expanded Sync Center footer actions and preserves narrow-layout usability", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const seededPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "footer-layout-1",
				title: "Footer layout note",
				path: "Keep/Footer layout note.md",
			}),
		]);

		await openSeededSyncCenter({ import: seededPlan }, { runDelayMs: 700, initialMode: "import" });
		let customizeSyncButton = browser.$(buttonByText("Customize sync"));
		await customizeSyncButton.waitForExist({ timeout: 20000 });
		expect((await browser.$$(exactButtonByText("Start sync"))).length).toBe(1);
		await customizeSyncButton.click();
		await browser.$(exactButtonByText("Custom")).click();
		await browser.$('input[data-keepsidian-role="custom-since-input"]').setValue("2025-04-12 09:17");
		await browser.$('input[data-keepsidian-role="custom-until-input"]').setValue("2025-04-13 10:30");

		const footer = browser.$(".keepsidian-sync-center-footer");
		await footer.waitForExist({ timeout: 20000 });
		const footerStart = footer.$(".keepsidian-modal-action--sync-footer-primary");
		const footerClose = footer.$(".keepsidian-modal-close");
		await footerStart.waitForDisplayed({ timeout: 20000 });
		await footerClose.waitForDisplayed({ timeout: 20000 });
		expect((await browser.$$(exactButtonByText("Start sync"))).length).toBe(2);

		const readFooterLayout = async () =>
			await browser.execute(() => {
				const footerEl = document.querySelector<HTMLElement>(".keepsidian-sync-center-footer");
				const startEl = footerEl?.querySelector<HTMLElement>(".keepsidian-modal-action--sync-footer-primary");
				const closeEl = footerEl?.querySelector<HTMLElement>(".keepsidian-modal-close");
				const modalEl = document.querySelector<HTMLElement>(".keepsidian-modal");
				if (!footerEl || !startEl || !closeEl || !modalEl) {
					return null;
				}
				const startRect = startEl.getBoundingClientRect();
				const closeRect = closeEl.getBoundingClientRect();
				const footerRect = footerEl.getBoundingClientRect();
				const modalRect = modalEl.getBoundingClientRect();
				const footerStyle = getComputedStyle(footerEl);
				const buttons = Array.from(footerEl.querySelectorAll<HTMLElement>("button"));
				const dateRows = Array.from(modalEl.querySelectorAll<HTMLElement>(".keepsidian-sync-center-scope-input-wrap"));
				const datesFit = dateRows.length === 2 && dateRows.every((row) => {
					const label = row.querySelector("span")?.getBoundingClientRect();
					const input = row.querySelector("input")?.getBoundingClientRect();
					const bounds = row.getBoundingClientRect();
					return Boolean(label && input && input.width > 0 && input.left >= label.right &&
						input.right <= bounds.right + 1 && Math.abs((label.top + label.bottom) - (input.top + input.bottom)) <= 2);
				});
				return {
					datesFit,
					viewportWidth: window.innerWidth,
					footerWidth: footerRect.width,
					modalWidth: modalRect.width,
					footerMarginTop: footerStyle.marginTop,
					startMarginTop: getComputedStyle(startEl).marginTop,
					closeMarginTop: getComputedStyle(closeEl).marginTop,
					startHeight: startRect.height,
					closeHeight: closeRect.height,
					topDifference: Math.abs(startRect.top - closeRect.top),
					heightDifference: Math.abs(startRect.height - closeRect.height),
					footerOverflow: footerEl.scrollWidth > footerEl.clientWidth + 1,
					modalOverflow: modalEl.scrollWidth > modalEl.clientWidth + 1,
					buttonOverflow: buttons.some((button) => {
						const rect = button.getBoundingClientRect();
						return rect.left < modalRect.left - 1 || rect.right > modalRect.right + 1;
					}),
				};
			});

		await browser.waitUntil(
			async () => {
				const currentLayout = await readFooterLayout();
				return Boolean(
					currentLayout &&
					currentLayout.footerWidth > 0 &&
					currentLayout.startHeight > 0 &&
					currentLayout.closeHeight > 0
				);
			},
			{ timeout: 20000, interval: 250, timeoutMsg: "Expanded Sync Center footer did not settle" }
		);
		const layout = await readFooterLayout();
		expect(layout).not.toBeNull();
		console.info("Sync Center expanded footer geometry", layout);
		expect(layout?.datesFit).toBe(true);
		expect(layout?.footerMarginTop).toBe("12px");
		expect(layout?.startMarginTop).toBe("0px");
		expect(layout?.closeMarginTop).toBe("0px");
		expect(layout?.topDifference).toBeLessThanOrEqual(1);
		expect(layout?.heightDifference).toBeLessThanOrEqual(1);
		const primaryState = await browser.execute(() => {
			const topEl = document.querySelector<HTMLElement>(".keepsidian-modal-actions .keepsidian-modal-action--primary");
			const footerEl = document.querySelector<HTMLElement>(
				".keepsidian-sync-center-footer .keepsidian-modal-action--sync-footer-primary"
			);
			return {
				topCta: topEl?.classList.contains("mod-cta") ?? false,
				topPrimary: topEl?.classList.contains("keepsidian-modal-action--primary") ?? false,
				footerCta: footerEl?.classList.contains("mod-cta") ?? false,
				footerPrimary: footerEl?.classList.contains("keepsidian-modal-action--primary") ?? false,
			};
		});
		expect(primaryState).toEqual({ topCta: true, topPrimary: true, footerCta: true, footerPrimary: true });
		mkdirSync(resolve("test-results"), { recursive: true });
		mkdirSync(resolve("screenshots/sync-end-date-20260922"), { recursive: true });
		await browser.saveScreenshot("screenshots/sync-end-date-20260922/expanded.png");

		customizeSyncButton = browser.$(buttonByText("Customize sync"));
		await customizeSyncButton.click();
		await footerStart.waitForExist({ reverse: true, timeout: 20000 });
		expect((await browser.$$(exactButtonByText("Start sync"))).length).toBe(1);
		await browser.saveScreenshot("test-results/sync-center-footer-collapsed.png");

		customizeSyncButton = browser.$(buttonByText("Customize sync"));
		await customizeSyncButton.click();
		await footerStart.waitForDisplayed({ timeout: 20000 });
		await footerClose.waitForDisplayed({ timeout: 20000 });

		const readWindowSize = async () =>
			await browser.execute(() => {
				const currentWindow = (
					window as typeof window & {
						electron?: {
							remote?: {
								getCurrentWindow?: () => { getSize: () => [number, number] };
							};
						};
					}
				).electron?.remote?.getCurrentWindow?.();
				if (!currentWindow) {
					throw new Error("Electron window API is unavailable");
				}
				const [width, height] = currentWindow.getSize();
				return { width, height };
			});
		const resizeWindow = async (width: number, height: number) =>
			await browser.execute(
				(nextWidth, nextHeight) => {
					const currentWindow = (
						window as typeof window & {
							electron?: {
								remote?: {
									getCurrentWindow?: () => { setSize: (width: number, height: number) => void };
								};
							};
						}
					).electron?.remote?.getCurrentWindow?.();
					if (!currentWindow) {
						throw new Error("Electron window API is unavailable");
					}
					currentWindow.setSize(nextWidth, nextHeight);
				},
				width,
				height
			);
		const originalWindowSize = await readWindowSize();
		try {
			const narrowWidth = Math.max(320, Math.min(500, originalWindowSize.width - 160));
			if (narrowWidth >= originalWindowSize.width) {
				throw new Error(`Cannot establish a narrower viewport from ${originalWindowSize.width}px`);
			}
			await resizeWindow(narrowWidth, originalWindowSize.height);
			await browser.waitUntil(
				async () => {
					const currentLayout = await readFooterLayout();
					return Boolean(currentLayout && layout && currentLayout.footerWidth < layout.footerWidth);
				},
				{ timeout: 20000, interval: 250, timeoutMsg: "Footer did not narrow with the viewport" }
			);
			const narrowLayout = await readFooterLayout();
			expect(narrowLayout).not.toBeNull();
			console.info("Sync Center narrow footer geometry", narrowLayout);
			expect(narrowLayout?.datesFit).toBe(true);
			expect(narrowLayout?.viewportWidth).toBeLessThan(layout?.viewportWidth ?? Number.POSITIVE_INFINITY);
			expect(narrowLayout?.footerWidth).toBeLessThan(layout?.footerWidth ?? Number.POSITIVE_INFINITY);
			expect(narrowLayout?.footerOverflow).toBe(false);
			expect(narrowLayout?.modalOverflow).toBe(false);
			expect(narrowLayout?.buttonOverflow).toBe(false);
			await browser.saveScreenshot("screenshots/sync-end-date-20260922/narrow.png");
		} finally {
			await resizeWindow(originalWindowSize.width, originalWindowSize.height);
		}

		await browser.$(".keepsidian-sync-center-footer .keepsidian-modal-action--sync-footer-primary").click();
		await browser.$('//*[normalize-space(.)="Review download plan"]').waitForExist({ timeout: 20000 });
		expect(
			await browser.$(".keepsidian-sync-center-footer .keepsidian-modal-action--sync-footer-primary").isExisting()
		).toBe(false);
	});

	it("shows a completed download with attachment warnings in the live Sync Center", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const seededPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "warning-1",
				title: "E2E attachment warning note",
				path: "Keep/E2E attachment warning note.md",
			}),
		]);

		await openSeededSyncCenter(
			{ import: seededPlan },
			{ runDelayMs: 200, initialMode: "import", attachmentWarnings: 2 }
		);
		const startSyncButton = browser.$(buttonByText("Start sync"));
		await startSyncButton.waitForExist({ timeout: 20000 });
		await startSyncButton.click();
		const executeButton = browser.$(buttonByText("Execute"));
		await executeButton.waitForExist({ timeout: 20000 });
		await executeButton.click();

		const warningTitle = browser.$('//*[normalize-space(.)="Download complete with warnings"]');
		await warningTitle.waitForExist({ timeout: 20000 });
		expect(await browser.$('//*[contains(normalize-space(.),"2 attachment warnings")]').isExisting()).toBe(true);
		await browser.saveScreenshot("/tmp/keepsidian-attachment-warning.png");
	});

	it("guards the review dialog against outside-click dismissal (desktop)", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const seededPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-1",
				title: "E2E guarded review note",
				path: "Keep/E2E guarded review note.md",
			}),
		]);

		await openSeededSyncCenter({ import: seededPlan }, { runDelayMs: 1200, initialMode: "import" });

		const startSyncButton = browser.$(buttonByText("Start sync"));
		await startSyncButton.waitForExist({ timeout: 20000 });
		await startSyncButton.click();

		const reviewTitle = browser.$('//*[normalize-space(.)="Review download plan"]');
		await reviewTitle.waitForExist({ timeout: 20000 });

		await triggerSyncCenterBackdropClick();

		const closePrompt = browser.$('//*[normalize-space(.)="Close sync center?"]');
		await closePrompt.waitForExist({ timeout: 20000 });
		expect(await browser.$(exactButtonByText("Close")).isExisting()).toBe(true);
		expect(await browser.$(exactButtonByText("Back")).isExisting()).toBe(true);
		expect(await browser.$(buttonByText("Cancel sync")).isExisting()).toBe(false);
		expect(await browser.$(buttonByText("Run in background")).isExisting()).toBe(false);

		await browser.$(exactButtonByText("Back")).click();
		await browser.waitUntil(async () => !(await closePrompt.isExisting()), {
			timeout: 20000,
			interval: 200,
		});
	});

	it("shows cancel and background guard options while a seeded sync is running (desktop)", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const seededPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-1",
				title: "E2E guarded running note",
				path: "Keep/E2E guarded running note.md",
			}),
		]);

		await openSeededSyncCenter({ import: seededPlan }, { runDelayMs: 1500, initialMode: "import" });

		const startSyncButton = browser.$(buttonByText("Start sync"));
		await startSyncButton.waitForExist({ timeout: 20000 });
		await startSyncButton.click();
		await browser.$(buttonByText("Execute")).click();

		const runningTitle = browser.$('//*[normalize-space(.)="Running download plan"]');
		await runningTitle.waitForExist({ timeout: 20000 });
		expect(await browser.$(exactButtonByText("Cancel")).isExisting()).toBe(true);

		await triggerSyncCenterBackdropClick();

		const runningPrompt = browser.$('//*[normalize-space(.)="Leave this sync running?"]');
		await runningPrompt.waitForExist({ timeout: 20000 });
		expect(await browser.$(exactButtonByText("Cancel sync")).isExisting()).toBe(true);
		expect(await browser.$(exactButtonByText("Run in background")).isExisting()).toBe(true);
		expect(await browser.$(exactButtonByText("Back")).isExisting()).toBe(true);

		await browser.$(exactButtonByText("Back")).click();

		const completeTitle = browser.$('//*[normalize-space(.)="Download complete"]');
		await completeTitle.waitForExist({ timeout: 20000 });
	});

	it("cancels a seeded running sync and returns to sync center with canceled status (desktop)", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const seededPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-1",
				title: "E2E canceled note",
				path: "Keep/E2E canceled note.md",
			}),
		]);

		await openSeededSyncCenter(
			{ import: seededPlan },
			{ runDelayMs: 4000, initialMode: "import", supportCancel: true }
		);

		const startSyncButton = browser.$(buttonByText("Start sync"));
		await startSyncButton.waitForExist({ timeout: 20000 });
		await startSyncButton.click();
		await browser.$(buttonByText("Execute")).click();

		const runningTitle = browser.$('//*[normalize-space(.)="Running download plan"]');
		await runningTitle.waitForExist({ timeout: 20000 });

		const cancelButton = browser.$(exactButtonByText("Cancel"));
		await cancelButton.waitForExist({ timeout: 20000 });
		await cancelButton.click();

		// The disabled canceling state is covered by modal unit tests and may complete
		// before WebDriver's next poll when a seeded run observes cancellation quickly.
		const canceledSummary = browser.$('//*[contains(normalize-space(.),"was canceled after")]');
		await canceledSummary.waitForExist({ timeout: 20000 });
		expect(await browser.$('//*[normalize-space(.)="Sync center"]').isExisting()).toBe(true);
		expect(await browser.$(buttonByText("Start sync")).isExisting()).toBe(true);
		expect(await browser.$('//*[contains(normalize-space(.),"failed after")]').isExisting()).toBe(false);
	});

	it("walks setup to review to run to done for upload mode with seeded data (desktop)", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const uploadPlan = createPreparedSyncPlanFixture("push", "upload", [
			createSyncPlanEntryFixture("upload", "Upload", {
				id: "upload-1",
				mode: "push",
				stage: "upload",
				title: "E2E upload note",
				path: "Keep/E2E upload note.md",
			}),
			createSyncPlanEntryFixture("skipped-up-to-date", "Skipped: up to date", {
				id: "uptodate-1",
				mode: "push",
				stage: "upload",
				title: "E2E up to date note",
				path: "Keep/E2E up to date note.md",
				selectable: false,
				selected: false,
			}),
		]);

		await openSeededSyncCenter({ push: uploadPlan }, { runDelayMs: 700, initialMode: "push", gateAllowed: true });

		const startSyncButton = browser.$(buttonByText("Start sync"));
		await startSyncButton.waitForExist({ timeout: 20000 });

		await startSyncButton.click();

		const reviewTitle = browser.$('//*[normalize-space(.)="Review upload plan"]');
		await reviewTitle.waitForExist({ timeout: 20000 });
		expect(await browser.$('//*[contains(normalize-space(.),"Upload 1")]').isExisting()).toBe(true);

		await browser.$(buttonByText("Execute")).click();

		const runningTitle = browser.$('//*[normalize-space(.)="Running upload plan"]');
		await runningTitle.waitForExist({ timeout: 20000 });
		expect(await browser.$('//*[contains(normalize-space(.),"Uploaded 0/1")]').isExisting()).toBe(true);

		const completeTitle = browser.$('//*[normalize-space(.)="Upload complete"]');
		await completeTitle.waitForExist({ timeout: 20000 });
		expect(await browser.$('//*[contains(normalize-space(.),"Uploaded 1/1")]').isExisting()).toBe(true);
		expect(await browser.$('//*[contains(normalize-space(.),"Already up to date 1/1")]').isExisting()).toBe(true);
	});

	it("applies, rejects a replacement, and removes a supporter key in settings (desktop)", async function () {
		if (isAndroid()) {
			this.skip();
			return;
		}

		const acceptedKey = "ABCD-EFGH-IJKL-MN12";
		await browser.executeObsidian(async ({ app }, validKey) => {
			type SubscriptionInfoLike = {
				subscription_status: "active" | "inactive";
				plan_details: { plan_id: string; features: string[] };
				metering_info: null;
				trial_or_promo: null;
			};
			type PluginLike = {
				settings: {
					email: string;
					supporterKey?: string;
					supporterKeyConfigured: boolean;
					supporterKeyIdentity?: string;
					subscriptionCache?: unknown;
				};
				subscriptionService: {
					isSubscriptionActive: (forceRefresh?: boolean) => Promise<boolean>;
					checkSubscription: (forceRefresh?: boolean) => Promise<SubscriptionInfoLike>;
					validateSupporterKey: (key: string) => Promise<SubscriptionInfoLike>;
					primeCurrentCache: (info: SubscriptionInfoLike) => Promise<void>;
				};
				invalidateSubscriptionIdentity: () => void;
				saveSettings: () => Promise<void>;
			};

			const plugin = app.plugins.getPlugin("keepsidian") as PluginLike | undefined;
			if (!plugin) {
				throw new Error("KeepSidian plugin is unavailable");
			}
			app.secretStorage.setSecret("keepsidian-supporter-key", "");
			plugin.settings.supporterKey = undefined;
			plugin.settings.supporterKeyConfigured = false;
			plugin.settings.supporterKeyIdentity = undefined;
			plugin.invalidateSubscriptionIdentity();

			const activeInfo: SubscriptionInfoLike = {
				subscription_status: "active",
				plan_details: { plan_id: "e2e", features: [] },
				metering_info: null,
				trial_or_promo: null,
			};
			const inactiveInfo: SubscriptionInfoLike = {
				...activeInfo,
				subscription_status: "inactive",
			};
			plugin.subscriptionService.isSubscriptionActive = async () => plugin.settings.supporterKeyConfigured;
			plugin.subscriptionService.checkSubscription = async () =>
				plugin.settings.supporterKeyConfigured ? activeInfo : inactiveInfo;
			plugin.subscriptionService.validateSupporterKey = async (key) => (key === validKey ? activeInfo : inactiveInfo);
			plugin.subscriptionService.primeCurrentCache = async () => undefined;
			await plugin.saveSettings();
		}, acceptedKey);

		await openKeepSidianSettingsTab();
		const syncIntervalSelector =
			'//*[contains(@class,"setting-item-name") and normalize-space(.)="Sync interval (hours)"]/ancestor::*[contains(@class,"setting-item")]//input';
		expect(await browser.$(syncIntervalSelector).isEnabled()).toBe(false);
		const keyEditor = browser.$('[data-keepsidian-supporter-key-editor="true"]');
		expect(await keyEditor.isDisplayed()).toBe(false);
		const useKeyButton = browser.$(exactButtonByText("Use key"));
		await useKeyButton.waitForExist({ timeout: 20000 });
		await useKeyButton.click();

		const keyInput = browser.$('input[data-keepsidian-supporter-key-input="true"]');
		await keyInput.waitForDisplayed({ timeout: 20000 });
		expect(await keyInput.getAttribute("type")).toBe("password");
		await keyInput.setValue("abcd efgh-ijkl mn12");
		expect(await keyInput.getValue()).toBe(acceptedKey);
		await browser.$(exactButtonByText("Apply key")).click();

		const activeStatus = browser.$('//*[contains(normalize-space(.),"Active supporter (Plan: e2e)")]');
		await activeStatus.waitForExist({ timeout: 20000 });
		expect(await browser.$(syncIntervalSelector).isEnabled()).toBe(true);
		const appliedState = await browser.execute(async () => {
			type AppWindow = Window & {
				app?: {
					plugins: { getPlugin: (id: string) => unknown };
					secretStorage: { getSecret: (id: string) => string | null };
				};
			};
			const app = (window as AppWindow).app ?? (window.opener as AppWindow | null)?.app;
			if (!app) {
				throw new Error("Obsidian app is unavailable from the settings window");
			}
			const plugin = app.plugins.getPlugin("keepsidian") as
				| {
						settings?: { supporterKeyConfigured?: boolean };
						loadData?: () => Promise<Record<string, unknown>>;
				  }
				| undefined;
			return {
				storedKey: app.secretStorage.getSecret("keepsidian-supporter-key"),
				configured: plugin?.settings?.supporterKeyConfigured,
				persisted: await plugin?.loadData?.(),
			};
		});
		expect(appliedState.storedKey).toBe(acceptedKey);
		expect(appliedState.configured).toBe(true);
		expect(appliedState.persisted).not.toHaveProperty("supporterKey");

		await browser.$(exactButtonByText("Replace key")).click();
		const replacementInput = browser.$('input[data-keepsidian-supporter-key-input="true"]');
		await replacementInput.waitForDisplayed({ timeout: 20000 });
		await replacementInput.setValue("WXYZ-9876-QRST-5432");
		await browser.$(exactButtonByText("Apply key")).click();
		const rejectedNotice = browser.$(
			'//*[contains(@class,"notice") and contains(normalize-space(.),"not linked to an active subscription")]'
		);
		await rejectedNotice.waitForExist({ timeout: 20000 });
		const keyAfterRejectedReplacement = await browser.execute(() => {
			type AppWindow = Window & {
				app?: { secretStorage: { getSecret: (id: string) => string | null } };
			};
			const app = (window as AppWindow).app ?? (window.opener as AppWindow | null)?.app;
			return app?.secretStorage.getSecret("keepsidian-supporter-key");
		});
		expect(keyAfterRejectedReplacement).toBe(acceptedKey);

		await browser.$(exactButtonByText("Remove key")).click();
		await browser.$(exactButtonByText("Use key")).waitForExist({ timeout: 20000 });
		expect(await browser.$(syncIntervalSelector).isEnabled()).toBe(false);
		const removedState = await browser.execute(() => {
			type AppWindow = Window & {
				app?: {
					plugins: { getPlugin: (id: string) => unknown };
					secretStorage: { getSecret: (id: string) => string | null };
				};
			};
			const app = (window as AppWindow).app ?? (window.opener as AppWindow | null)?.app;
			if (!app) {
				throw new Error("Obsidian app is unavailable from the settings window");
			}
			const plugin = app.plugins.getPlugin("keepsidian") as
				| { settings?: { supporterKeyConfigured?: boolean; supporterKey?: string } }
				| undefined;
			return {
				storedKey: app.secretStorage.getSecret("keepsidian-supporter-key"),
				configured: plugin?.settings?.supporterKeyConfigured,
				runtimeKey: plugin?.settings?.supporterKey,
			};
		});
		expect(removedState.storedKey ?? "").toBe("");
		expect(removedState.configured).toBe(false);
		expect(removedState.runtimeKey).toBeNull();
	});
});
