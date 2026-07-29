import { App, Modal } from "obsidian";
import type {
	DownloadScope,
	DownloadScopeKind,
	LastSyncSummary,
	SyncMode,
	SyncPlan,
	SyncPlanEntry,
	SyncRunStatus,
} from "@types";
import type {
	PreparedSyncPlan,
	RunPreparedSyncPlanResult,
	SyncPlanBuildCallbacks,
	SyncPlanRunCallbacks,
} from "@app/main-sync-flows";
import { formatModalSummary } from "@app/sync-status";

interface CreateElOptions {
	text?: string;
	cls?: string | string[];
}

type MaybeObsidianElement = HTMLElement & {
	empty?: () => void;
	setText?: (text: string) => void;
};

interface TwoWayGateState {
	allowed: boolean;
	reasons: string[];
}

interface SyncProgressModalOptions {
	buildSyncPlan: (
		mode: SyncMode,
		callbacks?: SyncPlanBuildCallbacks,
		downloadScope?: DownloadScope
	) => Promise<PreparedSyncPlan | null>;
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
type ChipKey =
	| "notes"
	| "create"
	| "merge"
	| "overwrite"
	| "upload"
	| "conflict-copy"
	| "already-up-to-date"
	| "unchecked";
type EntryRunState = "pending" | "done" | "failed" | "unchecked" | "instant";

interface ExecutionSnapshot {
	plan: SyncPlan;
	entryStates: Map<string, EntryRunState>;
}

interface ExecutionRowRefs {
	row: HTMLDivElement;
	statusSymbolEl: HTMLSpanElement;
	badgeEl: HTMLSpanElement;
}

interface ChipRenderState {
	key: ChipKey;
	label: string;
	numerator?: number;
	denominator?: number;
	count?: number;
	isActive: boolean;
}

interface ModalAlertState {
	title: string;
	message: string;
}

interface DismissPromptState {
	activeRun: boolean;
}

const CHIP_ORDER: ChipKey[] = [
	"notes",
	"create",
	"merge",
	"overwrite",
	"upload",
	"conflict-copy",
	"already-up-to-date",
	"unchecked",
];

const clearElement = (element: HTMLElement) => {
	const maybeObsidianElement = element as MaybeObsidianElement;
	if (typeof maybeObsidianElement.empty === "function") {
		maybeObsidianElement.empty();
		return;
	}
	element.innerHTML = "";
};

const createChild = <K extends keyof HTMLElementTagNameMap>(
	parent: HTMLElement,
	tagName: K,
	options?: CreateElOptions
): HTMLElementTagNameMap[K] => parent.createEl(tagName, options);

function modeLabel(mode: SyncMode): string {
	switch (mode) {
		case "push":
			return "Upload";
		case "two-way":
			return "Two-way sync";
		case "import":
		default:
			return "Download";
	}
}

function modeUsesDownload(mode: SyncMode): boolean {
	return mode !== "push";
}

function modeRequiresTwoWayGate(mode: SyncMode): boolean {
	return mode === "push" || mode === "two-way";
}

function formatGeneratedAt(timestamp: number): string {
	try {
		return new Date(timestamp).toLocaleString();
	} catch {
		return new Date(timestamp).toISOString();
	}
}

function formatScopeTimestamp(isoString: string): string {
	try {
		return new Date(isoString).toLocaleString();
	} catch {
		return isoString;
	}
}

const CUSTOM_SCOPE_INPUT_FORMAT = "YYYY-MM-DD HH:MM";
const CUSTOM_SCOPE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))$/;

function toCustomScopeInputValue(isoString: string): string {
	const parsed = new Date(isoString);
	if (Number.isNaN(parsed.getTime())) {
		return "";
	}

	const offsetMs = parsed.getTimezoneOffset() * 60_000;
	return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16).replace("T", " ");
}

function parseCustomScopeInput(value: string): { iso?: string; error?: string } {
	const trimmedValue = value.trim();
	if (!trimmedValue) {
		return {
			error: "Choose a custom date.",
		};
	}

	const match = trimmedValue.match(CUSTOM_SCOPE_INPUT_PATTERN);
	if (!match) {
		return {
			error: "Choose a valid custom date.",
		};
	}

	const [, yearString, monthString, dayString, hourString, minuteString] = match;
	const year = Number(yearString);
	const month = Number(monthString);
	const day = Number(dayString);
	const hour = Number(hourString);
	const minute = Number(minuteString);
	const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
	if (
		Number.isNaN(parsed.getTime()) ||
		parsed.getFullYear() !== year ||
		parsed.getMonth() !== month - 1 ||
		parsed.getDate() !== day ||
		parsed.getHours() !== hour ||
		parsed.getMinutes() !== minute
	) {
		return {
			error: "Choose a valid custom date.",
		};
	}

	if (parsed.getTime() > Date.now()) {
		return {
			error: "Custom date must be in the past.",
		};
	}

	return { iso: parsed.toISOString() };
}

function clonePlan(plan: SyncPlan): SyncPlan {
	return {
		...plan,
		counts: { ...plan.counts },
		entries: plan.entries.map((entry) => ({
			...entry,
			meta: entry.meta ? { ...entry.meta } : undefined,
		})),
	};
}

function getChipKeyForEntry(entry: SyncPlanEntry): ChipKey {
	switch (entry.action) {
		case "create":
			return "create";
		case "merge":
			return "merge";
		case "overwrite":
			return "overwrite";
		case "upload":
			return "upload";
		case "conflict-copy":
		case "skipped-conflict-copy":
			return "conflict-copy";
		case "skipped-identical":
		case "skipped-up-to-date":
		default:
			return "already-up-to-date";
	}
}

function getReviewChipLabel(key: ChipKey): string {
	switch (key) {
		case "notes":
			return "Notes";
		case "create":
			return "Create";
		case "merge":
			return "Merge";
		case "overwrite":
			return "Overwrite";
		case "upload":
			return "Upload";
		case "conflict-copy":
			return "Conflict copy";
		case "already-up-to-date":
			return "Already up to date";
		case "unchecked":
			return "Unchecked";
	}
}

function getExecutionChipLabel(key: ChipKey): string {
	switch (key) {
		case "notes":
			return "Notes";
		case "create":
			return "Created";
		case "merge":
			return "Merged";
		case "overwrite":
			return "Overwritten";
		case "upload":
			return "Uploaded";
		case "conflict-copy":
			return "Conflict copy";
		case "already-up-to-date":
			return "Already up to date";
		case "unchecked":
			return "Unchecked";
	}
}

function getFriendlySyncCenterError(error: unknown, context: "review" | "run"): ModalAlertState {
	const rawMessage =
		error instanceof Error && error.message ? error.message : typeof error === "string" ? error : "Unknown error";
	const normalizedMessage = rawMessage.toLowerCase();
	const looksLikeConnectionProblem =
		normalizedMessage.includes("err_connection_refused") ||
		normalizedMessage.includes("failed to fetch") ||
		normalizedMessage.includes("networkerror") ||
		normalizedMessage.includes("network error") ||
		normalizedMessage.includes("econnrefused") ||
		normalizedMessage.includes("enotfound") ||
		normalizedMessage.includes("timed out") ||
		normalizedMessage.includes("etimedout");

	if (looksLikeConnectionProblem) {
		return {
			title: context === "review" ? "Couldn’t prepare the sync review" : "Couldn’t finish the sync",
			message:
				"The KeepSidian server could not be reached. Check your connection or make sure the sync server is running, then try again.",
		};
	}

	return {
		title: context === "review" ? "Couldn’t prepare the sync review" : "Couldn’t finish the sync",
		message: rawMessage || "An unexpected error occurred.",
	};
}

