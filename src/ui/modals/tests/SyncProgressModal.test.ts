jest.mock("obsidian");

import { App } from "obsidian";
import { SyncProgressModal } from "../SyncProgressModal";
import type { LastSyncSummary, SyncMode } from "../../../types";
import type { PreparedSyncPlan, RunPreparedSyncPlanResult } from "@app/main-sync-flows";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "../../../test-utils/fixtures/sync-plan";

describe("SyncProgressModal", () => {
	let app: App;
	let gateState: { allowed: boolean; reasons: string[] };
	let currentMode: SyncMode | null;
	let currentPhaseLabel: string | null;
	let lastSuccessfulDownloadDate: string | undefined;
	let modalOptions: ReturnType<typeof createOptions>;

	function createOptions() {
		const preparedPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-note",
				title: "Create note",
				path: "Keep/Create note.md",
			}),
			createSyncPlanEntryFixture("skipped-identical", "Skipped: identical", {
				id: "identical-note",
				title: "Identical note",
				path: "Keep/Identical note.md",
				selectable: false,
				selected: false,
			}),
		]);
		const buildSyncPlan = jest.fn().mockResolvedValue(preparedPlan);
		const runSyncPlan = jest.fn().mockResolvedValue({});
		const requestCancelSync = jest.fn();
		const onOpenSyncLog = jest.fn().mockResolvedValue(undefined);
		const openTwoWaySettings = jest.fn();
		const isSupporterActive = jest.fn().mockResolvedValue(true);
		const renderImportOptions = jest.fn(async (containerEl: HTMLElement, isActive: boolean) => {
			containerEl.createEl("div", {
				text: `Premium options active: ${String(isActive)}`,
			});
		});

		return {
			buildSyncPlan,
			runSyncPlan,
			requestCancelSync,
			onOpenSyncLog,
			onClose: jest.fn(),
			getTwoWayGate: () => gateState,
			getLastSuccessfulDownloadDate: () => lastSuccessfulDownloadDate,
			openTwoWaySettings,
			getCurrentMode: () => currentMode,
			getCurrentPhaseLabel: () => currentPhaseLabel,
			isSupporterActive,
			renderImportOptions,
			preparedPlan,
		};
	}

	function getButton(modal: SyncProgressModal, label: string): HTMLButtonElement {
		const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
		const button =
			buttons.find((candidate) => (candidate.textContent?.replace(/\s+/g, " ").trim() ?? "") === label) ??
			buttons.find((candidate) => (candidate.textContent?.replace(/\s+/g, " ").trim() ?? "").includes(label));
		expect(button).toBeTruthy();
		return button as HTMLButtonElement;
	}

	function findButton(modal: SyncProgressModal, label: string): HTMLButtonElement | null {
		const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
		return (buttons.find((candidate) => (candidate.textContent?.replace(/\s+/g, " ").trim() ?? "") === label) ??
			buttons.find((candidate) => (candidate.textContent?.replace(/\s+/g, " ").trim() ?? "").includes(label)) ??
			null) as HTMLButtonElement | null;
	}

	function getRowTitles(modal: SyncProgressModal): string[] {
		return Array.from(modal.contentEl.querySelectorAll(".keepsidian-sync-plan-row-title")).map(
			(element) => element.textContent?.trim() ?? ""
		);
	}

	async function flushUI() {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	function getCustomSinceInput(modal: SyncProgressModal): HTMLInputElement | null {
		return modal.contentEl.querySelector('input[data-keepsidian-role="custom-since-input"]') as HTMLInputElement | null;
	}

	function createDeferredResult() {
		let resolvePromise: (value: RunPreparedSyncPlanResult) => void = () => undefined;
		const promise = new Promise<RunPreparedSyncPlanResult>((resolve) => {
			resolvePromise = resolve;
		});
		return {
			promise,
			resolve: resolvePromise,
		};
	}

	beforeEach(() => {
		app = new App();
		gateState = { allowed: false, reasons: ["Confirm backups"] };
		currentMode = null;
		currentPhaseLabel = null;
		lastSuccessfulDownloadDate = "2024-03-01T09:15:00.000Z";
		modalOptions = createOptions();
	});

	test("starts in compact setup mode with Start sync and a three-step header", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Sync center");
		expect(modal.contentEl.textContent).toContain("Start or customize sync.");
		expect(modal.contentEl.textContent).toContain("Start");
		expect(modal.contentEl.textContent).toContain("Review");
		expect(modal.contentEl.textContent).toContain("Done");
		expect(getButton(modal, "Start sync")).toBeTruthy();
		expect(getButton(modal, "Open sync log")).toBeTruthy();
		expect(getButton(modal, "Customize sync")).toBeTruthy();
		expect(findButton(modal, "Run sync")).toBeNull();
	});

	test("Start sync opens review mode with Back, Refresh, and Run sync", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();

		expect(modalOptions.buildSyncPlan).toHaveBeenCalledWith(
			"import",
			expect.objectContaining({
				setTotalNotes: expect.any(Function),
				reportPlanProgress: expect.any(Function),
			}),
			{ kind: "last-sync" }
		);
		expect(modal.contentEl.textContent).toContain("Review download plan");
		expect(modal.contentEl.textContent).not.toContain("Download step");
		expect(getButton(modal, "Back")).toBeTruthy();
		expect(getButton(modal, "Refresh")).toBeTruthy();
		expect(getButton(modal, "Execute")).toBeTruthy();
		expect(findButton(modal, "Customize sync")).toBeNull();
		expect(findButton(modal, "Open sync log")).toBeNull();
	});

	test("shows 'Downloaded, please wait ...' once review fetch reaches the known total", async () => {
		let buildCallbacks:
			| {
					setTotalNotes?: (total: number) => void;
					reportPlanProgress?: (processed: number, total?: number) => void;
			  }
			| undefined;
		modalOptions.buildSyncPlan.mockImplementationOnce(async (_mode, callbacks) => {
			buildCallbacks = callbacks;
			return await new Promise<PreparedSyncPlan | null>(() => undefined);
		});

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();

		buildCallbacks?.setTotalNotes?.(3);
		buildCallbacks?.reportPlanProgress?.(3, 3);
		await flushUI();

		expect(getButton(modal, "Downloaded, please wait ...")).toBeTruthy();
	});

	test("customize sync renders start-date controls for download-capable modes only", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();

		expect(getButton(modal, "Customize sync").getAttribute("aria-expanded")).toBe("false");

		getButton(modal, "Customize sync").click();
		await flushUI();

		expect(getButton(modal, "Customize sync").getAttribute("aria-expanded")).toBe("true");
		expect(modal.contentEl.textContent).toContain("Mode");
		expect(modal.contentEl.textContent).toContain("Start date");
		expect(modal.contentEl.textContent).toContain("Last successful sync");
		expect(modal.contentEl.textContent).toContain("Last sync:");
		expect(modal.contentEl.textContent).toContain("2024");
		expect(modalOptions.isSupporterActive).toHaveBeenCalled();
		expect(modal.contentEl.textContent).toContain("Download options");
		expect(modal.contentEl.textContent).toContain("Premium options active: true");
		expect(getCustomSinceInput(modal)).toBeNull();

		getButton(modal, "Custom").click();
		await flushUI();

		const input = getCustomSinceInput(modal) as HTMLInputElement;
		expect(input).toBeTruthy();
		expect(input.value).toContain("2024-03-01");
		expect(input.placeholder).toBe("YYYY-MM-DD HH:MM");
		expect(modal.contentEl.textContent).toContain("Use YYYY-MM-DD HH:MM.");

		getButton(modal, "Upload").click();
		await flushUI();

		expect(modal.contentEl.textContent).not.toContain("Start date");
		expect(modal.contentEl.textContent).not.toContain("Premium options active: true");
	});

	test("invalid or future custom dates block review generation", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();

		getButton(modal, "Customize sync").click();
		await flushUI();
		getButton(modal, "Custom").click();
		await flushUI();

		const input = getCustomSinceInput(modal) as HTMLInputElement;
		expect(input).toBeTruthy();
		input.value = "2999-01-01 00:00";
		input.dispatchEvent(new Event("change"));
		await flushUI();

		getButton(modal, "Start sync").click();
		await flushUI();

		expect(modalOptions.buildSyncPlan).not.toHaveBeenCalled();
		expect(modal.contentEl.textContent).toContain("Couldn’t prepare the sync review");
		expect(modal.contentEl.textContent).toContain("Custom date must be in the past.");
	});

	test("custom date input accepts a full four-digit year and builds a matching local timestamp", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();

		getButton(modal, "Customize sync").click();
		await flushUI();
		getButton(modal, "Custom").click();
		await flushUI();

		const input = getCustomSinceInput(modal) as HTMLInputElement;
		expect(input).toBeTruthy();
		input.value = "2025-04-12 09:17";
		input.dispatchEvent(new Event("input"));
		expect(modal.contentEl.textContent).toContain("Use YYYY-MM-DD HH:MM.");
		expect(modal.contentEl.textContent).not.toContain("Choose a custom date.");
		input.dispatchEvent(new Event("change"));
		await flushUI();

		getButton(modal, "Start sync").click();
		await flushUI();

		expect(modalOptions.buildSyncPlan).toHaveBeenLastCalledWith("import", expect.any(Object), {
			kind: "custom-since",
			since: new Date(2025, 3, 12, 9, 17, 0, 0).toISOString(),
		});
	});

	test("reopening the modal resets download scope to the default", async () => {
		const firstModal = new SyncProgressModal(app, modalOptions);
		firstModal.onOpen();
		getButton(firstModal, "Customize sync").click();
		await flushUI();
		getButton(firstModal, "All dates").click();
		await flushUI();
		getButton(firstModal, "Start sync").click();
		await flushUI();

		expect(modalOptions.buildSyncPlan).toHaveBeenLastCalledWith("import", expect.any(Object), { kind: "all" });

		const secondModal = new SyncProgressModal(app, modalOptions);
		secondModal.onOpen();
		getButton(secondModal, "Customize sync").click();
		await flushUI();
		getButton(secondModal, "Start sync").click();
		await flushUI();

		expect(modalOptions.buildSyncPlan).toHaveBeenLastCalledWith("import", expect.any(Object), { kind: "last-sync" });
	});

	test("customize sync two-way mode surfaces gate guidance and deep-links to settings", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();

		getButton(modal, "Customize sync").click();
		await flushUI();
		getButton(modal, "Two-way sync").click();
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Confirm backups");

		getButton(modal, "Open beta settings").click();
		expect(modalOptions.openTwoWaySettings).toHaveBeenCalled();
	});

	test("shows a friendly sync-center alert when review generation cannot reach the server", async () => {
		modalOptions.buildSyncPlan.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"));

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Couldn’t prepare the sync review");
		expect(modal.contentEl.textContent).toContain(
			"The KeepSidian server could not be reached. Check your connection or make sure the sync server is running, then try again."
		);
		expect(modal.contentEl.textContent).toContain("Start or customize sync.");
	});

	test("shows a friendly sync-center alert when execution cannot reach the server", async () => {
		modalOptions.runSyncPlan.mockRejectedValueOnce(new Error("Failed to fetch"));

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();
		getButton(modal, "Execute").click();
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Couldn’t finish the sync");
		expect(modal.contentEl.textContent).toContain(
			"The KeepSidian server could not be reached. Check your connection or make sure the sync server is running, then try again."
		);
		expect(modal.contentEl.textContent).toContain("Review download plan");
	});

	test("outside clicks on review show a close confirmation instead of dismissing the modal", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();

		modal.containerEl.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Close sync center?");
		expect(getButton(modal, "Close")).toBeTruthy();
		expect(getButton(modal, "Back")).toBeTruthy();
		expect(findButton(modal, "Cancel sync")).toBeNull();
		expect(findButton(modal, "Run in background")).toBeNull();
	});

	test("chips filter the review list by category", async () => {
		modalOptions.buildSyncPlan.mockResolvedValueOnce(
			createPreparedSyncPlanFixture("import", "import", [
				createSyncPlanEntryFixture("create", "Create", {
					id: "create-1",
					title: "Create row",
				}),
				createSyncPlanEntryFixture("merge", "Merge", {
					id: "merge-1",
					title: "Merge row",
				}),
			])
		);

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();

		expect(getRowTitles(modal)).toEqual(["Create row", "Merge row"]);

		getButton(modal, "Merge 1").click();
		await flushUI();

		expect(getRowTitles(modal)).toEqual(["Merge row"]);

		getButton(modal, "Notes 2").click();
		await flushUI();

		expect(getRowTitles(modal)).toEqual(["Create row", "Merge row"]);
	});

	test("supporters get select-all while non-supporters see locked controls", async () => {
		const supporterPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-1",
				title: "Create row",
			}),
			createSyncPlanEntryFixture("merge", "Merge", {
				id: "merge-1",
				title: "Merge row",
			}),
		]);
		modalOptions.buildSyncPlan.mockResolvedValueOnce(supporterPlan);

		const supporterModal = new SyncProgressModal(app, modalOptions);
		supporterModal.onOpen();
		getButton(supporterModal, "Start sync").click();
		await flushUI();
		expect(supporterModal.contentEl.textContent).toContain("Select all");

		const lockedPlan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "locked-1",
				title: "Locked row",
				selectionLocked: true,
				selectionLockedReason: "Available to project supporters",
			}),
		]);
		modalOptions.buildSyncPlan.mockResolvedValueOnce(lockedPlan);

		const nonSupporterModal = new SyncProgressModal(app, modalOptions);
		nonSupporterModal.onOpen();
		getButton(nonSupporterModal, "Start sync").click();
		await flushUI();

		expect(nonSupporterModal.contentEl.textContent).not.toContain("Select all");
		expect(nonSupporterModal.contentEl.textContent).toContain("Per-note selection is available to project supporters.");
		const checkbox = nonSupporterModal.contentEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(checkbox.disabled).toBe(true);
		expect(checkbox.title).toBe("Available to project supporters");
	});

	test("execution chips keep semantic categories and use X/Y counts", async () => {
		const plan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-1",
				title: "Create row",
			}),
			createSyncPlanEntryFixture("conflict-copy", "Conflict copy", {
				id: "conflict-1",
				title: "Conflict row",
			}),
			createSyncPlanEntryFixture("skipped-identical", "Skipped: identical", {
				id: "identical-1",
				title: "Identical row",
				selectable: false,
				selected: false,
			}),
			createSyncPlanEntryFixture("merge", "Merge", {
				id: "unchecked-1",
				title: "Unchecked row",
				selected: false,
			}),
		]);
		const deferred = createDeferredResult();
		modalOptions.buildSyncPlan.mockResolvedValueOnce(plan);
		modalOptions.runSyncPlan.mockImplementationOnce(async (_preparedPlan, callbacks) => {
			void callbacks?.onEntrySettled;
			return await deferred.promise;
		});

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();

		getButton(modal, "Execute").click();
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Running download plan");
		expect(modal.contentEl.textContent).toContain("2 selected. 1 pending.");
		expect(modal.contentEl.textContent).toContain("1 of 2 selected notes dealt with.");
		expect(modal.contentEl.textContent).toContain("Notes 1/2");
		expect(modal.contentEl.textContent).toContain("Created 0/1");
		expect(modal.contentEl.textContent).toContain("Conflict copy 1/1");
		expect(modal.contentEl.textContent).toContain("Already up to date 1/1");
		expect(modal.contentEl.textContent).toContain("Unchecked 1/1");

		const runCallback = modalOptions.runSyncPlan.mock.calls[0]?.[1];
		expect(runCallback).toEqual(
			expect.objectContaining({
				onEntrySettled: expect.any(Function),
			})
		);
		runCallback.onEntrySettled("create-1", true);
		await flushUI();

		expect(modal.contentEl.textContent).toContain("2 selected. 0 pending.");
		expect(modal.contentEl.textContent).toContain("2 of 2 selected notes dealt with.");
		expect(modal.contentEl.textContent).toContain("Notes 2/2");
		expect(modal.contentEl.textContent).toContain("Created 1/1");

		deferred.resolve({});
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Download complete");
		expect(modal.contentEl.textContent).toContain("Open sync log");
	});

	test("running updates keep the plan container stable instead of rebuilding the modal", async () => {
		const plan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-1",
				title: "Create row",
			}),
			createSyncPlanEntryFixture("merge", "Merge", {
				id: "merge-1",
				title: "Merge row",
			}),
		]);
		const deferred = createDeferredResult();
		modalOptions.buildSyncPlan.mockResolvedValueOnce(plan);
		modalOptions.runSyncPlan.mockImplementationOnce(async (_preparedPlan, callbacks) => {
			void callbacks?.onEntrySettled;
			return await deferred.promise;
		});

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();
		getButton(modal, "Execute").click();
		await flushUI();

		const planEl = modal.contentEl.querySelector(".keepsidian-sync-plan");
		const listEl = modal.contentEl.querySelector(".keepsidian-sync-plan-list");
		expect(planEl).toBeTruthy();
		expect(listEl).toBeTruthy();

		const runCallback = modalOptions.runSyncPlan.mock.calls[0]?.[1];
		runCallback.onEntrySettled("create-1", true);
		await flushUI();

		expect(modal.contentEl.querySelector(".keepsidian-sync-plan")).toBe(planEl);
		expect(modal.contentEl.querySelector(".keepsidian-sync-plan-list")).toBe(listEl);

		deferred.resolve({});
		await flushUI();
	});

	test("running progress updates mutate existing execution rows instead of recreating them", async () => {
		const plan = createPreparedSyncPlanFixture("import", "import", [
			createSyncPlanEntryFixture("create", "Create", {
				id: "create-1",
				title: "Create row",
			}),
			createSyncPlanEntryFixture("merge", "Merge", {
				id: "merge-1",
				title: "Merge row",
			}),
		]);
		const deferred = createDeferredResult();
		modalOptions.buildSyncPlan.mockResolvedValueOnce(plan);
		modalOptions.runSyncPlan.mockImplementationOnce(async (_preparedPlan, callbacks) => {
			void callbacks?.onEntrySettled;
			return await deferred.promise;
		});

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();
		getButton(modal, "Execute").click();
		await flushUI();

		const firstRowBefore = modal.contentEl.querySelector(".keepsidian-sync-plan-row") as HTMLDivElement;
		const firstBadgeBefore = firstRowBefore.querySelector(".keepsidian-sync-plan-row-badge") as HTMLSpanElement;
		expect(firstBadgeBefore.textContent).toBe("Pending");

		modal.setProgress(1, 2);
		await flushUI();

		const firstRowAfterProgress = modal.contentEl.querySelector(".keepsidian-sync-plan-row") as HTMLDivElement;
		expect(firstRowAfterProgress).toBe(firstRowBefore);

		const runCallback = modalOptions.runSyncPlan.mock.calls[0]?.[1];
		runCallback.onEntrySettled("create-1", true);
		await flushUI();

		const firstRowAfterSettled = modal.contentEl.querySelector(".keepsidian-sync-plan-row") as HTMLDivElement;
		const firstBadgeAfterSettled = firstRowAfterSettled.querySelector(
			".keepsidian-sync-plan-row-badge"
		) as HTMLSpanElement;
		expect(firstRowAfterSettled).toBe(firstRowBefore);
		expect(firstBadgeAfterSettled.textContent).toBe("Created");
		expect(firstRowAfterSettled.classList.contains("is-done")).toBe(true);

		deferred.resolve({});
		await flushUI();
	});

	test("closing during a running sync requests cancellation and preserves the modal instance state", async () => {
		const deferred = createDeferredResult();
		modalOptions.runSyncPlan.mockImplementationOnce(async (_preparedPlan, callbacks) => {
			void callbacks?.onEntrySettled;
			return await deferred.promise;
		});

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();
		getButton(modal, "Execute").click();
		await flushUI();

		modal.onClose();
		await flushUI();

		expect(modalOptions.requestCancelSync).toHaveBeenCalledTimes(1);
		expect(modalOptions.onClose).toHaveBeenCalledWith({ activeRun: true });
		expect(getButton(modal, "Canceling ...").disabled).toBe(true);

		modal.onOpen();
		await flushUI();
		expect(modal.contentEl.textContent).toContain("Running download plan");

		deferred.resolve({});
		await flushUI();
	});

	test("outside clicks during a running sync show cancel and background options", async () => {
		const deferred = createDeferredResult();
		modalOptions.runSyncPlan.mockImplementationOnce(async (_preparedPlan, callbacks) => {
			void callbacks?.onEntrySettled;
			return await deferred.promise;
		});

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();
		getButton(modal, "Execute").click();
		await flushUI();

		modal.containerEl.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Leave this sync running?");
		expect(getButton(modal, "Cancel sync")).toBeTruthy();
		expect(getButton(modal, "Run in background")).toBeTruthy();
		expect(getButton(modal, "Back")).toBeTruthy();

		deferred.resolve({});
		await flushUI();
	});

	test("cancel button keeps the running dialog open until the sync aborts, then returns to sync center", async () => {
		const deferred = createDeferredResult();
		const canceledSummary: LastSyncSummary = {
			timestamp: Date.now(),
			processedNotes: 1,
			totalNotes: 1,
			success: false,
			status: "canceled",
			mode: "import",
		};
		const modal = new SyncProgressModal(app, modalOptions);
		modalOptions.runSyncPlan.mockImplementationOnce(async () => {
			const result = await deferred.promise;
			return result;
		});
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();
		getButton(modal, "Execute").click();
		await flushUI();

		getButton(modal, "Cancel").click();
		await flushUI();

		expect(modalOptions.requestCancelSync).toHaveBeenCalledTimes(1);
		expect(getButton(modal, "Canceling ...").disabled).toBe(true);
		expect(modal.contentEl.textContent).toContain("Running download plan");

		modal.setComplete("canceled", 1);
		modal.setIdleSummary(canceledSummary);
		deferred.resolve({ canceled: true });
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Sync center");
		expect(modal.contentEl.textContent).toContain("Last import attempt");
		expect(modal.contentEl.textContent).toContain("was canceled after 1/1 note");
		expect(modal.contentEl.textContent).not.toContain("Download failed");
	});

	test("two-way review advances to upload review and refreshes the upload stage in place", async () => {
		const importPlan = createPreparedSyncPlanFixture("two-way", "import", [
			createSyncPlanEntryFixture("merge", "Merge", {
				id: "merge-1",
				mode: "two-way",
				stage: "import",
			}),
		]);
		const uploadPlan = createPreparedSyncPlanFixture("two-way", "upload", [
			createSyncPlanEntryFixture("upload", "Upload", {
				id: "upload-1",
				mode: "two-way",
				stage: "upload",
				path: "Keep/Upload.md",
			}),
		]);
		const refreshedUploadPlan = createPreparedSyncPlanFixture("push", "upload", [
			createSyncPlanEntryFixture("upload", "Upload", {
				id: "upload-2",
				mode: "push",
				stage: "upload",
				title: "Refreshed upload row",
				path: "Keep/Refreshed Upload.md",
			}),
		]);
		modalOptions.buildSyncPlan.mockResolvedValueOnce(importPlan).mockResolvedValueOnce(refreshedUploadPlan);
		modalOptions.runSyncPlan.mockResolvedValueOnce({ nextPlan: uploadPlan });

		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Customize sync").click();
		await flushUI();
		getButton(modal, "All dates").click();
		await flushUI();
		modal.setSelectedMode("two-way");
		getButton(modal, "Start sync").click();
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Review download plan");
		expect(modalOptions.buildSyncPlan).toHaveBeenNthCalledWith(1, "two-way", expect.any(Object), { kind: "all" });

		getButton(modal, "Execute").click();
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Review upload plan");
		expect(modal.contentEl.textContent).not.toContain("Upload step");

		getButton(modal, "Refresh").click();
		await flushUI();

		expect(modalOptions.buildSyncPlan).toHaveBeenLastCalledWith("push");
		expect(modal.contentEl.textContent).toContain("Refreshed upload row");
	});

	test("setup mode still shows live sync status for background sync monitoring", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();

		currentMode = "two-way";
		currentPhaseLabel = "Download step";
		(modal as unknown as { isSyncing: boolean }).isSyncing = true;
		modal.setProgress(3, 10);
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Sync center");
		expect(modal.contentEl.textContent).toContain("Download step: 3/10");

		(modal as unknown as { isSyncing: boolean }).isSyncing = false;
		const summary: LastSyncSummary = {
			timestamp: Date.now(),
			processedNotes: 4,
			totalNotes: 4,
			success: true,
			status: "success",
			mode: "two-way",
		};
		modal.setComplete(true, 4);
		modal.setIdleSummary(summary);
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Last two-way sync completed");
		expect(modal.contentEl.textContent).toContain("Synced 4/4 notes");
	});

	test("shows attachment warnings as a completed download result", async () => {
		const modal = new SyncProgressModal(app, modalOptions);
		modal.onOpen();
		getButton(modal, "Start sync").click();
		await flushUI();
		getButton(modal, "Execute").click();
		await flushUI();

		modal.setComplete("warning", 3, 2);
		await flushUI();

		expect(modal.contentEl.textContent).toContain("Download complete with warnings");
		expect(modal.contentEl.textContent).toContain("Sync complete with 2 attachment warnings. Processed 3 notes.");
	});
});
