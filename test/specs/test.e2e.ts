import { browser, expect } from "@wdio/globals";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "../../src/test-utils/fixtures/sync-plan";
import type { SyncMode } from "../../src/types";

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
		await completeMobileOnboardingIfNeeded();

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
			if (settingManager?.openTabById) {
				settingManager.openTabById("keepsidian");
			}
		});

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
		}
	): Promise<void> => {
		const runDelayMs = options?.runDelayMs ?? 500;
		const initialMode = options?.initialMode ?? "import";
		const gateAllowed = options?.gateAllowed ?? false;
		const supportCancel = options?.supportCancel ?? false;
		await browser.executeObsidian(
			({ app }, preparedPlans, delayMs, requestedMode, allowGate, allowCancel) => {
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
									status?: "success" | "failed" | "canceled";
									mode: SyncMode;
								} | null;
								settings?: {
									lastSyncSummary?: {
										timestamp: number;
										processedNotes: number;
										totalNotes?: number | null;
										success: boolean;
										status?: "success" | "failed" | "canceled";
										mode: SyncMode;
									} | null;
								};
								progressModal?: {
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
					return {};
				};
			},
			plansByMode,
			runDelayMs,
			initialMode,
			gateAllowed,
			supportCancel
		);
	};

	before(async function () {
		// You can create test vaults and open them with reloadObsidian
		// Alternatively if all your tests use the same vault, you can
		// set the default vault in the wdio.conf.mts.
		await browser.reloadObsidian({ vault: "./test/vaults/simple" });
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

	it("shows token helper retrieval button on desktop", async function () {
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

		const helperButton = browser.$('//button[normalize-space(.)="Retrieve token with helper"]');
		await helperButton.waitForExist({ timeout: 20000 });
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

		const helperButton = browser.$('//button[normalize-space(.)="Retrieve token with helper"]');
		expect(await helperButton.isExisting()).toBe(false);

		const mobileDescription = browser.$(
			'//*[contains(@class,"setting-item-name") and normalize-space(.)="Retrieve your sync token"]/ancestor::*[contains(@class,"setting-item")]//*[contains(@class,"setting-item-description")]'
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

		const downloadScopeHeading = browser.$('//*[normalize-space(.)="Start date"]');
		await downloadScopeHeading.waitForExist({ timeout: 20000 });
		expect(await browser.$(buttonByText("Last successful sync")).isExisting()).toBe(true);
		expect(await browser.$(buttonByText("All dates")).isExisting()).toBe(true);
		expect(await browser.$(exactButtonByText("Custom")).isExisting()).toBe(true);

		await browser.$(exactButtonByText("Custom")).click();
		const customSinceInput = browser.$('//input[@data-keepsidian-role="custom-since-input"]');
		await customSinceInput.waitForExist({ timeout: 20000 });
		await customSinceInput.setValue("2025-04-12 09:17");
		expect(await customSinceInput.getValue()).toBe("2025-04-12 09:17");
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
		expect(await browser.$(buttonByText("Close")).isExisting()).toBe(true);
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

		const cancelingButton = browser.$(exactButtonByText("Canceling ..."));
		await cancelingButton.waitForExist({ timeout: 20000 });

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
});
