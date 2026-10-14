import { localizePluginLabel, planEntryDetail } from "../../lang/display";
import { t, getUiTranslator } from "../../lang/ui";
import { App, Modal } from "obsidian";
import type {
	DownloadScope, DownloadScopeKind, LastSyncSummary, MergeAction, SyncMode,
	SyncPlan, SyncPlanAction, SyncPlanEntry, SyncRunStatus,
} from "@types";
import type { PreparedSyncPlan, RunPreparedSyncPlanResult, SyncPlanBuildCallbacks, SyncPlanRunCallbacks } from "@app/main-sync-flows";
import { formatModalSummary } from "@app/sync-status";
import { formatAttemptSummary } from "@app/sync-attempt";
import type { SyncAttempt } from "@app/sync-attempt";
import type { LastSyncAttempt } from "../../types/sync-attempt";
import { excludeDeletionUploads, getDeletionUploadPaths } from "@features/keep/deletion-upload-exclusions";
import { normalizeMergeAction } from "@features/keep/domain/merge-action";
import { renderMergeActionSelector } from "./merge-action-selector";
import { parseCustomScopeRange, renderCustomScopeInputs } from "./sync-date-range";
import { deletionReviewSummary, markDeletionConflict, retainUncheckedDeletions } from "./deletion-review";
import { chooseLegacyTags } from "@features/keep/enrichment/consent";
import { renderLegacyTagChoice } from "./legacy-tag-choice";

interface CreateElOptions { text?: string; cls?: string | string[]; }
type MaybeObsidianElement = HTMLElement & { empty?: () => void; setText?: (text: string) => void; };
interface TwoWayGateState { allowed: boolean; reasons: string[]; }
interface SyncProgressModalOptions {
	createSyncAttempt?: (mode: SyncMode) => SyncAttempt;
	getLastAttempt?: () => LastSyncAttempt | undefined;
	buildSyncPlan: (mode: SyncMode, callbacks?: SyncPlanBuildCallbacks, downloadScope?: DownloadScope) => Promise<PreparedSyncPlan | null>;
	runSyncPlan: (preparedPlan: PreparedSyncPlan, callbacks?: SyncPlanRunCallbacks) => Promise<RunPreparedSyncPlanResult>;
	requestCancelSync?: () => boolean | void;
	onOpenSyncLog: () => void | Promise<void>;
	onClose?: (state: { activeRun: boolean }) => void;
	getTwoWayGate: () => TwoWayGateState;
	getLastSuccessfulDownloadDate: () => string | undefined;
	openTwoWaySettings: () => void;
	getCurrentMode: () => SyncMode | null;
	getCurrentPhaseLabel: () => string | null;
	isSupporterActive: () => Promise<boolean>;
	renderImportOptions: (containerEl: HTMLElement, isActive: boolean) => void | Promise<void>;
}
type ModalSurface = "setup" | "review" | "running" | "result";
type ChipKey = "notes" | "create" | "delete" | "merge" | "overwrite" | "upload" | "conflict-copy" | "skipped-conflict" | "already-up-to-date" | "unchecked";
type EntryRunState = "pending" | "done" | "failed" | "unchecked" | "instant";
interface ExecutionSnapshot { plan: SyncPlan; entryStates: Map<string, EntryRunState>; }
interface ExecutionRowRefs { row: HTMLDivElement; statusSymbolEl: HTMLSpanElement; badgeEl: HTMLSpanElement; }
interface ChipRenderState { key: ChipKey; label: string; numerator?: number; denominator?: number; count?: number; isActive: boolean; }
interface ModalAlertState { title: () => string; message: () => string; }
interface DismissPromptState { activeRun: boolean; }
const CHIP_ORDER: ChipKey[] = ["notes", "create", "delete", "merge", "overwrite", "upload", "conflict-copy", "skipped-conflict", "already-up-to-date", "unchecked"];
const clearElement = (element: HTMLElement) => {
	const maybeObsidianElement = element as MaybeObsidianElement;
	if (typeof maybeObsidianElement.empty === "function") { maybeObsidianElement.empty(); return; }
	element.innerHTML = "";
};
const createChild = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tagName: K, options?: CreateElOptions): HTMLElementTagNameMap[K] => parent.createEl(tagName, options);

function modeLabel(mode: SyncMode): string {
	switch (mode) { case "push": return t("sync.mode.upload"); case "two-way": return t("sync.mode.twoWay"); default: return t("sync.mode.download"); }
}
function modeUsesDownload(mode: SyncMode): boolean { return mode !== "push"; }
function modeRequiresTwoWayGate(mode: SyncMode): boolean { return mode === "push" || mode === "two-way"; }
function reviewContinuationLabel(prepared: PreparedSyncPlan | null): string | undefined {
	if (!prepared) return undefined;
	// An unchecked upload review still settles the attempt and its download
	// receipts through the normal runner, including conflict/checkpoint guards.
	if (prepared.stage === "upload") return t("sync.completeReview");
	if (prepared.stage !== "import") return undefined;
	// The upload review is still required when the download stage has no selected
	// writes, including when missing tracked identities were protected from import.
	if (prepared.mode === "two-way") return t("sync.continueUpload");
	// Identical downloads still carry server receipts that can establish tracking.
	// Keep entirely deselected actionable plans disabled.
	if (prepared.mode === "import" && (prepared.importNotes?.length ?? 0) > 0 &&
		prepared.plan.entries.length > 0 && prepared.plan.entries.every((entry) => !entry.selectable && entry.action === "skipped-identical")) {
		return t("sync.completeReview");
	}
	return undefined;
}
function formatGeneratedAt(timestamp: number): string {
	try { return new Date(timestamp).toLocaleString(); } catch { return new Date(timestamp).toISOString(); }
}
function formatScopeTimestamp(isoString: string): string {
	try { return new Date(isoString).toLocaleString(); } catch { return isoString; }
}

function toCustomScopeInputValue(isoString: string): string {
	const parsed = new Date(isoString);
	if (Number.isNaN(parsed.getTime())) return "";
	const offsetMs = parsed.getTimezoneOffset() * 60_000;
	return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16).replace("T", " ");
}

function clonePlan(plan: SyncPlan): SyncPlan {
	return { ...plan, counts: { ...plan.counts }, entries: plan.entries.map((entry) => ({ ...entry, meta: entry.meta ? { ...entry.meta } : undefined })) };
}
function getChipKeyForEntry(entry: SyncPlanEntry): ChipKey {
	switch (entry.action) {
		case "create": return "create";
		case "delete": return "delete";
		case "merge": return "merge";
		case "overwrite": return "overwrite";
		case "upload": return "upload";
		case "conflict-copy": case "skipped-conflict-copy": return "conflict-copy";
		case "skipped-conflict": return "skipped-conflict";
		default: return "already-up-to-date";
	}
}
function getReviewChipLabel(key: ChipKey): string {
	switch (key) {
		case "notes": return t("common.notes");
		case "create": return t("sync.action.create");
		case "delete": return t("sync.action.delete");
		case "merge": return t("sync.action.merge");
		case "overwrite": return t("sync.action.overwrite");
		case "upload": return t("sync.mode.upload");
		case "conflict-copy": return t("sync.action.conflictCopy");
		case "skipped-conflict": return t("sync.action.skippedConflict");
		case "already-up-to-date": return t("sync.action.upToDate");
		case "unchecked": return t("sync.action.unchecked");
	}
}
function getExecutionChipLabel(key: ChipKey): string {
	switch (key) {
		case "create": return t("sync.created");
		case "delete": return t("sync.deleted");
		case "merge": return t("sync.merged");
		case "overwrite": return t("sync.overwritten");
		case "upload": return t("sync.uploaded");
		default: return getReviewChipLabel(key);
	}
}
function getReviewEntryLabel(entry: SyncPlanEntry): string {
	if (entry.label === "Delete from Obsidian") return t("deletion.fromObsidian");
	if (entry.label === "Preserved local removal") return t("deletion.preserved");
	if (entry.label === "No longer in sync folder") return t("deletion.removed");
	if (entry.label === "Archive") return t("sync.action.archive");
	if (entry.label === "Add tags") return t("sync.action.addTags");
	if (entry.label === "Update suggestions") return t("sync.action.updateSuggestions");
	if (entry.label === "Removal not verified") return t("sync.action.unverifiedRemoval");
	if (entry.label === "Deletion conflict") return t("sync.deletionConflict");
	if (entry.action === "skipped-conflict-copy") return t("sync.action.skippedConflictCopy");
	if (entry.label === "Skipped: conflict") return t("sync.action.skippedConflict");
	if (entry.label === "Skipped: identical" || entry.label === "Skipped: up to date") return t("sync.action.upToDate");
	return localizePluginLabel(entry.label);
}
function getFriendlySyncCenterError(error: unknown, context: "review" | "run"): ModalAlertState {
	const rawMessage = error instanceof Error && error.message ? error.message : typeof error === "string" ? error : "Unknown error";
	const normalizedMessage = rawMessage.toLowerCase();
	const looksLikeConnectionProblem = ["err_connection_refused", "failed to fetch", "networkerror", "network error", "econnrefused", "enotfound", "timed out", "etimedout"].some((message) => normalizedMessage.includes(message));
	if (looksLikeConnectionProblem) return {
		title: () => context === "review" ? t("sync.error.prepareTitle") : t("sync.error.runTitle"),
		message: () => t("sync.error.connection"),
	};
	return { title: () => context === "review" ? t("sync.error.prepareTitle") : t("sync.error.runTitle"), message: () => t("sync.error.generic") };
}
function getSetupPrimaryButtonLabel(isGeneratingReview: boolean, processed: number, total?: number): string {
	if (!isGeneratingReview) return t("sync.start");
	if (typeof total === "number" && total > 0 && processed >= total) return t("sync.downloadedWaiting");
	return t("sync.preparing");
}
function getPlanTitle(plan: SyncPlan): string { return plan.stage === "upload" ? t("sync.reviewUpload") : t("sync.reviewDownload"); }
function getRunningTitle(plan: SyncPlan): string { return plan.stage === "upload" ? t("sync.runningUpload") : t("sync.runningDownload"); }
function getResultTitle(plan: SyncPlan, status: SyncRunStatus | null): string {
	if (status === "canceled") return plan.stage === "upload" ? t("sync.uploadCanceled") : t("sync.downloadCanceled");
	if (status === "failed") return plan.stage === "upload" ? t("sync.uploadFailed") : t("sync.downloadFailed");
	if (status === "warning") return plan.stage === "upload" ? t("sync.uploadWarnings") : t("sync.downloadWarnings");
	return plan.stage === "upload" ? t("sync.uploadDone") : t("sync.downloadDone");
}
function getRuntimeStatusLabel(entry: SyncPlanEntry, state: EntryRunState): string {
	if (state === "unchecked") return t("sync.action.unchecked");
	if (state === "failed") return entry.action === "skipped-conflict" && entry.label === "Deletion conflict" ? t("sync.deletionConflict") : t("common.failed");
	if (state === "pending") return t("common.pending");
	if (state === "instant" || (entry.action === "overwrite" && ["Archive", "Add tags", "Update suggestions"].includes(entry.label))) return getReviewEntryLabel(entry);
	return getExecutionChipLabel(getChipKeyForEntry(entry));
}
function isInstantEntry(entry: SyncPlanEntry): boolean {
	// A selected conflict copy performs I/O and must wait for its settlement callback.
	return !entry.selectable;
}

