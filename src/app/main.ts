import { Notice, Plugin } from "obsidian";
import type { ProgressBarComponent } from "obsidian";
import type { KeepSidianPluginSettings, LastSyncSummary, SyncMode } from "../types/keepsidian-plugin-settings";
import { resolveLoadedSettings } from "../types/keepsidian-plugin-settings";
import { SubscriptionService } from "@services/subscription";
import type { NoteImportOptions } from "@ui/modals/NoteImportOptionsModal";
import { SyncProgressModal } from "@ui/modals/SyncProgressModal";
import { initializeStatusBar } from "@app/sync-ui";
import { logSync } from "@app/logging";
import { SyncCancellationError } from "@app/sync-cancel";
import { getLastSuccessfulSyncDate } from "@features/keep/sync";
import { KeepSidianSettingsTab } from "@ui/settings/KeepSidianSettingsTab";
import { SubscriptionSettingsTab } from "@ui/settings/SubscriptionSettingsTab";
import { registerRibbonAndCommands } from "@app/commands";
import {
	buildPersistedSettings,
	hydrateDriveSecretsFromSecretStorage,
	hydrateSyncTokenFromSecretStorage,
	persistSensitiveSettingsToSecretStorage,
} from "@app/main-secret-storage";
import {
	buildManualSyncPlan,
	openLatestSyncLogFlow,
	runImportNotesFlow,
	runPushNotesFlow,
	runPreparedSyncPlan,
	runTwoWaySyncFlow,
} from "@app/main-sync-flows";

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface TwoWayGateOptions {
	requirePremium?: boolean;
	requireAutoSync?: boolean;
}

interface TwoWayGateResult {
	allowed: boolean;
	reasons: string[];
}

interface SyncCenterOpenOptions {
	mode?: SyncMode;
	autoStart?: boolean;
}

interface ActiveSyncRequest {
	cancelRequested: boolean;
}

export default class KeepSidianPlugin extends Plugin {
	settings: KeepSidianPluginSettings;
	subscriptionService: SubscriptionService;
	statusBarItemEl: HTMLElement | null = null;
	statusTextEl: HTMLSpanElement | null = null;
	progressContainerEl: HTMLDivElement | null = null;
	progressBar: ProgressBarComponent | null = null;
	progressModal: SyncProgressModal | null = null;
	progressNotice: Notice | null = null;
	progressNoticeHideTimeout: number | null = null;
	progressBarHideTimeout: number | null = null;
	processedNotes = 0;
	totalNotes: number | null = null;
	lastSyncSummary: LastSyncSummary | null = null;
	lastSyncLogPath: string | null = null;
	currentSyncMode: SyncMode | null = null;
	currentSyncPhaseLabel: string | null = null;
	private autoSyncInterval?: number;
	private isSyncing = false;
	private activeSyncRequest: ActiveSyncRequest | null = null;
	private subscriptionActive: boolean | null = null;
	private lastAutoSyncGateReasons: string[] | null = null;

	async onload() {
		await this.loadSettings();

		this.subscriptionService = new SubscriptionService(
			() => this.settings.email,
			() => this.settings.subscriptionCache,
			async (cache) => {
				this.settings.subscriptionCache = cache;
				this.refreshAutoSyncSafeguards();
				await this.saveSettings();
			}
		);

		registerRibbonAndCommands(this);
		initializeStatusBar(this);
		this.initializeSettings();

		if (this.settings.autoSyncEnabled) {
			this.startAutoSync();
		}
	}

	private initializeSettings() {
		this.addSettingTab(new KeepSidianSettingsTab(this.app, this));
	}

	private ensureCredentials(): boolean {
		const email = this.settings.email?.trim();
		if (!email) {
			new Notice("KeepSidian: please enter your Google account email in the settings before syncing.");
			return false;
		}

		const token = this.settings.token?.trim();
		if (!token) {
			new Notice("KeepSidian: please add your Google Keep token in the settings before syncing.");
			return false;
		}

		return true;
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<KeepSidianPluginSettings> | null;
		this.settings = resolveLoadedSettings(saved);
		const sensitiveSettingsChanged =
			hydrateSyncTokenFromSecretStorage(this) || hydrateDriveSecretsFromSecretStorage(this);
		this.normalizeTwoWaySettings();
		this.lastSyncSummary = this.settings.lastSyncSummary ?? null;
		this.lastSyncLogPath = this.settings.lastSyncLogPath ?? null;
		if (sensitiveSettingsChanged) {
			await this.saveData(buildPersistedSettings(this));
		}
	}