function getSetupPrimaryButtonLabel(isGeneratingReview: boolean, processed: number, total?: number): string {
	if (!isGeneratingReview) {
		return "Start sync";
	}
	if (typeof total === "number" && total > 0 && processed >= total) {
		return "Downloaded, please wait ...";
	}
	return "Preparing plan...";
}

function getPlanTitle(plan: SyncPlan): string {
	return plan.stage === "upload" ? "Review upload plan" : "Review download plan";
}

function getRunningTitle(plan: SyncPlan): string {
	return plan.stage === "upload" ? "Running upload plan" : "Running download plan";
}

function getResultTitle(plan: SyncPlan, status: SyncRunStatus | null): string {
	if (status === "canceled") {
		return plan.stage === "upload" ? "Upload canceled" : "Download canceled";
	}
	if (status === "failed") {
		return plan.stage === "upload" ? "Upload failed" : "Download failed";
	}
	return plan.stage === "upload" ? "Upload complete" : "Download complete";
}

function getRuntimeStatusLabel(entry: SyncPlanEntry, state: EntryRunState): string {
	if (state === "unchecked") {
		return "Unchecked";
	}
	if (state === "failed") {
		return "Failed";
	}
	if (state === "pending") {
		return "Pending";
	}
	return getExecutionChipLabel(getChipKeyForEntry(entry));
}

function isInstantEntry(entry: SyncPlanEntry): boolean {
	if (!entry.selectable) {
		return true;
	}
	return getChipKeyForEntry(entry) === "conflict-copy";
}

export class SyncProgressModal extends Modal {
	private options: SyncProgressModalOptions;
	private selectedMode: SyncMode = "import";
	private downloadScopeKind: DownloadScopeKind = "last-sync";
	private customSinceInput = "";
	private showSyncOptions = false;
	private isSyncing = false;
	private isCanceling = false;
	private isGeneratingReview = false;
	private processed = 0;
	private total: number | undefined;
	private lastResult: { status: SyncRunStatus; processed: number } | null = null;
	private summary: LastSyncSummary | null = null;
	private preparedPlan: PreparedSyncPlan | null = null;
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
	private readonly handleChromeCloseClick = (event: Event) => {
		if (!this.isSyncing) {
			return;
		}
		event.preventDefault();
		if ("stopImmediatePropagation" in event) {
			event.stopImmediatePropagation();
		}
		event.stopPropagation();
		this.requestSyncCancellation();
	};
	private readonly handleContainerPointerDown = (event: PointerEvent) => {
		if (!this.isBackdropInteraction(event.target)) {
			return;
		}
		event.preventDefault();
		if ("stopImmediatePropagation" in event) {
			event.stopImmediatePropagation();
		}
		event.stopPropagation();
		this.showDismissPrompt();
	};