export class SyncProgressModal extends Modal {
	private options: SyncProgressModalOptions;
	private selectedMode: SyncMode = "import";
	private downloadScopeKind: DownloadScopeKind = "last-sync";
	private legacyTags = false;
	private customSinceInput = "";
	private customUntilInput = "";
	private showSyncOptions = false;
	private isSyncing = false;
	private isCanceling = false;
	private isGeneratingReview = false;
	private preparationPaused = false;
	private processed = 0;
	private total: number | undefined;
	private lastResult: { status: SyncRunStatus; processed: number; attachmentWarnings: number } | null = null;
	private summary: LastSyncSummary | null = null;
	private preparedPlan: PreparedSyncPlan | null = null;
	private activeAttempt: SyncAttempt | null = null;
	private reviewGeneration = 0;
	private executionSnapshot: ExecutionSnapshot | null = null;
	private showExecutionResult = false;
	private reviewFilterKey: ChipKey = "notes";
	private planBuildProcessed = 0;
	private planBuildTotal: number | undefined;
	private modalAlert: ModalAlertState | null = null;
	private dismissPrompt: DismissPromptState | null = null;
	private renderVersion = 0;
	private modalTitleEl: HTMLHeadingElement | null = null;
	private stepperEl: HTMLDivElement | null = null;
	private headerMetaEl: HTMLDivElement | null = null;
	private statusEl: HTMLDivElement | null = null;
	private statusActionsEl: HTMLDivElement | null = null;
	private alertHostEl: HTMLDivElement | null = null;
	private bodyEl: HTMLDivElement | null = null;
	private footerEl: HTMLDivElement | null = null;
	private planActionsEl: HTMLDivElement | null = null;
	private planPanelEl: HTMLDivElement | null = null;
	private planSummaryEl: HTMLDivElement | null = null;
	private planSelectionSummaryEl: HTMLDivElement | null = null;
	private planListEl: HTMLDivElement | null = null;
	private executionRowRefs = new Map<string, ExecutionRowRefs>();
	private chromeCloseButtonEl: HTMLElement | null = null;
	private dismissPromptActionsEl: HTMLDivElement | null = null;
	private allowBackgroundClose = false;
	private returnFocusEl: HTMLElement | null = null;
	private readonly handleDialogKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Tab") return;
		const controls = Array.from(this.modalEl.querySelectorAll<HTMLElement>(
			"button, input, select, textarea, a[href], [tabindex]"
		)).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") &&
			element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
		const active = document.activeElement;
		const first = controls[0], last = controls[controls.length - 1];
		if (!first) { event.preventDefault(); this.modalTitleEl?.focus(); return; }
		if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
			event.preventDefault(); last.focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault(); first.focus();
		}
	};
	private readonly handleChromeCloseClick = (event: Event) => {
		if (!this.isSyncing) return;
		event.preventDefault();
		if ("stopImmediatePropagation" in event) event.stopImmediatePropagation();
		event.stopPropagation();
		this.requestSyncCancellation();
	};
	private readonly handleContainerPointerDown = (event: PointerEvent) => {
		if (!this.isBackdropInteraction(event.target)) return;
		event.preventDefault();
		if ("stopImmediatePropagation" in event) event.stopImmediatePropagation();
		event.stopPropagation();
		this.showDismissPrompt();
	};
	constructor(app: App, options: SyncProgressModalOptions) { super(app); this.options = options; }
	refreshLanguage() { void this.refreshUI(); }
	onOpen() {
		if (!this.returnFocusEl?.isConnected) {
			this.returnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		}
		this.bindChromeCloseButton(); this.bindBackdropDismissGuard();
		this.modalEl.addEventListener("keydown", this.handleDialogKeyDown);
		void this.refreshUI();
		this.modalTitleEl?.focus();
	}
	onClose() {
		const activeRun = this.isSyncing;
		if (this.allowBackgroundClose) {
			this.allowBackgroundClose = false;
			this.dismissPrompt = null;
			this.unbindChromeCloseButton();
			this.unbindBackdropDismissGuard();
			this.clearLayout();
			this.restoreOpeningFocus();
			this.options.onClose?.({ activeRun });
			return;
		}
		if (activeRun) {
			this.requestSyncCancellation();
			this.options.onClose?.({ activeRun });
			this.open();
			void this.refreshUI();
			return;
		}
		this.reviewGeneration += 1;
		this.isGeneratingReview = false;
		void this.activeAttempt?.finish("abandoned");
		this.preparedPlan = null;
		this.unbindChromeCloseButton();
		this.unbindBackdropDismissGuard();
		this.dismissPrompt = null;
		this.clearLayout();
		this.restoreOpeningFocus();
		this.options.onClose?.({ activeRun });
	}
	private restoreOpeningFocus() {
		this.modalEl.removeEventListener("keydown", this.handleDialogKeyDown);
		if (this.returnFocusEl?.isConnected) this.returnFocusEl.focus();
		this.returnFocusEl = null;
	}
	private clearLayout() {
		clearElement(this.contentEl);
		this.modalTitleEl = null; this.stepperEl = null; this.headerMetaEl = null;
		this.statusEl = null; this.statusActionsEl = null; this.alertHostEl = null;
		this.bodyEl = null; this.footerEl = null; this.planActionsEl = null;
		this.planPanelEl = null; this.planSummaryEl = null; this.planSelectionSummaryEl = null;
		this.planListEl = null; this.chromeCloseButtonEl = null; this.dismissPromptActionsEl = null;
	}
	private bindChromeCloseButton() {
		const closeButton = this.modalEl.querySelector(".modal-close-button");
		if (closeButton === this.chromeCloseButtonEl) { this.syncChromeCloseButtonState(); return; }
		this.unbindChromeCloseButton();
		if (!(closeButton instanceof HTMLElement)) return;
		closeButton.addEventListener("click", this.handleChromeCloseClick, true);
		this.chromeCloseButtonEl = closeButton;
		this.syncChromeCloseButtonState();
	}
	private bindBackdropDismissGuard() { this.unbindBackdropDismissGuard(); this.containerEl.addEventListener("pointerdown", this.handleContainerPointerDown, true); }
	private unbindBackdropDismissGuard() { this.containerEl.removeEventListener("pointerdown", this.handleContainerPointerDown, true); }
	private isBackdropInteraction(target: EventTarget | null): boolean { return target instanceof Node && !this.modalEl.contains(target); }
	private unbindChromeCloseButton() {
		if (!this.chromeCloseButtonEl) return;
		this.chromeCloseButtonEl.removeEventListener("click", this.handleChromeCloseClick, true);
		if (this.chromeCloseButtonEl.instanceOf(HTMLButtonElement)) this.chromeCloseButtonEl.disabled = false;
		this.chromeCloseButtonEl.classList.remove("is-disabled");
		this.chromeCloseButtonEl = null;
	}
	private syncChromeCloseButtonState() {
		if (!this.chromeCloseButtonEl) return;
		if (this.chromeCloseButtonEl.instanceOf(HTMLButtonElement)) this.chromeCloseButtonEl.disabled = this.isCanceling;
		this.chromeCloseButtonEl.classList.toggle("is-disabled", this.isCanceling);
	}
	private requestSyncCancellation(): boolean {
		if (!this.isSyncing) return false;
		if (this.isCanceling) return true;
		if (this.options.requestCancelSync?.() === false) return false;
		this.isCanceling = true;
		this.modalAlert = null;
		this.syncChromeCloseButtonState();
		void this.refreshUI();
		return true;
	}
	private showDismissPrompt() { this.dismissPrompt = { activeRun: this.isSyncing }; this.modalAlert = null; void this.refreshUI(); }
	private async dismissToBackground() {
		if (!this.isSyncing) return;
		this.allowBackgroundClose = true; this.dismissPrompt = null; this.close();
	}
	private async confirmDismiss() { this.dismissPrompt = null; this.close(); }
	setSelectedMode(mode: SyncMode) {
		if (this.selectedMode === mode || this.isSyncing) return;
		this.reviewGeneration += 1; this.isGeneratingReview = false;
		void this.activeAttempt?.finish("abandoned");
		this.selectedMode = mode; this.preparationPaused = false; this.preparedPlan = null;
		this.legacyTags = false;
		this.executionSnapshot = null; this.showExecutionResult = false; this.reviewFilterKey = "notes";
		this.modalAlert = null; this.dismissPrompt = null;
		void this.refreshUI();
	}
	private getLastSuccessfulDownloadDate(): string | undefined { return this.options.getLastSuccessfulDownloadDate(); }
	private setDownloadScopeKind(kind: DownloadScopeKind) {
		this.preparationPaused = false;
		if (this.downloadScopeKind === kind) return;
		this.downloadScopeKind = kind; this.modalAlert = null; this.dismissPrompt = null;
		if (kind === "custom-since" && !this.customSinceInput) {
			const lastSuccessfulDownloadDate = this.getLastSuccessfulDownloadDate();
			if (lastSuccessfulDownloadDate) this.customSinceInput = toCustomScopeInputValue(lastSuccessfulDownloadDate);
		}
		void this.refreshUI();
	}
	private getDownloadScope(): DownloadScope {
		if (this.downloadScopeKind === "all") return { kind: "all" };
		if (this.downloadScopeKind === "custom-since") {
			const parsed = parseCustomScopeRange(this.customSinceInput, this.customUntilInput);
			const error = parsed.startError ?? parsed.endError;
			if (error) {
				throw new Error(error);
			}
			return parsed.scope;
		}
		return { kind: "last-sync" };
	}
	private getCustomScopeError(): string | null {
		if (this.downloadScopeKind !== "custom-since") {
			return null;
		}
		const parsed = parseCustomScopeRange(this.customSinceInput, this.customUntilInput);
		return parsed.startError ?? parsed.endError ?? null;
	}
	async beginReview(mode = this.selectedMode, retainedMergeAction?: MergeAction) {
		if (this.isSyncing || this.isGeneratingReview) return;
		this.selectedMode = mode; this.isGeneratingReview = true;
		const generation = ++this.reviewGeneration;
		const previousAttempt = this.activeAttempt;
		let attempt = this.options.createSyncAttempt?.(mode) ?? null;
		this.activeAttempt = attempt; this.preparedPlan = null; this.executionSnapshot = null;
		this.showExecutionResult = false; this.lastResult = null; this.planBuildProcessed = 0;
		this.planBuildTotal = undefined; this.reviewFilterKey = "notes"; this.modalAlert = null; this.dismissPrompt = null;
		try {
			if (attempt) await attempt.start();
			if (previousAttempt) await previousAttempt.finish("abandoned");
			await this.refreshUI();
			if (generation !== this.reviewGeneration) return;
			const downloadScope = modeUsesDownload(mode) ? this.getDownloadScope() : undefined;
			const legacyTagConsent = modeUsesDownload(mode) && this.legacyTags ? chooseLegacyTags() : undefined;
			this.legacyTags = false;
			const preparedPlan = await this.options.buildSyncPlan(mode, {
				legacyTagConsent,
				attempt: attempt ?? undefined,
				onAttempt: (context) => {
					attempt = context;
					if (generation !== this.reviewGeneration) { void context.finish("abandoned"); return; }
					this.activeAttempt = context;
				},
				setTotalNotes: (total) => {
					if (generation !== this.reviewGeneration) return;
					this.planBuildTotal = total; void this.refreshUI();
				},
				reportPlanProgress: (processed, total) => {
					if (generation !== this.reviewGeneration) return;
					this.planBuildProcessed = processed;
					if (typeof total === "number" && total > 0) this.planBuildTotal = total;
					void this.refreshUI();
				},
			}, downloadScope);
			if (generation !== this.reviewGeneration) return;
			if (preparedPlan && !attempt?.finished) {
				preparedPlan.plan.title = getPlanTitle(preparedPlan.plan);
				preparedPlan.plan.mergeAction = normalizeMergeAction(retainedMergeAction ?? preparedPlan.plan.mergeAction);
				this.preparedPlan = preparedPlan; this.activeAttempt = preparedPlan.attempt ?? attempt;
			}
		} catch (error) {
			if (attempt) await attempt.fail(error);
			if (generation === this.reviewGeneration) this.showAttemptError(error, "review", attempt);
		} finally {
			if (generation === this.reviewGeneration) { this.isGeneratingReview = false; await this.refreshUI(); }
		}
	}
	private showAttemptError(error: unknown, context: "review" | "run", attempt = this.activeAttempt) {
		this.preparationPaused = false;
		if (context === "review" && error && typeof error === "object" && "code" in error && error.code === "sync_session_expired") {
			this.modalAlert = { title: () => t("sync.expired"), message: () => t("sync.restartRange") };
			return;
		}
		if (context === "review" && error instanceof Error && error.message.startsWith("Download paused.")) {
			this.preparationPaused = true;
			this.modalAlert = { title: () => t("sync.paused"), message: () => `${error.message}${attempt ? ` ${attempt.errorMessage(error)}` : ""}` };
			return;
		}
		this.modalAlert = attempt ? {
			title: () => context === "review" ? t("sync.preparationFailed",{mode:modeLabel(this.selectedMode)}) : t("sync.modeFailed",{mode:modeLabel(this.selectedMode)}),
			message: () => attempt.errorMessage(error),
		} : getFriendlySyncCenterError(error, context);
	}
	private async runReviewedPlan() {
		if (!this.preparedPlan || this.isSyncing || this.isGeneratingReview) return;
		this.initializeExecutionSnapshot(this.preparedPlan.plan);
		this.isSyncing = true; this.isCanceling = false; this.syncChromeCloseButtonState();
		this.showExecutionResult = false; this.modalAlert = null; this.dismissPrompt = null;
		await this.refreshUI();
		try {
			const result = await this.options.runSyncPlan(this.preparedPlan, {
				onEntrySaved: (entryId, path) => this.handleEntrySaved(entryId, path),
				onEntrySettled: (entryId, success, outcome) => this.handleEntrySettled(entryId, success, outcome),
			});
			if (result.nextPlan) {
				result.nextPlan.deletions = this.preparedPlan.deletions;
				result.nextPlan.plan = excludeDeletionUploads(result.nextPlan.plan, result.nextPlan.deletions);
				result.nextPlan.plan.title = getPlanTitle(result.nextPlan.plan);
				result.nextPlan.plan.mergeAction = normalizeMergeAction(result.nextPlan.plan.mergeAction ?? this.preparedPlan.plan.mergeAction);
				this.preparedPlan = result.nextPlan;
				this.activeAttempt = result.nextPlan.attempt ?? this.activeAttempt;
				this.executionSnapshot = null; this.showExecutionResult = false; this.reviewFilterKey = "notes";
				return;
			}
			if (result.failed) this.showAttemptError(undefined, "run");
			this.preparedPlan = null; this.showExecutionResult = !result.canceled;
		} catch (error) {
			await this.activeAttempt?.fail(error);
			this.showAttemptError(error, "run"); this.showExecutionResult = false;
		} finally {
			this.isSyncing = false; this.isCanceling = false; this.syncChromeCloseButtonState(); await this.refreshUI();
		}
	}
	setProgress(processed: number, total?: number) {
		this.processed = processed; this.total = total; this.summary = null; this.lastResult = null; this.modalAlert = null; this.dismissPrompt = null;
		if (this.getSurface() !== "running") void this.refreshUI();
	}
	setComplete(status: SyncRunStatus | boolean, processed: number, attachmentWarnings = 0) {
		const normalizedStatus = typeof status === "boolean" ? (status ? "success" : "failed") : status;
		this.lastResult = { status: normalizedStatus, processed, attachmentWarnings };
		if (this.executionSnapshot) this.showExecutionResult = normalizedStatus !== "canceled";
		if (normalizedStatus !== "failed") this.modalAlert = null;
		this.dismissPrompt = null; void this.refreshUI();
	}
	setIdleSummary(summary: LastSyncSummary | null) {
		this.summary = summary;
		if (!this.showExecutionResult) this.lastResult = null;
		const summaryStatus = summary == null ? null : (summary.status ?? (summary.success ? "success" : "failed"));
		if (summaryStatus !== "failed") this.modalAlert = null;
		this.dismissPrompt = null; void this.refreshUI();
	}
	private initializeExecutionSnapshot(plan: SyncPlan) {
		const snapshotPlan = clonePlan(plan), entryStates = new Map<string, EntryRunState>();
		for (const entry of snapshotPlan.entries) {
			if (entry.selectable && !entry.selected) entryStates.set(entry.id, "unchecked");
			else if (isInstantEntry(entry)) entryStates.set(entry.id, "instant");
			else entryStates.set(entry.id, "pending");
		}
		this.executionSnapshot = { plan: snapshotPlan, entryStates }; this.reviewFilterKey = "notes";
	}
	private handleEntrySaved(entryId: string, path: string) {
		const entry = this.executionSnapshot?.plan.entries.find((candidate) => candidate.id === entryId);
		if (!entry || !entry.selected || !entry.selectable) return;
		entry.path = path;
		entry.title = path.split("/").pop()?.replace(/\.md$/i, "") ?? entry.title;
		if (entry.meta?.detail === "New AI suggestions are requested only for selected notes.") {
			delete entry.meta.detail;
			delete entry.meta.downloadDetails;
		}
		this.updateExecutionRowInPlace(entryId);
	}
	private handleEntrySettled(entryId: string, success: boolean, outcome?: SyncPlanAction) {
		if (!this.executionSnapshot) return;
		const current = this.executionSnapshot.entryStates.get(entryId);
		if (!current || current === "unchecked" || current === "instant") return;
		this.executionSnapshot.entryStates.set(entryId, success ? "done" : "failed");
		const entry = this.executionSnapshot.plan.entries.find((candidate) => candidate.id === entryId);
		if (!success && outcome === "skipped-conflict" && entry?.action === "delete") {
			markDeletionConflict(entry);
			void this.refreshUI();
			return;
		}
		if (success && outcome && entry && entry.action !== outcome) {
			entry.action = outcome;
			void this.refreshUI();
			return;
		}
		if (this.canRefreshRunningInPlace(entryId)) { this.refreshRunningExecutionUi(entryId); return; }
		void this.refreshUI();
	}
	private canRefreshRunningInPlace(entryId?: string): boolean {
		if (this.getSurface() !== "running" || !this.executionSnapshot || !this.statusEl || !this.stepperEl || !this.planSummaryEl || !this.planListEl) return false;
		if (this.reviewFilterKey === "unchecked") return false;
		if (entryId && this.reviewFilterKey !== "notes") {
			const entry = this.executionSnapshot.plan.entries.find((candidate) => candidate.id === entryId);
			if (!entry || getChipKeyForEntry(entry) !== this.reviewFilterKey) return false;
		}
		return true;
	}
	private refreshRunningExecutionUi(entryId?: string) {
		if (!this.executionSnapshot || !this.statusEl || !this.stepperEl || !this.planSummaryEl) return;
		this.statusEl.textContent = this.getStatusCopy("running"); this.renderStepper(this.stepperEl, "running"); this.renderRunningSummary();
		if (entryId) this.updateExecutionRowInPlace(entryId);
	}
	private ensureLayout() {
		if (this.modalTitleEl && this.stepperEl && this.headerMetaEl && this.statusEl && this.statusActionsEl && this.alertHostEl && this.bodyEl && this.footerEl) return;
		clearElement(this.contentEl); this.contentEl.className = "keepsidian-modal";
		this.modalTitleEl = createChild(this.contentEl, "h2"); this.modalTitleEl.classList.add("keepsidian-modal-title");
		this.modalTitleEl.tabIndex = -1;
		this.modalEl.setAttribute("role", "dialog");
		this.modalEl.setAttribute("aria-modal", "true");
		this.stepperEl = createChild(this.contentEl, "div");
		this.headerMetaEl = createChild(this.contentEl, "div"); this.headerMetaEl.classList.add("keepsidian-modal-header-meta");
		this.statusEl = createChild(this.headerMetaEl, "div"); this.statusEl.classList.add("keepsidian-modal-status"); this.statusEl.setAttribute("aria-live", "polite");
		this.statusActionsEl = createChild(this.headerMetaEl, "div"); this.statusActionsEl.classList.add("keepsidian-modal-status-actions");
		this.alertHostEl = createChild(this.contentEl, "div"); this.bodyEl = createChild(this.contentEl, "div"); this.footerEl = createChild(this.contentEl, "div");
	}
	private getSurface(): ModalSurface {
		if (this.isSyncing && this.executionSnapshot) return "running";
		if (this.preparedPlan) return "review";
		if (this.executionSnapshot && this.showExecutionResult) return "result";
		return "setup";
	}
	private async refreshUI() {
		const focused = document.activeElement;
		const hadFocus = !!focused && this.modalEl.contains(focused);
		const focusKey = hadFocus ? focused?.getAttribute("data-keepsidian-focus") : null;
		const restoreFocus = () => {
			if (!hadFocus || focused?.isConnected || document.activeElement !== document.body) return;
			const replacement = focusKey ? Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-keepsidian-focus]"))
				.find((element) => element.getAttribute("data-keepsidian-focus") === focusKey) : null;
			(replacement ?? this.modalTitleEl)?.focus();
		};
		const renderVersion = ++this.renderVersion, surface = this.getSurface();
		this.ensureLayout(); this.bindChromeCloseButton(); this.syncChromeCloseButtonState();
		if (surface !== "running") this.executionRowRefs.clear();
		this.contentEl.className = "keepsidian-modal";
		this.contentEl.classList.add(surface === "setup" ? "keepsidian-modal--compact" : "keepsidian-modal--plan");
		this.modalEl.classList.remove("keepsidian-modal-shell--compact", "keepsidian-modal-shell--plan");
		this.modalEl.classList.add(surface === "setup" ? "keepsidian-modal-shell--compact" : "keepsidian-modal-shell--plan");
		if (this.modalTitleEl) this.modalTitleEl.textContent = this.getTitle(surface);
		this.modalEl.setAttribute("aria-label", this.getTitle(surface));
		this.modalEl.lang = getUiTranslator().locale;
		if (this.stepperEl) this.renderStepper(this.stepperEl, surface);
		if (this.statusEl) this.statusEl.textContent = this.getStatusCopy(surface);
		if (this.statusActionsEl) {
			clearElement(this.statusActionsEl);
			if (surface === "running") {
				const cancelButton = this.createActionButton(this.statusActionsEl, this.isCanceling ? t("sync.canceling") : t("common.cancel"), async () => { this.requestSyncCancellation(); });
				cancelButton.classList.add("keepsidian-modal-inline-action", "keepsidian-modal-inline-action--cancel"); cancelButton.disabled = this.isCanceling;
			}
		}
		if (this.alertHostEl) {
			clearElement(this.alertHostEl);
			if (this.modalAlert) this.renderAlert(this.alertHostEl, this.modalAlert);
			if (this.dismissPrompt) this.renderDismissPrompt(this.alertHostEl, this.dismissPrompt);
		}
		if (surface === "setup") {
			this.planActionsEl = null; this.planPanelEl = null; this.planSummaryEl = null; this.planSelectionSummaryEl = null; this.planListEl = null;
			if (this.footerEl) clearElement(this.footerEl);
			await this.renderSetupSurface(renderVersion);
			if (renderVersion === this.renderVersion) restoreFocus();
			return;
		}
		this.renderPlanSurface(surface);
		restoreFocus();
	}
	private renderAlert(containerEl: HTMLElement, alert: ModalAlertState) {
		const alertEl = createChild(containerEl, "div"); alertEl.classList.add("keepsidian-modal-alert"); alertEl.setAttribute("role", "alert");
		createChild(alertEl, "div", { text: alert.title() }).classList.add("keepsidian-modal-alert-title");
		createChild(alertEl, "div", { text: alert.message() }).classList.add("keepsidian-modal-alert-message");
	}
	private renderDismissPrompt(containerEl: HTMLElement, prompt: DismissPromptState) {
		const promptEl = createChild(containerEl, "div"); promptEl.classList.add("keepsidian-modal-dismiss-prompt");
		createChild(promptEl, "div", { text: prompt.activeRun ? t("sync.leaveRunning") : t("sync.closeQuestion") }).classList.add("keepsidian-modal-dismiss-prompt-title");
		createChild(promptEl, "div", { text: prompt.activeRun
			? t("sync.dismissRunning")
			: t("sync.dismissIdle") }).classList.add("keepsidian-modal-dismiss-prompt-message");
		this.dismissPromptActionsEl = createChild(promptEl, "div"); this.dismissPromptActionsEl.classList.add("keepsidian-modal-dismiss-prompt-actions");
		if (prompt.activeRun) {
			const cancelButton = this.createActionButton(this.dismissPromptActionsEl, this.isCanceling ? t("sync.canceling") : t("sync.cancel"), async () => { this.dismissPrompt = null; this.requestSyncCancellation(); });
			cancelButton.classList.add("keepsidian-modal-dismiss-prompt-action--danger"); cancelButton.disabled = this.isCanceling;
			this.createActionButton(this.dismissPromptActionsEl, t("sync.background"), async () => { await this.dismissToBackground(); }).classList.add("keepsidian-modal-dismiss-prompt-action--ghost");
		} else {
			this.createActionButton(this.dismissPromptActionsEl, t("common.close"), async () => { await this.confirmDismiss(); }).classList.add("keepsidian-modal-dismiss-prompt-action--danger");
		}
		this.createActionButton(this.dismissPromptActionsEl, t("common.back"), async () => { this.dismissPrompt = null; await this.refreshUI(); }).classList.add("keepsidian-modal-dismiss-prompt-action--ghost");
	}
	private getTitle(surface: ModalSurface): string {
		if (surface === "setup") return t("sync.center");
		const plan = this.preparedPlan?.plan ?? this.executionSnapshot?.plan;
		if (!plan) return t("sync.plan");
		if (surface === "review") return getPlanTitle(plan);
		if (surface === "running") return getRunningTitle(plan);
		return getResultTitle(plan, this.lastResult?.status ?? null);
	}
	private getStatusCopy(surface: ModalSurface): string {
		if (surface === "setup") {
			if (this.isGeneratingReview) {
				if (typeof this.planBuildTotal === "number" && this.planBuildTotal > 0) return t("sync.prepared", {processed:this.planBuildProcessed,total:this.planBuildTotal});
				return t("sync.preparing");
			}
			if (this.isSyncing) {
				const phase = this.options.getCurrentPhaseLabel();
				const phaseLabel = phase === "Download step" ? t("sync.downloadStep") : phase === "Upload step" ? t("sync.uploadStep") : modeLabel(this.selectedMode);
				return t("sync.countProgress", { label: this.isCanceling ? t("sync.canceling") : phaseLabel, processed: this.processed, total: this.total ?? "?" });
			}
			const lastAttempt = this.options.getLastAttempt?.();
			if (lastAttempt && (!this.summary || lastAttempt.updatedAt >= this.summary.timestamp)) return formatAttemptSummary(lastAttempt);
			if (this.summary) return formatModalSummary(this.summary);
			return t("sync.setupDescription");
		}
		if (surface === "review" && this.preparedPlan) return t("sync.generated", {time:formatGeneratedAt(this.preparedPlan.plan.generatedAt)});
		if ((surface === "running" || surface === "result") && this.executionSnapshot) {
			const selectedCount = this.executionSnapshot.plan.entries.filter((entry) => entry.selectable && entry.selected).length;
			const pendingCount = Math.max(0, selectedCount - this.getExecutionHandledCount());
			if (surface === "running") return this.isCanceling ? t("sync.canceling") : t("sync.selectedPending", {selected:selectedCount,pending:pendingCount});
			if (this.summary) return formatModalSummary(this.summary);
			if (this.lastResult?.status === "canceled") return t("sync.result", {status:t("sync.canceled"),notes:t("sync.notes",{count:this.lastResult.processed})});
			if (this.lastResult?.status === "warning") {
				const warningCount = this.lastResult.attachmentWarnings;
				return t("sync.warningResult", {warnings:t("sync.attachmentWarnings",{count:warningCount}),notes:t("sync.notes",{count:this.lastResult.processed})});
			}
			return this.lastResult?.status === "success" ? t("sync.result", {status:t("sync.success"),notes:t("sync.notes",{count:this.lastResult.processed})}) : t("sync.failedSentence");
		}
		return "";
	}
	private renderStepper(containerEl: HTMLElement, surface: ModalSurface) {
		clearElement(containerEl); containerEl.className = "keepsidian-sync-stepper";
		const firstProgress = this.getStartStepProgress(surface), secondProgress = this.getReviewStepProgress(surface);
		const isReviewReached = surface === "review" || surface === "running" || surface === "result", isDoneReached = surface === "result";
		const steps: Array<{ label: string; state: "pending" | "active" | "complete" }> = [
			{ label: t("common.start"), state: surface === "setup" && !isReviewReached ? "active" : "complete" },
			{ label: t("common.review"), state: surface === "review" || surface === "running" ? "active" : isDoneReached ? "complete" : "pending" },
			{ label: t("common.done"), state: isDoneReached ? "active" : "pending" },
		];
		steps.forEach((step, index) => {
			const stepEl = createChild(containerEl, "div"); stepEl.classList.add("keepsidian-sync-stepper-step", `is-${step.state}`);
			createChild(stepEl, "div").classList.add("keepsidian-sync-stepper-node");
			createChild(stepEl, "div", { text: step.label }).classList.add("keepsidian-sync-stepper-label");
			if (index < steps.length - 1) {
				const connectorEl = createChild(containerEl, "div"); connectorEl.classList.add("keepsidian-sync-stepper-connector");
				const fillEl = createChild(connectorEl, "div"); fillEl.classList.add("keepsidian-sync-stepper-connector-fill");
				fillEl.style.width = `${index === 0 ? firstProgress : secondProgress}%`;
				if (surface === "setup" && this.isGeneratingReview && index === 0 && firstProgress === 0) connectorEl.classList.add("is-indeterminate");
			}
		});
	}
	private getStartStepProgress(surface: ModalSurface): number {
		if (surface !== "setup") return 100;
		if (!this.isGeneratingReview) return 0;
		if (typeof this.planBuildTotal === "number" && this.planBuildTotal > 0) return Math.max(0, Math.min(100, Math.round((this.planBuildProcessed / this.planBuildTotal) * 100)));
		return 0;
	}
	private getReviewStepProgress(surface: ModalSurface): number {
		if (surface === "result") return 100;
		if (surface !== "running" || !this.executionSnapshot) return 0;
		const totalEntries = this.getExecutionSelectedCount();
		return totalEntries <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((this.getExecutionHandledCount() / totalEntries) * 100)));
	}
	private async renderSetupSurface(renderVersion: number) {
		if (!this.bodyEl) return;
		if (this.footerEl) { clearElement(this.footerEl); this.footerEl.className = "keepsidian-sync-center-footer"; }
		clearElement(this.bodyEl);
		const actionsEl = createChild(this.bodyEl, "div"); actionsEl.classList.add("keepsidian-modal-actions"); this.createSetupStartButton(actionsEl);
		const openLogButton = this.createActionButton(actionsEl, t("sync.openLog"), async () => { await this.options.onOpenSyncLog(); });
		openLogButton.classList.add("keepsidian-modal-action--open-log"); openLogButton.disabled = this.isGeneratingReview;
		const syncOptionsButton = this.createActionButton(actionsEl, t("sync.customize"), async () => { this.showSyncOptions = !this.showSyncOptions; await this.refreshUI(); });
		syncOptionsButton.classList.add("keepsidian-modal-action--sync-options", "keepsidian-modal-action--dropdown");
		syncOptionsButton.disabled = this.isGeneratingReview; syncOptionsButton.setAttribute("aria-expanded", this.showSyncOptions ? "true" : "false"); syncOptionsButton.classList.toggle("is-expanded", this.showSyncOptions);
		const syncOptionsContainerEl = createChild(this.bodyEl, "div"); syncOptionsContainerEl.classList.add("keepsidian-sync-center-options"); syncOptionsContainerEl.hidden = !this.showSyncOptions;
		if (this.showSyncOptions) {
			const modeSectionEl = createChild(syncOptionsContainerEl, "div"); modeSectionEl.classList.add("keepsidian-sync-center-mode-section", "keepsidian-sync-center-mode-section--primary");
			createChild(modeSectionEl, "div", { text: t("sync.modeLabel") }).classList.add("keepsidian-sync-center-mode-label");
			const modePickerEl = createChild(syncOptionsContainerEl, "div"); modePickerEl.classList.add("keepsidian-sync-center-modes"); modePickerEl.setAttribute("role", "radiogroup"); modePickerEl.setAttribute("aria-label", t("sync.modeAria")); modeSectionEl.appendChild(modePickerEl);
			(["import", "push", "two-way"] as SyncMode[]).forEach((mode) => {
				const button = this.createActionButton(modePickerEl, "", async () => { this.setSelectedMode(mode); });
				button.classList.add("keepsidian-sync-center-mode-button"); button.classList.toggle("is-selected", this.selectedMode === mode);
				button.setAttribute("role", "radio"); button.setAttribute("aria-checked", this.selectedMode === mode ? "true" : "false");
				const indicator = createChild(button, "span"); indicator.classList.add("keepsidian-sync-center-mode-indicator"); indicator.setAttribute("aria-hidden", "true");
				createChild(button, "span", { text: modeLabel(mode) }).classList.add("keepsidian-sync-center-mode-text");
			});
			if (modeUsesDownload(this.selectedMode)) {
				this.renderDownloadScopeSection(syncOptionsContainerEl);
				const isSupporterActive = await this.options.isSupporterActive();
				if (renderVersion !== this.renderVersion) return;
				if (isSupporterActive) {
					const importOptionsContainerEl = createChild(syncOptionsContainerEl, "div"); importOptionsContainerEl.classList.add("keepsidian-sync-center-download-options");
					createChild(importOptionsContainerEl, "h3", { text: t("sync.downloadOptions") }).classList.add("keepsidian-sync-center-download-options-title");
					createChild(importOptionsContainerEl, "p", { text: t("sync.supporterThanks") }).classList.add("keepsidian-sync-center-download-options-copy");
					const optionsBody = createChild(importOptionsContainerEl, "div"); optionsBody.classList.add("keepsidian-sync-center-download-options-body");
					await this.options.renderImportOptions(optionsBody, true);
					renderLegacyTagChoice(optionsBody, this.legacyTags, (value) => { this.legacyTags = value; });
					if (renderVersion !== this.renderVersion) return;
				}
			}
			if (modeRequiresTwoWayGate(this.selectedMode)) {
				const gate = this.options.getTwoWayGate();
				if (!gate.allowed) {
					const gateMessageEl = createChild(syncOptionsContainerEl, "div"); gateMessageEl.classList.add("keepsidian-modal-gate-message");
					createChild(gateMessageEl, "div", { text: t("sync.betaUploads") }).classList.add("keepsidian-modal-gate-heading");
					const list = createChild(gateMessageEl, "ul"); for (const reason of gate.reasons) createChild(list, "li", { text: localizePluginLabel(reason) });
					const openSettings = createChild(gateMessageEl, "button", { text: t("sync.betaSettings") }); openSettings.type = "button"; openSettings.addEventListener("click", () => { this.options.openTwoWaySettings(); });
				}
			}
		}
		if (!this.footerEl) return;
		if (this.showSyncOptions) this.createSetupStartButton(this.footerEl).classList.add("keepsidian-modal-action--sync-footer-primary");
		this.createActionButton(this.footerEl, t("sync.closeCenter"), async () => { this.close(); }).classList.add("keepsidian-modal-close");
	}
	private createSetupStartButton(containerEl: HTMLElement): HTMLButtonElement {
		const label = this.preparationPaused && !this.isGeneratingReview ? t("sync.resume") : getSetupPrimaryButtonLabel(this.isGeneratingReview, this.planBuildProcessed, this.planBuildTotal);
		const button = this.createActionButton(containerEl, label, async () => { await this.beginReview(); });
		button.classList.add("mod-cta", "keepsidian-modal-action--primary"); button.disabled = this.isGeneratingReview || this.isSyncing;
		return button;
	}
	private renderDownloadScopeSection(containerEl: HTMLElement) {
		const sectionEl = createChild(containerEl, "div");
		sectionEl.classList.add("keepsidian-sync-center-mode-section", "keepsidian-sync-center-scope-section");

		const heading = createChild(sectionEl, "div", { text: t("scope.heading") });
		heading.classList.add("keepsidian-sync-center-mode-label");
		heading.title = t("scope.description");

		const optionsEl = createChild(sectionEl, "div");
		optionsEl.classList.add("keepsidian-sync-center-modes");
		optionsEl.setAttribute("role", "radiogroup");
		optionsEl.setAttribute("aria-label", t("scope.heading"));

		const lastSuccessfulDownloadDate = this.getLastSuccessfulDownloadDate();
		const lastSyncDescription = lastSuccessfulDownloadDate
			? t("sync.lastTime",{time:formatScopeTimestamp(lastSuccessfulDownloadDate)})
			: t("scope.none");

		this.renderDownloadScopeOption(optionsEl, t("scope.last"), "last-sync", lastSyncDescription);
		this.renderDownloadScopeOption(optionsEl, t("scope.all"), "all", "");
		this.renderDownloadScopeOption(optionsEl, t("scope.custom"), "custom-since", "");

		if (this.downloadScopeKind === "custom-since") {
			renderCustomScopeInputs(
				sectionEl,
				{
					since: this.customSinceInput,
					until: this.customUntilInput,
					disabled: this.isGeneratingReview || this.isSyncing,
				},
				({ since, until }) => {
					if (since === this.customSinceInput && until === this.customUntilInput) return;
					this.customSinceInput = since;
					this.customUntilInput = until;
					this.preparationPaused = false;
					this.modalAlert = null;
					if (this.alertHostEl && !this.dismissPrompt) clearElement(this.alertHostEl);
					// Updating the helpers in place preserves focus when tabbing to the end input.
					this.contentEl.querySelectorAll<HTMLButtonElement>(".keepsidian-modal-action--primary").forEach((button) => {
						if (!button.disabled) button.textContent = t("sync.start");
					});
				}
			);
		}
	}

	private renderDownloadScopeOption(
		containerEl: HTMLElement,
		label: string,
		kind: DownloadScopeKind,
		description: string
	) {
		const button = this.createActionButton(containerEl, "", async () => {
			this.setDownloadScopeKind(kind);
		});
		button.classList.add("keepsidian-sync-center-mode-button", "keepsidian-sync-center-scope-button");
		button.classList.toggle("is-selected", this.downloadScopeKind === kind);
		button.setAttribute("role", "radio");
		button.setAttribute("aria-checked", this.downloadScopeKind === kind ? "true" : "false");
		button.disabled = this.isGeneratingReview || this.isSyncing;
		button.title =
			kind === "custom-since"
				? t("scope.customDescription")
				: kind === "all"
					? t("scope.allDescription")
					: t("scope.lastDescription");

		const indicator = createChild(button, "span");
		indicator.classList.add("keepsidian-sync-center-mode-indicator");
		indicator.setAttribute("aria-hidden", "true");

		const body = createChild(button, "span");
		body.classList.add("keepsidian-sync-center-scope-option-body");

		const title = createChild(body, "span", { text: label });
		title.classList.add("keepsidian-sync-center-mode-text");

		const copy = createChild(body, "span", { text: description });
		copy.classList.add("keepsidian-sync-center-scope-option-copy");
	}
	private ensurePlanSurfaceStructure() {
		if (!this.bodyEl) return;
		if (this.planActionsEl && this.planPanelEl && this.planSummaryEl && this.planSelectionSummaryEl && this.planListEl) return;
		clearElement(this.bodyEl);
		this.planActionsEl = createChild(this.bodyEl, "div"); this.planActionsEl.classList.add("keepsidian-modal-actions");
		this.planPanelEl = createChild(this.bodyEl, "div"); this.planPanelEl.classList.add("keepsidian-sync-plan");
		this.planSummaryEl = createChild(this.planPanelEl, "div"); this.planSummaryEl.classList.add("keepsidian-sync-plan-summary");
		this.planSelectionSummaryEl = createChild(this.planPanelEl, "div");
		this.planListEl = createChild(this.planPanelEl, "div"); this.planListEl.classList.add("keepsidian-sync-plan-list");
	}
	private renderPlanSurface(surface: "review" | "running" | "result") {
		this.ensurePlanSurfaceStructure();
		if (!this.planActionsEl || !this.planPanelEl || !this.planSummaryEl || !this.planSelectionSummaryEl || !this.planListEl) return;
		clearElement(this.planActionsEl); this.planActionsEl.classList.add("keepsidian-modal-actions--plan");
		if (surface === "review") {
			this.createActionButton(this.planActionsEl, t("common.backArrow"), async () => {
				await this.activeAttempt?.finish("abandoned"); this.preparedPlan = null; this.executionSnapshot = null; this.showExecutionResult = false; this.reviewFilterKey = "notes"; await this.refreshUI();
			}).classList.add("keepsidian-modal-action--back");
			this.createActionButton(this.planActionsEl, t("common.refresh"), async () => { await this.refreshCurrentReview(); }).classList.add("keepsidian-modal-action--refresh-review");
			const hasSelection = this.preparedPlan?.plan.entries.some((entry) => entry.selectable && entry.selected) ?? false;
			const continuationLabel = hasSelection ? undefined : reviewContinuationLabel(this.preparedPlan);
			const runButton = this.createActionButton(this.planActionsEl, continuationLabel ?? t("sync.execute"), async () => { await this.runReviewedPlan(); });
			runButton.classList.add("mod-cta", "keepsidian-modal-action--primary");
			runButton.disabled = this.isGeneratingReview || !this.preparedPlan || (!hasSelection && !continuationLabel);
		}
		clearElement(this.planSummaryEl);
		if (surface === "review" && this.preparedPlan) {
			createChild(this.planSummaryEl, "div", { text: t("sync.changesFound",{count:this.preparedPlan.plan.actionableCount}) }).classList.add("keepsidian-sync-plan-summary-copy");
			const deletions = this.preparedPlan.plan.entries.filter((entry) => entry.action === "delete");
			if (deletions.length > 0) {
				const warning = createChild(this.planSummaryEl, "div", { text: deletionReviewSummary(this.preparedPlan.plan) });
				warning.classList.add("keepsidian-sync-plan-summary-copy");
				warning.setAttribute("aria-live", "polite");
				warning.setAttribute("data-keepsidian-role", "deletion-summary");
			}
		}
		if ((surface === "running" || surface === "result") && this.executionSnapshot) this.renderRunningSummary();
		if (surface === "review") this.renderChips(this.planSummaryEl, surface);
		this.renderSelectionSummary(this.planSelectionSummaryEl, surface); this.renderEntries(this.planListEl, surface);
		if (this.footerEl) { clearElement(this.footerEl); this.footerEl.className = ""; }
		if (surface === "result" && this.footerEl) {
			this.footerEl.classList.add("keepsidian-modal-actions");
			this.createActionButton(this.footerEl, t("sync.openLog"), async () => { await this.options.onOpenSyncLog(); }).classList.add("keepsidian-modal-action--open-log");
			this.createActionButton(this.footerEl, t("sync.closeCenter"), async () => { this.close(); }).classList.add("mod-cta", "keepsidian-modal-action--primary");
		}
	}
	private async refreshCurrentReview() {
		if (this.isGeneratingReview || this.isSyncing) return;
		if (!this.preparedPlan) { await this.beginReview(); return; }
		if (this.preparedPlan.mode === "two-way" && this.preparedPlan.stage === "upload") {
			const original = this.preparedPlan, generation = ++this.reviewGeneration;
			this.isGeneratingReview = true;
			try {
				const context: SyncPlanBuildCallbacks = {
					attempt: original.attempt,
					protectedPaths: [...(original.unresolvedConflictPaths ?? []), ...getDeletionUploadPaths(original.deletions)],
					forceUploadPaths: original.forceUploadPaths,
				};
				const hasContext = original.attempt || original.unresolvedConflictPaths || original.forceUploadPaths || original.deletions;
				const refreshedPlan = hasContext ? await this.options.buildSyncPlan("push", context) : await this.options.buildSyncPlan("push");
				if (generation !== this.reviewGeneration) return;
				if (!refreshedPlan) { this.preparedPlan = null; return; }
				refreshedPlan.attempt = original.attempt; refreshedPlan.completionDate = original.completionDate; refreshedPlan.attachmentWarnings = original.attachmentWarnings;
				refreshedPlan.deletions = original.deletions;
				refreshedPlan.deletionContext = original.deletionContext;
				refreshedPlan.protectedLocalKeepUrls = original.protectedLocalKeepUrls;
				refreshedPlan.plan = retainUncheckedDeletions(original.plan, excludeDeletionUploads(refreshedPlan.plan, original.deletions));
				refreshedPlan.unresolvedConflictPaths = original.unresolvedConflictPaths; refreshedPlan.forceUploadPaths = original.forceUploadPaths; refreshedPlan.mode = "two-way";
				refreshedPlan.plan = {
					...refreshedPlan.plan, mode: "two-way", mergeAction: normalizeMergeAction(original.plan.mergeAction),
					title: getPlanTitle({ ...refreshedPlan.plan, mode: "two-way" }),
					entries: refreshedPlan.plan.entries.map((entry) => ({ ...entry, mode: "two-way" })),
				};
				this.preparedPlan = refreshedPlan; this.executionSnapshot = null; this.showExecutionResult = false; this.reviewFilterKey = "notes";
			} catch (error) {
				await original.attempt?.fail(error);
				if (generation === this.reviewGeneration) { this.preparedPlan = null; this.showAttemptError(error, "review", original.attempt); }
			} finally {
				if (generation === this.reviewGeneration) { this.isGeneratingReview = false; await this.refreshUI(); }
			}
			return;
		}
		const previous = this.preparedPlan.plan;
		await this.beginReview(this.preparedPlan.mode, normalizeMergeAction(previous.mergeAction));
		if (this.preparedPlan) {
			this.preparedPlan.plan = retainUncheckedDeletions(previous, this.preparedPlan.plan);
			await this.refreshUI();
		}
	}
	private renderChips(containerEl: HTMLElement, surface: "review" | "running" | "result") {
		const countsEl = createChild(containerEl, "div"); countsEl.classList.add("keepsidian-sync-plan-counts");
		for (const chip of this.getChipRenderStates(surface)) {
			const chipButton = createChild(countsEl, "button", { text: typeof chip.count === "number" ? `${chip.label} ${getUiTranslator().formatNumber(chip.count)}` : t("sync.countProgress",{label:chip.label,processed:chip.numerator ?? 0,total:chip.denominator ?? 0}) });
			chipButton.type = "button"; chipButton.classList.add("keepsidian-sync-plan-chip"); chipButton.classList.toggle("is-active", chip.isActive);
			chipButton.addEventListener("click", () => { this.reviewFilterKey = chip.key; void this.refreshUI(); });
		}
		if (surface === "review" && this.preparedPlan) {
			const reviewed = this.preparedPlan;
			renderMergeActionSelector(countsEl, reviewed.plan, (action) => {
				if (this.getSurface() !== "review" || this.preparedPlan !== reviewed || this.isSyncing || this.isGeneratingReview) return;
				reviewed.plan.mergeAction = action;
			}, this.isGeneratingReview);
		}
	}
	private renderRunningSummary() {
		if (!this.planSummaryEl || !this.executionSnapshot) return;
		clearElement(this.planSummaryEl);
		createChild(this.planSummaryEl, "div", { text: t("sync.notesHandled",{processed:this.getExecutionHandledCount(),total:this.getExecutionSelectedCount()}) }).classList.add("keepsidian-sync-plan-summary-copy");
		this.renderChips(this.planSummaryEl, "running");
	}
	private renderSelectionSummary(containerEl: HTMLElement, surface: "review" | "running" | "result") {
		clearElement(containerEl); containerEl.className = "keepsidian-sync-plan-selection-summary";
		if (surface !== "review" || !this.preparedPlan) return;
		const entries = this.preparedPlan.plan.entries;
		const canBulkToggle = entries.some((entry) => entry.selectable && !entry.selectionLocked);
		createChild(containerEl, "div", { text: t("sync.changesSelected",{selected:entries.filter((entry) => entry.selectable && entry.selected).length,total:this.preparedPlan.plan.actionableCount}) });
		if (!canBulkToggle) { createChild(containerEl, "div", { text: t("sync.selectionSupporter") }).classList.add("keepsidian-sync-plan-selection-caption"); return; }
		const toggleWrap = createChild(containerEl, "label"); toggleWrap.classList.add("keepsidian-sync-plan-select-all");
		const checkbox = createChild(toggleWrap, "input"); checkbox.type = "checkbox";
		checkbox.setAttribute("data-keepsidian-focus", "select-all");
		const selectableEntries = entries.filter((entry) => entry.selectable && !entry.selectionLocked), selectedSelectableCount = selectableEntries.filter((entry) => entry.selected).length;
		checkbox.checked = selectedSelectableCount > 0 && selectedSelectableCount === selectableEntries.length; checkbox.indeterminate = selectedSelectableCount > 0 && selectedSelectableCount < selectableEntries.length;
		checkbox.addEventListener("change", () => {
			for (const entry of selectableEntries) entry.selected = checkbox.checked;
			this.preparedPlan!.plan.selectedCount = this.preparedPlan!.plan.entries.filter((entry) => entry.selectable && entry.selected).length;
			void this.refreshUI();
		});
		createChild(toggleWrap, "span", { text: t("common.selectAll") });
	}
	private renderEntries(containerEl: HTMLElement, surface: "review" | "running" | "result") {
		clearElement(containerEl); containerEl.className = "keepsidian-sync-plan-list"; this.executionRowRefs.clear();
		for (const entry of this.getFilteredEntries(surface)) {
			const row = createChild(containerEl, "div"); row.classList.add("keepsidian-sync-plan-row", `is-group-${getChipKeyForEntry(entry)}`);
			if (surface === "review" && entry.selectable) row.classList.add("is-actionable");
			if (surface === "review") this.renderReviewRow(row, entry); else this.renderExecutionRow(row, entry);
		}
	}
	private renderReviewRow(row: HTMLElement, entry: SyncPlanEntry) {
		if (entry.selectionLocked) { row.classList.add("is-locked"); if (entry.selectionLockedReason) row.setAttribute("title", localizePluginLabel(entry.selectionLockedReason)); }
		const toggleWrap = createChild(row, "div"); toggleWrap.classList.add("keepsidian-sync-plan-row-toggle");
		const toggle = createChild(toggleWrap, "input"); toggle.type = "checkbox"; toggle.checked = entry.selected; toggle.disabled = !entry.selectable || entry.selectionLocked || this.isGeneratingReview;
		toggle.setAttribute("data-keepsidian-focus", `entry:${entry.id}`);
		toggle.setAttribute("aria-label", `${getReviewEntryLabel(entry)}: ${entry.title}`);
		if (entry.selectionLockedReason) toggle.title = localizePluginLabel(entry.selectionLockedReason);
		toggle.addEventListener("change", () => {
			entry.selected = toggle.checked;
			if (this.preparedPlan) this.preparedPlan.plan.selectedCount = this.preparedPlan.plan.entries.filter((candidate) => candidate.selectable && candidate.selected).length;
			void this.refreshUI();
		});
		const body = createChild(row, "div"); body.classList.add("keepsidian-sync-plan-row-body"); this.renderEntryBody(body, entry, getReviewEntryLabel(entry));
	}
	private renderExecutionRow(row: HTMLDivElement, entry: SyncPlanEntry) {
		if (!this.executionSnapshot) return;
		const state = this.executionSnapshot.entryStates.get(entry.id) ?? "pending"; row.classList.add(`is-${state}`);
		const statusEl = createChild(row, "div"); statusEl.classList.add("keepsidian-sync-plan-row-status");
		const statusSymbolEl = createChild(statusEl, "span", { text: state === "done" || state === "instant" ? "✓" : state === "failed" ? "!" : state === "unchecked" ? "–" : "…" });
		const body = createChild(row, "div"); body.classList.add("keepsidian-sync-plan-row-body");
		const badgeEl = this.renderEntryBody(body, entry, getRuntimeStatusLabel(entry, state)); this.executionRowRefs.set(entry.id, { row, statusSymbolEl, badgeEl });
	}
	private updateExecutionRowInPlace(entryId: string) {
		if (!this.executionSnapshot) return;
		const refs = this.executionRowRefs.get(entryId); if (!refs) return;
		const entry = this.executionSnapshot.plan.entries.find((candidate) => candidate.id === entryId); if (!entry) return;
		const state = this.executionSnapshot.entryStates.get(entry.id) ?? "pending";
		refs.row.classList.remove("is-pending", "is-done", "is-failed", "is-unchecked", "is-instant"); refs.row.classList.add(`is-${state}`);
		refs.statusSymbolEl.textContent = state === "done" || state === "instant" ? "✓" : state === "failed" ? "!" : state === "unchecked" ? "–" : "…";
		refs.badgeEl.textContent = getRuntimeStatusLabel(entry, state);
		const titleEl = refs.row.querySelector(".keepsidian-sync-plan-row-title");
		const pathEl = refs.row.querySelector(".keepsidian-sync-plan-row-path");
		if (titleEl) titleEl.textContent = entry.title;
		if (pathEl) pathEl.textContent = entry.path;
		if (!entry.meta?.detail) refs.row.querySelector(".keepsidian-sync-plan-row-detail")?.remove();
	}
	private renderEntryBody(body: HTMLElement, entry: SyncPlanEntry, badgeText: string): HTMLSpanElement {
		const titleLine = createChild(body, "div"); titleLine.classList.add("keepsidian-sync-plan-row-title-line");
		createChild(titleLine, "div", { text: entry.title }).classList.add("keepsidian-sync-plan-row-title");
		titleLine.querySelector(".keepsidian-sync-plan-row-title")?.setAttribute("lang", "");
		const badge = createChild(titleLine, "span", { text: badgeText }); badge.classList.add("keepsidian-sync-plan-row-badge");
		createChild(body, "div", { text: entry.path }).classList.add("keepsidian-sync-plan-row-path");
		body.querySelector(".keepsidian-sync-plan-row-path")?.setAttribute("lang", "");
		const detail = planEntryDetail(entry);
		if (detail) createChild(body, "div", { text: detail }).classList.add("keepsidian-sync-plan-row-detail");
		return badge;
	}
	private getFilteredEntries(surface: "review" | "running" | "result"): SyncPlanEntry[] {
		const entries = surface === "review" ? (this.preparedPlan?.plan.entries ?? []) : (this.executionSnapshot?.plan.entries ?? []);
		if (this.reviewFilterKey === "notes") return entries;
		if (surface !== "review" && this.reviewFilterKey === "unchecked") return entries.filter((entry) => this.executionSnapshot?.entryStates.get(entry.id) === "unchecked");
		return entries.filter((entry) => getChipKeyForEntry(entry) === this.reviewFilterKey);
	}
	private getChipRenderStates(surface: "review" | "running" | "result"): ChipRenderState[] { return surface === "review" ? this.getReviewChipStates() : this.getExecutionChipStates(); }
	private getReviewChipStates(): ChipRenderState[] {
		if (!this.preparedPlan) return [];
		const counts = new Map<ChipKey, number>(); counts.set("notes", this.preparedPlan.plan.entries.length);
		for (const entry of this.preparedPlan.plan.entries) { const key = getChipKeyForEntry(entry); counts.set(key, (counts.get(key) ?? 0) + 1); }
		return CHIP_ORDER.filter((key) => (counts.get(key) ?? 0) > 0 || key === "notes").map((key) => ({ key, label: getReviewChipLabel(key), count: counts.get(key) ?? 0, isActive: this.reviewFilterKey === key }));
	}
	private getExecutionChipStates(): ChipRenderState[] {
		if (!this.executionSnapshot) return [];
		const denominators = new Map<ChipKey, number>(), numerators = new Map<ChipKey, number>(), entries = this.executionSnapshot.plan.entries;
		const selectedEntries = entries.filter((entry) => entry.selectable && entry.selected), supplementalEntries = entries.filter((entry) => !entry.selectable);
		denominators.set("notes", selectedEntries.length); numerators.set("notes", 0);
		for (const entry of selectedEntries) {
			const key = getChipKeyForEntry(entry); denominators.set(key, (denominators.get(key) ?? 0) + 1);
			const state = this.executionSnapshot.entryStates.get(entry.id) ?? "pending";
			if (state === "done" || state === "failed" || state === "instant") {
				// Failed deletions are handled, but must never be counted as Deleted.
				if (key !== "delete" || state === "done") numerators.set(key, (numerators.get(key) ?? 0) + 1);
				numerators.set("notes", (numerators.get("notes") ?? 0) + 1);
			}
		}
		for (const entry of supplementalEntries) {
			const key = getChipKeyForEntry(entry), state = this.executionSnapshot.entryStates.get(entry.id) ?? "pending";
			denominators.set(key, (denominators.get(key) ?? 0) + 1);
			if ((state === "done" || state === "failed" || state === "instant") && (key !== "delete" || state === "done")) numerators.set(key, (numerators.get(key) ?? 0) + 1);
		}
		const uncheckedCount = entries.filter((entry) => this.executionSnapshot?.entryStates.get(entry.id) === "unchecked").length;
		if (uncheckedCount > 0) { denominators.set("unchecked", uncheckedCount); numerators.set("unchecked", uncheckedCount); }
		return CHIP_ORDER.filter((key) => (denominators.get(key) ?? 0) > 0 || key === "notes").map((key) => ({ key, label: getExecutionChipLabel(key), numerator: numerators.get(key) ?? 0, denominator: denominators.get(key) ?? 0, isActive: this.reviewFilterKey === key }));
	}
	private getExecutionHandledCount(): number {
		if (!this.executionSnapshot) return 0;
		let handledCount = 0;
		for (const entry of this.executionSnapshot.plan.entries) {
			if (!entry.selectable || !entry.selected) continue;
			const state = this.executionSnapshot.entryStates.get(entry.id);
			if (state === "done" || state === "failed" || state === "instant") handledCount += 1;
		}
		return handledCount;
	}
	private getExecutionSelectedCount(): number {
		return this.executionSnapshot?.plan.entries.filter((entry) => entry.selectable && entry.selected).length ?? 0;
	}
	private createActionButton(container: HTMLElement, label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
		const button = createChild(container, "button", { text: label }); button.type = "button"; button.classList.add("keepsidian-modal-action");
		button.addEventListener("click", () => { void onClick(); }); return button;
	}
}