	private normalizeTwoWaySettings() {
		if (!this.settings.twoWaySyncBackupAcknowledged) {
			if (this.settings.twoWaySyncEnabled) {
				this.settings.twoWaySyncEnabled = false;
			}
			if (this.settings.twoWaySyncAutoSyncEnabled) {
				this.settings.twoWaySyncAutoSyncEnabled = false;
			}
		} else if (!this.settings.twoWaySyncEnabled && this.settings.twoWaySyncAutoSyncEnabled) {
			this.settings.twoWaySyncAutoSyncEnabled = false;
		}
	}

	private getCachedSubscriptionActive(): boolean | null {
		const cachedInfo = this.settings.subscriptionCache?.info ?? null;
		if (!cachedInfo) {
			return null;
		}
		return cachedInfo.subscription_status === "active";
	}

	private computeTwoWayGate(
		options: TwoWayGateOptions = {},
		subscriptionOverride: boolean | null = null
	): TwoWayGateResult {
		const reasons: string[] = [];
		const requirePremium = options.requirePremium ?? false;
		const requireAutoSync = options.requireAutoSync ?? false;
		const backupAcknowledged = this.settings.twoWaySyncBackupAcknowledged;
		const manualEnabled = this.settings.twoWaySyncEnabled;
		const autoUploadsEnabled = this.settings.twoWaySyncAutoSyncEnabled;
		const autoSyncEnabled = this.settings.autoSyncEnabled;

		if (!backupAcknowledged) {
			reasons.push("Please opt-in to two-way sync in settings first.");
		}
		if (backupAcknowledged && !manualEnabled) {
			reasons.push("Please enable two-way sync in settings first.");
		}

		const subscriptionActive = subscriptionOverride ?? this.subscriptionActive ?? this.getCachedSubscriptionActive();
		if (requirePremium && subscriptionActive === false) {
			reasons.push("To enable uploads & two-way sync, please consider becoming a KeepSidian supporter.");
		}

		if (requireAutoSync) {
			if (!autoSyncEnabled) {
				reasons.push("Please enable auto sync in settings first.");
			}
			if (!autoUploadsEnabled) {
				reasons.push("Please enable auto two-way sync in settings first.");
			}
		}

		return {
			allowed: reasons.length === 0,
			reasons,
		};
	}

	getTwoWayGateSnapshot(options?: TwoWayGateOptions): TwoWayGateResult {
		this.normalizeTwoWaySettings();
		return this.computeTwoWayGate(options);
	}

	async requireTwoWaySafeguards(options?: TwoWayGateOptions): Promise<TwoWayGateResult> {
		this.normalizeTwoWaySettings();
		const requirePremium = options?.requirePremium ?? true;
		let subscriptionActive: boolean | null = this.subscriptionActive;
		try {
			if (requirePremium || subscriptionActive === null) {
				subscriptionActive = await this.subscriptionService.isSubscriptionActive();
				this.subscriptionActive = subscriptionActive;
			}
		} catch {
			// Subscription checks surface Notices internally; fall back to cached state.
		}
		return this.computeTwoWayGate(options, subscriptionActive);
	}

	showTwoWaySafeguardNotice(result: TwoWayGateResult) {
		if (result.allowed) {
			return;
		}

		const doc = this.app.workspace?.containerEl?.ownerDocument ?? null;
		if (!doc) {
			new Notice("KeepSidian uploads & two-way sync are locked until prerequisites are met.", 10000);
			return;
		}

		const fragment = doc.createDocumentFragment();
		fragment.createDiv({
			cls: "keepsidian-notice-heading",
			text: "KeepSidian uploads & two-way sync are locked until you:",
		});

		const list = fragment.createEl("ul", { cls: "keepsidian-notice-list" });
		for (const reason of result.reasons) {
			list.createEl("li", { text: reason });
		}

		const actions = fragment.createDiv({ cls: "keepsidian-notice-actions" });
		const settingsButton = actions.createEl("button", {
			cls: "keepsidian-notice-button",
			text: "Open beta settings",
			attr: {
				"aria-label": "Open beta settings",
				type: "button",
			},
		});

		let notice: Notice;
		settingsButton.addEventListener("click", () => {
			this.openTwoWaySettings();
			notice.hide();
		});

		notice = new Notice(fragment, 10000);
	}