	constructor(app: App, options: SyncProgressModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen() {
		this.bindChromeCloseButton();
		this.bindBackdropDismissGuard();
		void this.refreshUI();
	}

	onClose() {
		const activeRun = this.isSyncing;
		if (this.allowBackgroundClose) {
			this.allowBackgroundClose = false;
			this.dismissPrompt = null;
			this.unbindChromeCloseButton();
			this.unbindBackdropDismissGuard();
			clearElement(this.contentEl);
			this.modalTitleEl = null;
			this.stepperEl = null;
			this.headerMetaEl = null;
			this.statusEl = null;
			this.statusActionsEl = null;
			this.alertHostEl = null;
			this.bodyEl = null;
			this.footerEl = null;
			this.planActionsEl = null;
			this.planPanelEl = null;
			this.planSummaryEl = null;
			this.planSelectionSummaryEl = null;
			this.planListEl = null;
			this.chromeCloseButtonEl = null;
			this.dismissPromptActionsEl = null;
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
		this.unbindChromeCloseButton();
		this.unbindBackdropDismissGuard();
		this.dismissPrompt = null;
		clearElement(this.contentEl);
		this.modalTitleEl = null;
		this.stepperEl = null;
		this.headerMetaEl = null;
		this.statusEl = null;
		this.statusActionsEl = null;
		this.alertHostEl = null;
		this.bodyEl = null;
		this.footerEl = null;
		this.planActionsEl = null;
		this.planPanelEl = null;
		this.planSummaryEl = null;
		this.planSelectionSummaryEl = null;
		this.planListEl = null;
		this.chromeCloseButtonEl = null;
		this.dismissPromptActionsEl = null;
		this.options.onClose?.({ activeRun });
	}

	private bindChromeCloseButton() {
		const closeButton = this.modalEl.querySelector(".modal-close-button");
		if (closeButton === this.chromeCloseButtonEl) {
			this.syncChromeCloseButtonState();
			return;
		}
		this.unbindChromeCloseButton();
		if (!(closeButton instanceof HTMLElement)) {
			return;
		}
		closeButton.addEventListener("click", this.handleChromeCloseClick, true);
		this.chromeCloseButtonEl = closeButton;
		this.syncChromeCloseButtonState();
	}

	private bindBackdropDismissGuard() {
		this.unbindBackdropDismissGuard();
		this.containerEl.addEventListener("pointerdown", this.handleContainerPointerDown, true);
	}

	private unbindBackdropDismissGuard() {
		this.containerEl.removeEventListener("pointerdown", this.handleContainerPointerDown, true);
	}

	private isBackdropInteraction(target: EventTarget | null): boolean {
		return target instanceof Node && !this.modalEl.contains(target);
	}

	private unbindChromeCloseButton() {
		if (!this.chromeCloseButtonEl) {
			return;
		}
		this.chromeCloseButtonEl.removeEventListener("click", this.handleChromeCloseClick, true);
		if (this.chromeCloseButtonEl.instanceOf(HTMLButtonElement)) {
			this.chromeCloseButtonEl.disabled = false;
		}
		this.chromeCloseButtonEl.classList.remove("is-disabled");
		this.chromeCloseButtonEl = null;
	}

	private syncChromeCloseButtonState() {
		if (!this.chromeCloseButtonEl) {
			return;
		}
		const disableClose = this.isCanceling;
		if (this.chromeCloseButtonEl.instanceOf(HTMLButtonElement)) {
			this.chromeCloseButtonEl.disabled = disableClose;
		}
		this.chromeCloseButtonEl.classList.toggle("is-disabled", disableClose);
	}

	private requestSyncCancellation(): boolean {
		if (!this.isSyncing) {
			return false;
		}
		if (this.isCanceling) {
			return true;
		}
		const requested = this.options.requestCancelSync?.();
		if (requested === false) {
			return false;
		}
		this.isCanceling = true;
		this.modalAlert = null;
		this.syncChromeCloseButtonState();
		void this.refreshUI();
		return true;
	}

	private showDismissPrompt() {
		this.dismissPrompt = { activeRun: this.isSyncing };
		this.modalAlert = null;
		void this.refreshUI();
	}

	private async dismissToBackground() {
		if (!this.isSyncing) {
			return;
		}
		this.allowBackgroundClose = true;
		this.dismissPrompt = null;
		this.close();
	}

	private async confirmDismiss() {
		this.dismissPrompt = null;
		this.close();
	}

	setSelectedMode(mode: SyncMode) {
		if (this.selectedMode === mode) {
			return;
		}
		this.selectedMode = mode;
		this.preparedPlan = null;
		this.executionSnapshot = null;
		this.showExecutionResult = false;
		this.reviewFilterKey = "notes";
		this.modalAlert = null;
		this.dismissPrompt = null;
		void this.refreshUI();
	}

	private getLastSuccessfulDownloadDate(): string | undefined {
		return this.options.getLastSuccessfulDownloadDate();
	}

	private setDownloadScopeKind(kind: DownloadScopeKind) {
		if (this.downloadScopeKind === kind) {
			return;
		}

		this.downloadScopeKind = kind;
		this.modalAlert = null;
		this.dismissPrompt = null;
		if (kind === "custom-since" && !this.customSinceInput) {
			const lastSuccessfulDownloadDate = this.getLastSuccessfulDownloadDate();
			if (lastSuccessfulDownloadDate) {
				this.customSinceInput = toCustomScopeInputValue(lastSuccessfulDownloadDate);
			}
		}
		void this.refreshUI();
	}

	private getDownloadScope(): DownloadScope {
		if (this.downloadScopeKind === "all") {
			return { kind: "all" };
		}

		if (this.downloadScopeKind === "custom-since") {
			const parsed = parseCustomScopeInput(this.customSinceInput);
			if (!parsed.iso) {
				throw new Error(parsed.error ?? "Choose a custom date.");
			}
			return {
				kind: "custom-since",
				since: parsed.iso,
			};
		}

		return { kind: "last-sync" };
	}

	private getCustomScopeError(): string | null {
		if (this.downloadScopeKind !== "custom-since") {
			return null;
		}
		return parseCustomScopeInput(this.customSinceInput).error ?? null;
	}

	async beginReview(mode = this.selectedMode) {
		if (this.isSyncing || this.isGeneratingReview) {
			return;
		}
		this.selectedMode = mode;
		this.isGeneratingReview = true;
		this.preparedPlan = null;
		this.executionSnapshot = null;
		this.showExecutionResult = false;
		this.lastResult = null;
		this.planBuildProcessed = 0;
		this.planBuildTotal = undefined;
		this.reviewFilterKey = "notes";
		this.modalAlert = null;
		this.dismissPrompt = null;
		await this.refreshUI();
		try {
			const downloadScope = modeUsesDownload(mode) ? this.getDownloadScope() : undefined;
			const preparedPlan = await this.options.buildSyncPlan(
				mode,
				{
					setTotalNotes: (total) => {
						this.planBuildTotal = total;
						void this.refreshUI();
					},
					reportPlanProgress: (processed, total) => {
						this.planBuildProcessed = processed;
						if (typeof total === "number" && total > 0) {
							this.planBuildTotal = total;
						}
						void this.refreshUI();
					},
				},
				downloadScope
			);
			if (preparedPlan) {
				preparedPlan.plan.title = getPlanTitle(preparedPlan.plan);
				this.preparedPlan = preparedPlan;
			}
		} catch (error) {
			this.modalAlert = getFriendlySyncCenterError(error, "review");
		} finally {
			this.isGeneratingReview = false;
			await this.refreshUI();
		}
	}

	private async runReviewedPlan() {
		if (!this.preparedPlan || this.isSyncing) {
			return;
		}

		this.initializeExecutionSnapshot(this.preparedPlan.plan);
		this.isSyncing = true;
		this.isCanceling = false;
		this.syncChromeCloseButtonState();
		this.showExecutionResult = false;
		this.modalAlert = null;
		this.dismissPrompt = null;
		await this.refreshUI();

		try {
			const result = await this.options.runSyncPlan(this.preparedPlan, {
				onEntrySettled: (entryId: string, success: boolean) => {
					this.handleEntrySettled(entryId, success);
				},
			});
			if (result.nextPlan) {
				result.nextPlan.plan.title = getPlanTitle(result.nextPlan.plan);
				this.preparedPlan = result.nextPlan;
				this.executionSnapshot = null;
				this.showExecutionResult = false;
				this.reviewFilterKey = "notes";
				return;
			}
			this.preparedPlan = null;
			this.showExecutionResult = !result.canceled;
		} catch (error) {
			this.modalAlert = getFriendlySyncCenterError(error, "run");
			this.showExecutionResult = false;
		} finally {
			this.isSyncing = false;
			this.isCanceling = false;
			this.syncChromeCloseButtonState();
			await this.refreshUI();
		}
	}

	setProgress(processed: number, total?: number) {
		this.processed = processed;
		this.total = total;
		this.summary = null;
		this.lastResult = null;
		this.modalAlert = null;
		this.dismissPrompt = null;
		if (this.getSurface() === "running") {
			return;
		}
		void this.refreshUI();
	}

	setComplete(status: SyncRunStatus | boolean, processed: number) {
		const normalizedStatus =
			typeof status === "boolean" ? (status ? "success" : "failed") : status;
		this.lastResult = { status: normalizedStatus, processed };
		if (this.executionSnapshot) {
			this.showExecutionResult = normalizedStatus !== "canceled";
		}
		if (normalizedStatus !== "failed") {
			this.modalAlert = null;
		}
		this.dismissPrompt = null;
		void this.refreshUI();
	}

	setIdleSummary(summary: LastSyncSummary | null) {
		this.summary = summary;
		if (!this.showExecutionResult) {
			this.lastResult = null;
		}
		const summaryStatus =
			summary == null ? null : (summary.status ?? (summary.success ? "success" : "failed"));
		if (summaryStatus !== "failed") {
			this.modalAlert = null;
		}
		this.dismissPrompt = null;
		void this.refreshUI();
	}

	private initializeExecutionSnapshot(plan: SyncPlan) {
		const snapshotPlan = clonePlan(plan);
		const entryStates = new Map<string, EntryRunState>();
		for (const entry of snapshotPlan.entries) {
			if (entry.selectable && !entry.selected) {
				entryStates.set(entry.id, "unchecked");
				continue;
			}
			if (isInstantEntry(entry)) {
				entryStates.set(entry.id, "instant");
				continue;
			}
			entryStates.set(entry.id, "pending");
		}
		this.executionSnapshot = {
			plan: snapshotPlan,
			entryStates,
		};
		this.reviewFilterKey = "notes";
	}

	private handleEntrySettled(entryId: string, success: boolean) {
		if (!this.executionSnapshot) {
			return;
		}
		const current = this.executionSnapshot.entryStates.get(entryId);
		if (!current || current === "unchecked" || current === "instant") {
			return;
		}
		this.executionSnapshot.entryStates.set(entryId, success ? "done" : "failed");
		if (this.canRefreshRunningInPlace(entryId)) {
			this.refreshRunningExecutionUi(entryId);
			return;
		}
		void this.refreshUI();
	}

	private canRefreshRunningInPlace(entryId?: string): boolean {
		if (this.getSurface() !== "running" || !this.executionSnapshot || !this.statusEl || !this.stepperEl || !this.planSummaryEl) {
			return false;
		}
		if (!this.planListEl) {
			return false;
		}
		if (this.reviewFilterKey === "unchecked") {
			return false;
		}
		if (entryId && this.reviewFilterKey !== "notes") {
			const entry = this.executionSnapshot.plan.entries.find((candidate) => candidate.id === entryId);
			if (!entry || getChipKeyForEntry(entry) !== this.reviewFilterKey) {
				return false;
			}
		}
		return true;
	}

	private refreshRunningExecutionUi(entryId?: string) {
		if (!this.executionSnapshot || !this.statusEl || !this.stepperEl || !this.planSummaryEl) {
			return;
		}
		this.statusEl.textContent = this.getStatusCopy("running");
		this.renderStepper(this.stepperEl, "running");
		this.renderRunningSummary();
		if (entryId) {
			this.updateExecutionRowInPlace(entryId);
		}
	}

	private ensureLayout() {
		if (
			this.modalTitleEl &&
			this.stepperEl &&
			this.headerMetaEl &&
			this.statusEl &&
			this.statusActionsEl &&
			this.alertHostEl &&
			this.bodyEl &&
			this.footerEl
		) {
			return;
		}

		clearElement(this.contentEl);
		this.contentEl.className = "keepsidian-modal";

		this.modalTitleEl = createChild(this.contentEl, "h2");
		this.modalTitleEl.classList.add("keepsidian-modal-title");

		this.stepperEl = createChild(this.contentEl, "div");
		this.headerMetaEl = createChild(this.contentEl, "div");
		this.headerMetaEl.classList.add("keepsidian-modal-header-meta");
		this.statusEl = createChild(this.headerMetaEl, "div");
		this.statusEl.classList.add("keepsidian-modal-status");
		this.statusEl.setAttribute("aria-live", "polite");
		this.statusActionsEl = createChild(this.headerMetaEl, "div");
		this.statusActionsEl.classList.add("keepsidian-modal-status-actions");

		this.alertHostEl = createChild(this.contentEl, "div");
		this.bodyEl = createChild(this.contentEl, "div");
		this.footerEl = createChild(this.contentEl, "div");
	}

	private getSurface(): ModalSurface {
		if (this.isSyncing && this.executionSnapshot) {
			return "running";
		}
		if (this.preparedPlan) {
			return "review";
		}
		if (this.executionSnapshot && this.showExecutionResult) {
			return "result";
		}
		return "setup";
	}

	private async refreshUI() {
		const renderVersion = ++this.renderVersion;
		const surface = this.getSurface();
		this.ensureLayout();
		this.bindChromeCloseButton();
		this.syncChromeCloseButtonState();
		if (surface !== "running") {
			this.executionRowRefs.clear();
		}
		this.contentEl.className = "keepsidian-modal";
		this.contentEl.classList.add(surface === "setup" ? "keepsidian-modal--compact" : "keepsidian-modal--plan");
		this.modalEl.classList.remove("keepsidian-modal-shell--compact", "keepsidian-modal-shell--plan");
		this.modalEl.classList.add(
			surface === "setup" ? "keepsidian-modal-shell--compact" : "keepsidian-modal-shell--plan"
		);

		if (this.modalTitleEl) {
			this.modalTitleEl.textContent = this.getTitle(surface);
		}

		if (this.stepperEl) {
			this.renderStepper(this.stepperEl, surface);
		}

		if (this.statusEl) {
			this.statusEl.textContent = this.getStatusCopy(surface);
		}
		if (this.statusActionsEl) {
			clearElement(this.statusActionsEl);
			if (surface === "running") {
				const cancelButton = this.createActionButton(
					this.statusActionsEl,
					this.isCanceling ? "Canceling ..." : "Cancel",
					async () => {
						this.requestSyncCancellation();
					}
				);
				cancelButton.classList.add("keepsidian-modal-inline-action", "keepsidian-modal-inline-action--cancel");
				cancelButton.disabled = this.isCanceling;
			}
		}

		if (this.alertHostEl) {
			clearElement(this.alertHostEl);
			if (this.modalAlert) {
				this.renderAlert(this.alertHostEl, this.modalAlert);
			}
			if (this.dismissPrompt) {
				this.renderDismissPrompt(this.alertHostEl, this.dismissPrompt);
			}
		}

		if (surface === "setup") {
			this.planActionsEl = null;
			this.planPanelEl = null;
			this.planSummaryEl = null;
			this.planSelectionSummaryEl = null;
			this.planListEl = null;
			if (this.footerEl) {
				clearElement(this.footerEl);
			}
			await this.renderSetupSurface(renderVersion);
			return;
		}

		this.renderPlanSurface(surface);
	}

	private renderAlert(containerEl: HTMLElement, alert: ModalAlertState) {
		const alertEl = createChild(containerEl, "div");
		alertEl.classList.add("keepsidian-modal-alert");
		alertEl.setAttribute("role", "alert");
		const titleEl = createChild(alertEl, "div", { text: alert.title });
		titleEl.classList.add("keepsidian-modal-alert-title");
		const messageEl = createChild(alertEl, "div", { text: alert.message });
		messageEl.classList.add("keepsidian-modal-alert-message");
	}

	private renderDismissPrompt(containerEl: HTMLElement, prompt: DismissPromptState) {
		const promptEl = createChild(containerEl, "div");
		promptEl.classList.add("keepsidian-modal-dismiss-prompt");
		const titleEl = createChild(promptEl, "div", {
			text: prompt.activeRun ? "Leave this sync running?" : "Close sync center?",
		});
		titleEl.classList.add("keepsidian-modal-dismiss-prompt-title");
		const messageEl = createChild(promptEl, "div", {
			text: prompt.activeRun
				? "You clicked outside the dialog. Choose whether to cancel the sync, let it keep running in the background, or return to the dialog."
				: "Close sync center or go back without losing your place?",
		});
		messageEl.classList.add("keepsidian-modal-dismiss-prompt-message");
		this.dismissPromptActionsEl = createChild(promptEl, "div");
		this.dismissPromptActionsEl.classList.add("keepsidian-modal-dismiss-prompt-actions");

		if (prompt.activeRun) {
			const cancelButton = this.createActionButton(
				this.dismissPromptActionsEl,
				this.isCanceling ? "Canceling ..." : "Cancel sync",
				async () => {
					this.dismissPrompt = null;
					this.requestSyncCancellation();
				}
			);
			cancelButton.classList.add("keepsidian-modal-dismiss-prompt-action--danger");
			cancelButton.disabled = this.isCanceling;

			const backgroundButton = this.createActionButton(
				this.dismissPromptActionsEl,
				"Run in background",
				async () => {
					await this.dismissToBackground();
				}
			);
			backgroundButton.classList.add("keepsidian-modal-dismiss-prompt-action--ghost");
		} else {
			const closeButton = this.createActionButton(
				this.dismissPromptActionsEl,
				"Close",
				async () => {
					await this.confirmDismiss();
				}
			);
			closeButton.classList.add("keepsidian-modal-dismiss-prompt-action--danger");
		}

		const backButton = this.createActionButton(this.dismissPromptActionsEl, "Back", async () => {
			this.dismissPrompt = null;
			await this.refreshUI();
		});
		backButton.classList.add("keepsidian-modal-dismiss-prompt-action--ghost");
	}

	private getTitle(surface: ModalSurface): string {
		if (surface === "setup") {
			return "Sync center";
		}
		const plan = this.preparedPlan?.plan ?? this.executionSnapshot?.plan;
		if (!plan) {
			return "Sync plan";
		}
		if (surface === "review") {
			return getPlanTitle(plan);
		}
		if (surface === "running") {
			return getRunningTitle(plan);
		}
		return getResultTitle(plan, this.lastResult?.status ?? null);
	}

	private getStatusCopy(surface: ModalSurface): string {
		if (surface === "setup") {
			if (this.isGeneratingReview) {
				if (typeof this.planBuildTotal === "number" && this.planBuildTotal > 0) {
					return `Prepared ${this.planBuildProcessed} of ${this.planBuildTotal} notes for review.`;
				}
				return `Preparing '${modeLabel(this.selectedMode).toLowerCase()}' plan...`;
			}
			if (this.isSyncing) {
				const phaseLabel = this.options.getCurrentPhaseLabel() ?? "Syncing";
				if (typeof this.total === "number" && this.total > 0) {
					return this.isCanceling
						? `Canceling... ${this.processed}/${this.total}`
						: `${phaseLabel}: ${this.processed}/${this.total}`;
				}
				return this.isCanceling ? `Canceling... ${this.processed}` : `${phaseLabel}: ${this.processed}`;
			}
			if (this.summary) {
				return formatModalSummary(this.summary);
			}
			return "Start or customize sync.";
		}

		if (surface === "review" && this.preparedPlan) {
			return `Generated ${formatGeneratedAt(this.preparedPlan.plan.generatedAt)}. Review the plan below.`;
		}

		if ((surface === "running" || surface === "result") && this.executionSnapshot) {
			const selectedCount = this.executionSnapshot.plan.entries.filter(
				(entry) => entry.selectable && entry.selected
			).length;
			const handledCount = this.getExecutionHandledCount();
			const pendingCount = Math.max(0, selectedCount - handledCount);
			if (surface === "running") {
				return this.isCanceling
					? `${selectedCount} selected. Canceling...`
					: `${selectedCount} selected. ${pendingCount} pending.`;
			}
			if (this.summary) {
				return formatModalSummary(this.summary);
			}
			if (this.lastResult?.status === "canceled") {
				return `Sync canceled after ${this.lastResult.processed} notes.`;
			}
			return this.lastResult?.status === "success"
				? `Sync complete. Processed ${this.lastResult.processed} notes.`
				: "Sync failed.";
		}

		return "";
	}

	private renderStepper(containerEl: HTMLElement, surface: ModalSurface) {
		clearElement(containerEl);
		containerEl.className = "keepsidian-sync-stepper";

		const firstProgress = this.getStartStepProgress(surface);
		const secondProgress = this.getReviewStepProgress(surface);
		const isReviewReached = surface === "review" || surface === "running" || surface === "result";
		const isDoneReached = surface === "result";
		const steps: Array<{ label: string; state: "pending" | "active" | "complete" }> = [
			{
				label: "Start",
				state: surface === "setup" && !isReviewReached ? "active" : "complete",
			},
			{
				label: "Review",
				state: surface === "review" || surface === "running" ? "active" : isDoneReached ? "complete" : "pending",
			},
			{
				label: "Done",
				state: isDoneReached ? "active" : "pending",
			},
		];

		steps.forEach((step, index) => {
			const stepEl = createChild(containerEl, "div");
			stepEl.classList.add("keepsidian-sync-stepper-step", `is-${step.state}`);
			const nodeEl = createChild(stepEl, "div");
			nodeEl.classList.add("keepsidian-sync-stepper-node");
			const labelEl = createChild(stepEl, "div", { text: step.label });
			labelEl.classList.add("keepsidian-sync-stepper-label");
			if (index < steps.length - 1) {
				const connectorEl = createChild(containerEl, "div");
				connectorEl.classList.add("keepsidian-sync-stepper-connector");
				const fillEl = createChild(connectorEl, "div");
				fillEl.classList.add("keepsidian-sync-stepper-connector-fill");
				const progress = index === 0 ? firstProgress : secondProgress;
				fillEl.style.width = `${progress}%`;
				if (surface === "setup" && this.isGeneratingReview && index === 0 && firstProgress === 0) {
					connectorEl.classList.add("is-indeterminate");
				}
			}
		});
	}

	private getStartStepProgress(surface: ModalSurface): number {
		if (surface !== "setup") {
			return 100;
		}
		if (!this.isGeneratingReview) {
			return 0;
		}
		if (typeof this.planBuildTotal === "number" && this.planBuildTotal > 0) {
			return Math.max(0, Math.min(100, Math.round((this.planBuildProcessed / this.planBuildTotal) * 100)));
		}
		return 0;
	}

	private getReviewStepProgress(surface: ModalSurface): number {
		if (surface === "result") {
			return 100;
		}
		if (surface !== "running" || !this.executionSnapshot) {
			return 0;
		}
		const totalEntries = this.getExecutionSelectedCount();
		if (totalEntries <= 0) {
			return 0;
		}
		return Math.max(0, Math.min(100, Math.round((this.getExecutionHandledCount() / totalEntries) * 100)));
	}

	private async renderSetupSurface(renderVersion: number) {
		if (!this.bodyEl) {
			return;
		}
		clearElement(this.bodyEl);
		const actionsEl = createChild(this.bodyEl, "div");
		actionsEl.classList.add("keepsidian-modal-actions");

		const startButton = this.createActionButton(
			actionsEl,
			getSetupPrimaryButtonLabel(this.isGeneratingReview, this.planBuildProcessed, this.planBuildTotal),
			async () => {
				await this.beginReview();
			}
		);
		startButton.classList.add("mod-cta", "keepsidian-modal-action--primary");
		startButton.disabled = this.isGeneratingReview || this.isSyncing;

		const openLogButton = this.createActionButton(actionsEl, "Open sync log", async () => {
			await this.options.onOpenSyncLog();
		});
		openLogButton.classList.add("keepsidian-modal-action--open-log");
		openLogButton.disabled = this.isGeneratingReview;

		const syncOptionsButton = this.createActionButton(actionsEl, "Customize sync", async () => {
			this.showSyncOptions = !this.showSyncOptions;
			await this.refreshUI();
		});
		syncOptionsButton.classList.add("keepsidian-modal-action--sync-options", "keepsidian-modal-action--dropdown");
		syncOptionsButton.disabled = this.isGeneratingReview;
		syncOptionsButton.setAttribute("aria-expanded", this.showSyncOptions ? "true" : "false");
		syncOptionsButton.classList.toggle("is-expanded", this.showSyncOptions);

		const syncOptionsContainerEl = createChild(this.bodyEl, "div");
		syncOptionsContainerEl.classList.add("keepsidian-sync-center-options");
		syncOptionsContainerEl.hidden = !this.showSyncOptions;

		if (this.showSyncOptions) {
			const modeSectionEl = createChild(syncOptionsContainerEl, "div");
			modeSectionEl.classList.add(
				"keepsidian-sync-center-mode-section",
				"keepsidian-sync-center-mode-section--primary"
			);
			const modeLabelEl = createChild(modeSectionEl, "div", { text: "Mode" });
			modeLabelEl.classList.add("keepsidian-sync-center-mode-label");
			const modePickerEl = createChild(syncOptionsContainerEl, "div");
			modePickerEl.classList.add("keepsidian-sync-center-modes");
			modePickerEl.setAttribute("role", "radiogroup");
			modePickerEl.setAttribute("aria-label", "Sync mode");
			modeSectionEl.appendChild(modePickerEl);

			(["import", "push", "two-way"] as SyncMode[]).forEach((mode) => {
				const button = this.createActionButton(modePickerEl, "", async () => {
					this.setSelectedMode(mode);
				});
				button.classList.add("keepsidian-sync-center-mode-button");
				button.classList.toggle("is-selected", this.selectedMode === mode);
				button.setAttribute("role", "radio");
				button.setAttribute("aria-checked", this.selectedMode === mode ? "true" : "false");
				const indicator = createChild(button, "span");
				indicator.classList.add("keepsidian-sync-center-mode-indicator");
				indicator.setAttribute("aria-hidden", "true");
				const labelEl = createChild(button, "span", { text: modeLabel(mode) });
				labelEl.classList.add("keepsidian-sync-center-mode-text");
			});

			if (modeUsesDownload(this.selectedMode)) {
				this.renderDownloadScopeSection(syncOptionsContainerEl);
				const isSupporterActive = await this.options.isSupporterActive();
				if (renderVersion !== this.renderVersion) {
					return;
				}
				if (isSupporterActive) {
					const importOptionsContainerEl = createChild(syncOptionsContainerEl, "div");
					importOptionsContainerEl.classList.add("keepsidian-sync-center-download-options");
					const heading = createChild(importOptionsContainerEl, "h3", {
						text: "Download options",
					});
					heading.classList.add("keepsidian-sync-center-download-options-title");
					const copy = createChild(importOptionsContainerEl, "p", {
						text: "Thanks for supporting KeepSidian! Customize your download below.",
					});
					copy.classList.add("keepsidian-sync-center-download-options-copy");
					const optionsBody = createChild(importOptionsContainerEl, "div");
					optionsBody.classList.add("keepsidian-sync-center-download-options-body");
					await this.options.renderImportOptions(optionsBody, true);
					if (renderVersion !== this.renderVersion) {
						return;
					}
				}
			}

			if (modeRequiresTwoWayGate(this.selectedMode)) {
				const gate = this.options.getTwoWayGate();
				if (!gate.allowed) {
					const gateMessageEl = createChild(syncOptionsContainerEl, "div");
					gateMessageEl.classList.add("keepsidian-modal-gate-message");
					const heading = createChild(gateMessageEl, "div", {
						text: "⚠️ Uploads are a beta feature. Follow the instructions below to enable them.",
					});
					heading.classList.add("keepsidian-modal-gate-heading");
					const list = createChild(gateMessageEl, "ul");
					for (const reason of gate.reasons) {
						createChild(list, "li", { text: reason });
					}
					const openSettings = createChild(gateMessageEl, "button", {
						text: "Open beta settings",
					});
					openSettings.type = "button";
					openSettings.addEventListener("click", () => {
						this.options.openTwoWaySettings();
					});
				}
			}
		}

		const closeButton = createChild(this.bodyEl, "button", { text: "Close" });
		closeButton.type = "button";
		closeButton.classList.add("keepsidian-modal-close");
		closeButton.addEventListener("click", () => this.close());
	}

	private renderDownloadScopeSection(containerEl: HTMLElement) {
		const sectionEl = createChild(containerEl, "div");
		sectionEl.classList.add("keepsidian-sync-center-mode-section", "keepsidian-sync-center-scope-section");

		const heading = createChild(sectionEl, "div", { text: "Start date" });
		heading.classList.add("keepsidian-sync-center-mode-label");

		const optionsEl = createChild(sectionEl, "div");
		optionsEl.classList.add("keepsidian-sync-center-modes");
		optionsEl.setAttribute("role", "radiogroup");
		optionsEl.setAttribute("aria-label", "Start date");

		const lastSuccessfulDownloadDate = this.getLastSuccessfulDownloadDate();
		const lastSyncDescription = lastSuccessfulDownloadDate
			? `Last sync: ${formatScopeTimestamp(lastSuccessfulDownloadDate)}.`
			: "None yet.";

		this.renderDownloadScopeOption(optionsEl, "Last successful sync", "last-sync", lastSyncDescription);
		this.renderDownloadScopeOption(optionsEl, "All dates", "all", "");
		this.renderDownloadScopeOption(optionsEl, "Custom", "custom-since", "");

		if (this.downloadScopeKind === "custom-since") {
			const inputWrap = createChild(sectionEl, "label");
			inputWrap.classList.add("keepsidian-sync-center-scope-input-wrap");

			const input = createChild(inputWrap, "input");
			input.type = "text";
			input.value = this.customSinceInput;
			input.placeholder = CUSTOM_SCOPE_INPUT_FORMAT;
			input.autocomplete = "off";
			input.setAttribute("aria-label", `Custom start date (${CUSTOM_SCOPE_INPUT_FORMAT})`);
			input.setAttribute("data-keepsidian-role", "custom-since-input");
			input.classList.add("keepsidian-sync-center-scope-input");

			const helper = createChild(sectionEl, "div");
			helper.classList.add("keepsidian-sync-center-scope-helper");
			const syncCustomScopeHelper = () => {
				const error = parseCustomScopeInput(input.value).error ?? null;
				helper.textContent = error ?? `Use ${CUSTOM_SCOPE_INPUT_FORMAT}. Notes changed after this date will be included.`;
				helper.classList.toggle("is-warning", Boolean(error));
			};
			syncCustomScopeHelper();

			input.addEventListener("input", () => {
				this.customSinceInput = input.value;
				this.modalAlert = null;
				syncCustomScopeHelper();
			});
			input.addEventListener("change", () => {
				this.customSinceInput = input.value;
				this.modalAlert = null;
				syncCustomScopeHelper();
				void this.refreshUI();
			});
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
		if (!this.bodyEl) {
			return;
		}
		if (this.planActionsEl && this.planPanelEl && this.planSummaryEl && this.planSelectionSummaryEl && this.planListEl) {
			return;
		}
		clearElement(this.bodyEl);
		this.planActionsEl = createChild(this.bodyEl, "div");
		this.planActionsEl.classList.add("keepsidian-modal-actions");
		this.planPanelEl = createChild(this.bodyEl, "div");
		this.planPanelEl.classList.add("keepsidian-sync-plan");
		this.planSummaryEl = createChild(this.planPanelEl, "div");
		this.planSummaryEl.classList.add("keepsidian-sync-plan-summary");
		this.planSelectionSummaryEl = createChild(this.planPanelEl, "div");
		this.planListEl = createChild(this.planPanelEl, "div");
		this.planListEl.classList.add("keepsidian-sync-plan-list");
	}

	private renderPlanSurface(surface: "review" | "running" | "result") {
		this.ensurePlanSurfaceStructure();
		if (!this.planActionsEl || !this.planPanelEl || !this.planSummaryEl || !this.planSelectionSummaryEl || !this.planListEl) {
			return;
		}
		clearElement(this.planActionsEl);
		this.planActionsEl.classList.add("keepsidian-modal-actions--plan");

		if (surface === "review") {
			const backButton = this.createActionButton(this.planActionsEl, "◀︎ Back", async () => {
				this.preparedPlan = null;
				this.executionSnapshot = null;
				this.showExecutionResult = false;
				this.reviewFilterKey = "notes";
				await this.refreshUI();
			});
			backButton.classList.add("keepsidian-modal-action--back");

			const refreshButton = this.createActionButton(this.planActionsEl, "↻ Refresh", async () => {
				await this.refreshCurrentReview();
			});
			refreshButton.classList.add("keepsidian-modal-action--refresh-review");

			const runButton = this.createActionButton(this.planActionsEl, "Execute ▶︎", async () => {
				await this.runReviewedPlan();
			});
			runButton.classList.add("mod-cta", "keepsidian-modal-action--primary");
			runButton.disabled =
				this.isGeneratingReview ||
				!this.preparedPlan ||
				this.preparedPlan.plan.entries.every((entry) => !entry.selectable || !entry.selected);
		}

		clearElement(this.planSummaryEl);

		if (surface === "review" && this.preparedPlan) {
			const reviewCopy = createChild(this.planSummaryEl, "div", {
				text: `${this.preparedPlan.plan.actionableCount} changes found.`,
			});
			reviewCopy.classList.add("keepsidian-sync-plan-summary-copy");
		}

		if ((surface === "running" || surface === "result") && this.executionSnapshot) {
			this.renderRunningSummary();
		}

		if (surface === "review") {
			this.renderChips(this.planSummaryEl, surface);
		}
		this.renderSelectionSummary(this.planSelectionSummaryEl, surface);
		this.renderEntries(this.planListEl, surface);

		if (this.footerEl) {
			clearElement(this.footerEl);
		}

		if (surface === "result" && this.footerEl) {
			this.footerEl.classList.add("keepsidian-modal-actions");
			const openLogButton = this.createActionButton(this.footerEl, "Open sync log", async () => {
				await this.options.onOpenSyncLog();
			});
			openLogButton.classList.add("keepsidian-modal-action--open-log");
			const closeButton = this.createActionButton(this.footerEl, "Close", async () => {
				this.close();
			});
			closeButton.classList.add("mod-cta", "keepsidian-modal-action--primary");
		}
	}

	private async refreshCurrentReview() {
		if (!this.preparedPlan) {
			await this.beginReview();
			return;
		}

		if (this.preparedPlan.mode === "two-way" && this.preparedPlan.stage === "upload") {
			const refreshedPlan = await this.options.buildSyncPlan("push");
			if (!refreshedPlan) {
				return;
			}
			refreshedPlan.mode = "two-way";
			refreshedPlan.plan = {
				...refreshedPlan.plan,
				mode: "two-way",
				title: getPlanTitle({
					...refreshedPlan.plan,
					mode: "two-way",
				}),
				entries: refreshedPlan.plan.entries.map((entry) => ({
					...entry,
					mode: "two-way",
				})),
			};
			this.preparedPlan = refreshedPlan;
			this.executionSnapshot = null;
			this.showExecutionResult = false;
			this.reviewFilterKey = "notes";
			await this.refreshUI();
			return;
		}

		await this.beginReview(this.preparedPlan.mode);
	}

	private renderChips(containerEl: HTMLElement, surface: "review" | "running" | "result") {
		const countsEl = createChild(containerEl, "div");
		countsEl.classList.add("keepsidian-sync-plan-counts");
		for (const chip of this.getChipRenderStates(surface)) {
			const chipButton = createChild(countsEl, "button", {
				text:
					typeof chip.count === "number"
						? `${chip.label} ${chip.count}`
						: `${chip.label} ${chip.numerator ?? 0}/${chip.denominator ?? 0}`,
			});
			chipButton.type = "button";
			chipButton.classList.add("keepsidian-sync-plan-chip");
			chipButton.classList.toggle("is-active", chip.isActive);
			chipButton.addEventListener("click", () => {
				this.reviewFilterKey = chip.key;
				void this.refreshUI();
			});
		}
	}

	private renderRunningSummary() {
		if (!this.planSummaryEl || !this.executionSnapshot) {
			return;
		}
		clearElement(this.planSummaryEl);
		const selectedCount = this.getExecutionSelectedCount();
		const handledCount = this.getExecutionHandledCount();
		const runtimeCopy = createChild(this.planSummaryEl, "div", {
			text: `${handledCount} of ${selectedCount} selected notes dealt with.`,
		});
		runtimeCopy.classList.add("keepsidian-sync-plan-summary-copy");
		this.renderChips(this.planSummaryEl, "running");
	}

	private renderSelectionSummary(containerEl: HTMLElement, surface: "review" | "running" | "result") {
		clearElement(containerEl);
		containerEl.className = "keepsidian-sync-plan-selection-summary";
		if (surface !== "review" || !this.preparedPlan) {
			return;
		}
		const entries = this.preparedPlan.plan.entries;
		const canBulkToggle = entries.some((entry) => entry.selectable && !entry.selectionLocked);
		const selectedCount = entries.filter((entry) => entry.selectable && entry.selected).length;
		createChild(containerEl, "div", {
			text: `${selectedCount} of ${this.preparedPlan.plan.actionableCount} changes selected.`,
		});
		if (!canBulkToggle) {
			createChild(containerEl, "div", {
				text: "Per-note selection is available to project supporters.",
			}).classList.add("keepsidian-sync-plan-selection-caption");
			return;
		}

		const toggleWrap = createChild(containerEl, "label");
		toggleWrap.classList.add("keepsidian-sync-plan-select-all");
		const checkbox = createChild(toggleWrap, "input");
		checkbox.type = "checkbox";
		const selectableEntries = entries.filter((entry) => entry.selectable && !entry.selectionLocked);
		const selectedSelectableCount = selectableEntries.filter((entry) => entry.selected).length;
		checkbox.checked = selectedSelectableCount > 0 && selectedSelectableCount === selectableEntries.length;
		checkbox.indeterminate = selectedSelectableCount > 0 && selectedSelectableCount < selectableEntries.length;
		checkbox.addEventListener("change", () => {
			for (const entry of selectableEntries) {
				entry.selected = checkbox.checked;
			}
			this.preparedPlan!.plan.selectedCount = this.preparedPlan!.plan.entries.filter(
				(entry) => entry.selectable && entry.selected
			).length;
			void this.refreshUI();
		});
		createChild(toggleWrap, "span", { text: "Select all" });
	}

	private renderEntries(containerEl: HTMLElement, surface: "review" | "running" | "result") {
		clearElement(containerEl);
		containerEl.className = "keepsidian-sync-plan-list";
		this.executionRowRefs.clear();
		for (const entry of this.getFilteredEntries(surface)) {
			const row = createChild(containerEl, "div");
			row.classList.add("keepsidian-sync-plan-row");
			const chipKey = getChipKeyForEntry(entry);
			row.classList.add(`is-group-${chipKey}`);
			if (surface === "review" && entry.selectable) {
				row.classList.add("is-actionable");
			}

			if (surface === "review") {
				this.renderReviewRow(row, entry);
				continue;
			}

			this.renderExecutionRow(row, entry);
		}
	}

	private renderReviewRow(row: HTMLElement, entry: SyncPlanEntry) {
		if (entry.selectionLocked) {
			row.classList.add("is-locked");
			if (entry.selectionLockedReason) {
				row.setAttribute("title", entry.selectionLockedReason);
			}
		}

		const toggleWrap = createChild(row, "div");
		toggleWrap.classList.add("keepsidian-sync-plan-row-toggle");
		const toggle = createChild(toggleWrap, "input");
		toggle.type = "checkbox";
		toggle.checked = entry.selected;
		toggle.disabled = !entry.selectable || entry.selectionLocked || this.isGeneratingReview;
		if (entry.selectionLockedReason) {
			toggle.title = entry.selectionLockedReason;
		}
		toggle.addEventListener("change", () => {
			entry.selected = toggle.checked;
			if (this.preparedPlan) {
				this.preparedPlan.plan.selectedCount = this.preparedPlan.plan.entries.filter(
					(candidate) => candidate.selectable && candidate.selected
				).length;
			}
			void this.refreshUI();
		});

		const body = createChild(row, "div");
		body.classList.add("keepsidian-sync-plan-row-body");
		this.renderEntryBody(body, entry, entry.label);
	}

	private renderExecutionRow(row: HTMLDivElement, entry: SyncPlanEntry) {
		if (!this.executionSnapshot) {
			return;
		}
		const state = this.executionSnapshot.entryStates.get(entry.id) ?? "pending";
		row.classList.add(`is-${state}`);
		const statusEl = createChild(row, "div");
		statusEl.classList.add("keepsidian-sync-plan-row-status");
		const statusSymbolEl = createChild(statusEl, "span", {
			text:
				state === "done" || state === "instant" ? "✓" : state === "failed" ? "!" : state === "unchecked" ? "–" : "…",
		});

		const body = createChild(row, "div");
		body.classList.add("keepsidian-sync-plan-row-body");
		const badgeEl = this.renderEntryBody(body, entry, getRuntimeStatusLabel(entry, state));
		this.executionRowRefs.set(entry.id, { row, statusSymbolEl, badgeEl });
	}

	private updateExecutionRowInPlace(entryId: string) {
		if (!this.executionSnapshot) {
			return;
		}
		const refs = this.executionRowRefs.get(entryId);
		if (!refs) {
			return;
		}
		const entry = this.executionSnapshot.plan.entries.find((candidate) => candidate.id === entryId);
		if (!entry) {
			return;
		}
		const state = this.executionSnapshot.entryStates.get(entryId) ?? "pending";
		refs.row.classList.remove("is-pending", "is-done", "is-failed", "is-unchecked", "is-instant");
		refs.row.classList.add(`is-${state}`);
		refs.statusSymbolEl.textContent =
			state === "done" || state === "instant" ? "✓" : state === "failed" ? "!" : state === "unchecked" ? "–" : "…";
		refs.badgeEl.textContent = getRuntimeStatusLabel(entry, state);
	}

	private renderEntryBody(body: HTMLElement, entry: SyncPlanEntry, badgeText: string): HTMLSpanElement {
		const titleLine = createChild(body, "div");
		titleLine.classList.add("keepsidian-sync-plan-row-title-line");
		const title = createChild(titleLine, "div", { text: entry.title });
		title.classList.add("keepsidian-sync-plan-row-title");
		const badge = createChild(titleLine, "span", { text: badgeText });
		badge.classList.add("keepsidian-sync-plan-row-badge");
		const path = createChild(body, "div", { text: entry.path });
		path.classList.add("keepsidian-sync-plan-row-path");
		if (entry.meta?.detail) {
			const detail = createChild(body, "div", { text: entry.meta.detail });
			detail.classList.add("keepsidian-sync-plan-row-detail");
		}
		return badge;
	}

	private getFilteredEntries(surface: "review" | "running" | "result"): SyncPlanEntry[] {
		const entries =
			surface === "review" ? (this.preparedPlan?.plan.entries ?? []) : (this.executionSnapshot?.plan.entries ?? []);
		if (this.reviewFilterKey === "notes") {
			return entries;
		}
		if (surface !== "review" && this.reviewFilterKey === "unchecked") {
			return entries.filter((entry) => this.executionSnapshot?.entryStates.get(entry.id) === "unchecked");
		}
		return entries.filter((entry) => getChipKeyForEntry(entry) === this.reviewFilterKey);
	}

	private getChipRenderStates(surface: "review" | "running" | "result"): ChipRenderState[] {
		return surface === "review" ? this.getReviewChipStates() : this.getExecutionChipStates();
	}

	private getReviewChipStates(): ChipRenderState[] {
		if (!this.preparedPlan) {
			return [];
		}
		const counts = new Map<ChipKey, number>();
		counts.set("notes", this.preparedPlan.plan.entries.length);
		for (const entry of this.preparedPlan.plan.entries) {
			const key = getChipKeyForEntry(entry);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return CHIP_ORDER.filter((key) => (counts.get(key) ?? 0) > 0 || key === "notes").map((key) => ({
			key,
			label: getReviewChipLabel(key),
			count: counts.get(key) ?? 0,
			isActive: this.reviewFilterKey === key,
		}));
	}

	private getExecutionChipStates(): ChipRenderState[] {
		if (!this.executionSnapshot) {
			return [];
		}
		const denominators = new Map<ChipKey, number>();
		const numerators = new Map<ChipKey, number>();
		const entries = this.executionSnapshot.plan.entries;
		const selectedEntries = entries.filter((entry) => entry.selectable && entry.selected);
		const supplementalEntries = entries.filter((entry) => !entry.selectable);
		denominators.set("notes", selectedEntries.length);
		numerators.set("notes", 0);

		for (const entry of selectedEntries) {
			const key = getChipKeyForEntry(entry);
			denominators.set(key, (denominators.get(key) ?? 0) + 1);
			const state = this.executionSnapshot.entryStates.get(entry.id) ?? "pending";
			if (state === "done" || state === "failed" || state === "instant") {
				numerators.set(key, (numerators.get(key) ?? 0) + 1);
				numerators.set("notes", (numerators.get("notes") ?? 0) + 1);
			}
		}

		for (const entry of supplementalEntries) {
			const key = getChipKeyForEntry(entry);
			const state = this.executionSnapshot.entryStates.get(entry.id) ?? "pending";
			denominators.set(key, (denominators.get(key) ?? 0) + 1);
			if (state === "done" || state === "failed" || state === "instant") {
				numerators.set(key, (numerators.get(key) ?? 0) + 1);
			}
		}

		const uncheckedCount = entries.filter(
			(entry) => this.executionSnapshot?.entryStates.get(entry.id) === "unchecked"
		).length;
		if (uncheckedCount > 0) {
			denominators.set("unchecked", uncheckedCount);
			numerators.set("unchecked", uncheckedCount);
		}

		return CHIP_ORDER.filter((key) => (denominators.get(key) ?? 0) > 0 || key === "notes").map((key) => ({
			key,
			label: getExecutionChipLabel(key),
			numerator: numerators.get(key) ?? 0,
			denominator: denominators.get(key) ?? 0,
			isActive: this.reviewFilterKey === key,
		}));
	}

	private getExecutionHandledCount(): number {
		if (!this.executionSnapshot) {
			return 0;
		}
		let handledCount = 0;
		for (const entry of this.executionSnapshot.plan.entries) {
			if (!entry.selectable || !entry.selected) {
				continue;
			}
			const state = this.executionSnapshot.entryStates.get(entry.id);
			if (state === "done" || state === "failed" || state === "instant") {
				handledCount += 1;
			}
		}
		return handledCount;
	}

	private getExecutionSelectedCount(): number {
		if (!this.executionSnapshot) {
			return 0;
		}
		return this.executionSnapshot.plan.entries.filter((entry) => entry.selectable && entry.selected).length;
	}

	private createActionButton(
		container: HTMLElement,
		label: string,
		onClick: () => void | Promise<void>
	): HTMLButtonElement {
		const button = createChild(container, "button", { text: label });
		button.type = "button";
		button.classList.add("keepsidian-modal-action");
		button.addEventListener("click", () => {
			void onClick();
		});
		return button;
	}
}