	private autoSyncGateReasonsChanged(reasons: string[]): boolean {
		if (!this.lastAutoSyncGateReasons) {
			return true;
		}
		if (this.lastAutoSyncGateReasons.length !== reasons.length) {
			return true;
		}
		return this.lastAutoSyncGateReasons.some((reason, index) => reason !== reasons[index]);
	}

	private resetAutoSyncGateState() {
		this.lastAutoSyncGateReasons = null;
	}

	private async runAutoSyncTick(): Promise<void> {
		try {
			try {
				const subscriptionActive = await this.subscriptionService.isSubscriptionActive(true);
				this.subscriptionActive = subscriptionActive;
			} catch {
				// Notices are surfaced by SubscriptionService on failure; keep cached state.
			}

			const gate = await this.requireTwoWaySafeguards({ requireAutoSync: true });
			if (gate.allowed) {
				await this.performTwoWaySync();
				return;
			}

			await this.handleAutoSyncGate(gate.reasons);
		} catch (error: unknown) {
			const message = getErrorMessage(error);
			await logSync(this, `Auto sync upgrade check failed - ${message}`);
		}
	}

	private async handleAutoSyncGate(reasons: string[]): Promise<void> {
		if (reasons.length === 0) {
			return;
		}

		const reasonsChanged = this.autoSyncGateReasonsChanged(reasons);
		if (reasonsChanged) {
			this.lastAutoSyncGateReasons = [...reasons];
			this.showTwoWaySafeguardNotice({ allowed: false, reasons });
		}

		const formattedReasons = reasons.join("; ");
		await logSync(this, `Auto sync skipped uploads. Resolve in beta settings: ${formattedReasons}`);

		await this.importNotes(true);
	}

	refreshAutoSyncSafeguards() {
		this.normalizeTwoWaySettings();
		this.resetAutoSyncGateState();
	}

	openTwoWaySettings() {
		const pluginId = this.manifest?.id ?? "keepsidian";
		const settingManager = (
			this.app as unknown as {
				setting?: {
					open: () => void;
					openTabById?: (id: string) => void;
					openSettingTab?: (id: string) => void;
				};
			}
		).setting;
		if (settingManager?.open) {
			settingManager.open();
		}
		if (settingManager?.openTabById) {
			settingManager.openTabById(pluginId);
		} else if (settingManager?.openSettingTab) {
			settingManager.openSettingTab(pluginId);
		}
	}

	async saveSettings() {
		this.settings.lastSyncSummary = this.lastSyncSummary;
		this.settings.lastSyncLogPath = this.lastSyncLogPath ?? null;
		persistSensitiveSettingsToSecretStorage(this);
		await this.saveData(buildPersistedSettings(this));
	}

	isSyncInProgress(): boolean {
		return this.isSyncing;
	}

	requestCurrentSyncCancel(): boolean {
		if (!this.activeSyncRequest || this.activeSyncRequest.cancelRequested) {
			return false;
		}
		this.activeSyncRequest.cancelRequested = true;
		return true;
	}

	throwIfSyncCancelled(): void {
		if (this.activeSyncRequest?.cancelRequested) {
			throw new SyncCancellationError();
		}
	}

	openSyncProgressModal() {
		this.openSyncCenter();
	}

	private ensureSyncCenterModal(): SyncProgressModal {
		if (!this.progressModal) {
			this.progressModal = new SyncProgressModal(this.app, {
				buildSyncPlan: async (mode, callbacks, downloadScope) => {
					if (!this.ensureCredentials()) {
						return null;
					}
					return await buildManualSyncPlan(this, mode, callbacks, downloadScope);
				},
				runSyncPlan: async (preparedPlan, callbacks) => {
					if (this.isSyncing) {
						return {};
					}
					if (!this.ensureCredentials()) {
						return {};
					}
					const syncRequest: ActiveSyncRequest = { cancelRequested: false };
					this.activeSyncRequest = syncRequest;
					this.isSyncing = true;
					try {
						return await runPreparedSyncPlan(
							this,
							preparedPlan,
							getErrorMessage,
							() => this.resetAutoSyncGateState(),
							callbacks
						);
					} finally {
						if (this.activeSyncRequest === syncRequest) {
							this.activeSyncRequest = null;
						}
						this.isSyncing = false;
					}
				},
				requestCancelSync: () => {
					return this.requestCurrentSyncCancel();
				},
				onOpenSyncLog: () => this.openLatestSyncLog(),
				getTwoWayGate: () => this.getTwoWayGateSnapshot(),
				getLastSuccessfulDownloadDate: () => getLastSuccessfulSyncDate(this),
				openTwoWaySettings: () => this.openTwoWaySettings(),
				getCurrentMode: () => this.currentSyncMode,
				getCurrentPhaseLabel: () => this.currentSyncPhaseLabel,
				isSupporterActive: async () =>
					await this.subscriptionService.isSubscriptionActive(),
				renderImportOptions: async (containerEl, isActive) => {
					SubscriptionSettingsTab.displayPremiumFeatures(
						containerEl,
						this,
						isActive
					);
				},
				onClose: ({ activeRun }) => {
					if (!activeRun) {
						this.progressModal = null;
					}
				},
			});
		}

		return this.progressModal;
	}

	openSyncCenter(options?: SyncCenterOpenOptions) {
		const mode = options?.mode ?? "import";
		const autoStart = options?.autoStart ?? false;
		const modal = this.ensureSyncCenterModal();
		if (this.isSyncInProgress()) {
			const total = this.totalNotes ?? undefined;
			modal.setProgress(this.processedNotes, total);
		} else {
			modal.setSelectedMode(mode);
			modal.setIdleSummary(this.lastSyncSummary);
		}
		modal.open();
		if (autoStart && !this.isSyncInProgress()) {
			void modal.beginReview(mode);
		}
	}

	async openLatestSyncLog() {
		await openLatestSyncLogFlow(this);
	}

	async importNotes(auto = false, options?: NoteImportOptions) {
		if (this.isSyncing) {
			return;
		}

		if (!this.ensureCredentials()) {
			await logSync(this, `${auto ? "Auto" : "Manual"} sync aborted - missing credentials.`);
			return;
		}

		this.isSyncing = true;
		try {
			await runImportNotesFlow(this, auto, getErrorMessage, options);
		} finally {
			this.isSyncing = false;
		}
	}

	async pushNotes() {
		if (this.isSyncing) {
			return;
		}

		if (!this.ensureCredentials()) {
			await logSync(this, "Push sync aborted - missing credentials.");
			return;
		}

		this.isSyncing = true;
		try {
			await runPushNotesFlow(this, getErrorMessage);
		} finally {
			this.isSyncing = false;
		}
	}

	async performTwoWaySync() {
		if (this.isSyncing) {
			return;
		}

		if (!this.ensureCredentials()) {
			await logSync(this, "Two-way sync aborted - missing credentials.");
			return;
		}

		this.isSyncing = true;
		try {
			await runTwoWaySyncFlow(this, getErrorMessage, () => this.resetAutoSyncGateState());
		} finally {
			this.isSyncing = false;
		}
	}

	startAutoSync() {
		this.refreshAutoSyncSafeguards();
		this.stopAutoSync();
		const intervalMs = this.settings.autoSyncIntervalHours * 60 * 60 * 1000;
		const runner = async () => {
			if (this.isSyncing) {
				return;
			}
			await this.runAutoSyncTick();
		};
		const intervalId = window.setInterval(() => {
			void runner();
		}, intervalMs);
		this.autoSyncInterval = intervalId;
		if (typeof this.registerInterval === "function" && typeof intervalId === "number") {
			this.registerInterval(intervalId);
		}
	}

	stopAutoSync() {
		if (this.autoSyncInterval) {
			window.clearInterval(this.autoSyncInterval);
			this.autoSyncInterval = undefined;
		}
	}

	private async logSync(message: string) {
		/* moved to app/logging.ts */
	}
}
