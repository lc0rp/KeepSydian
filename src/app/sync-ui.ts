import { t } from "../lang/ui";
import { Notice, ProgressBarComponent } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { formatAttemptSummary } from "@app/sync-attempt";
import { formatStatusBarText, formatStatusBarTooltip } from "@app/sync-status";
import type { LastSyncSummary, SyncRunStatus } from "@types";
import { HIDDEN_CLASS } from "@app/ui-constants";

type StatusBarItemElement = HTMLElement & {
	setText?: (text: string) => void;
	createEl?: <K extends keyof HTMLElementTagNameMap>(
		tagName: K,
		options?: { cls?: string | string[]; text?: string }
	) => HTMLElementTagNameMap[K];
};



function getSyncPhaseLabel(plugin: KeepSidianPlugin): string {
	return plugin.currentSyncMode === "push" ? t("sync.mode.upload") : plugin.currentSyncMode === "import" ? t("sync.mode.download") : t("sync.syncing");
}

function hasSetText(element: HTMLElement | null): element is StatusBarItemElement & {
	setText: (text: string) => void;
} {
	return element !== null && typeof (element as StatusBarItemElement).setText === "function";
}

function getNoticeControls(notice: Notice | null): Notice | null {
	return notice;
}

function formatSyncNoticeMessage(processedNotes: number, totalNotes: number | null): string {
	const safeProcessed = Number.isFinite(processedNotes) && processedNotes >= 0 ? Math.floor(processedNotes) : 0;
	const totalLabel = typeof totalNotes === "number" && totalNotes > 0 ? String(totalNotes) : "?";
	return t("sync.noticeProgress", {processed:safeProcessed,total:totalLabel === "?" ? "?" : totalNotes!});
}

function updateProgressNotice(plugin: KeepSidianPlugin) {
	if (!plugin.progressNotice) {
		return;
	}
	getNoticeControls(plugin.progressNotice)?.setMessage(
		formatSyncNoticeMessage(plugin.processedNotes, plugin.totalNotes)
	);
}

function setStatusBarText(plugin: KeepSidianPlugin, text: string) {
	if (plugin.statusTextEl) {
		plugin.statusTextEl.textContent = text;
	} else if (hasSetText(plugin.statusBarItemEl)) {
		plugin.statusBarItemEl.setText(text);
	}
}

function setStatusBarTooltip(plugin: KeepSidianPlugin, tooltip: string) {
	if (plugin.statusBarItemEl) {
		plugin.statusBarItemEl.setAttribute("title", tooltip);
	}
}

function createStatusElement<K extends keyof HTMLElementTagNameMap>(
	parent: HTMLElement,
	tagName: K
): HTMLElementTagNameMap[K] {
	const maybeObsidianParent = parent as StatusBarItemElement;
	if (typeof maybeObsidianParent.createEl === "function") {
		return maybeObsidianParent.createEl(tagName);
	}
	throw new Error("Cannot create child element without a parent with createEl method");
}

function ensureStatusBarElements(plugin: KeepSidianPlugin) {
	if (!plugin.statusBarItemEl) {
		plugin.statusBarItemEl = plugin.addStatusBarItem();
		plugin.statusBarItemEl.addEventListener("click", (evt: MouseEvent) => {
			evt.preventDefault();
			plugin.openSyncCenter();
		});
		plugin.statusBarItemEl.classList?.add("keepsidian-status");
	}

	if (!plugin.statusTextEl) {
		plugin.statusTextEl = createStatusElement(plugin.statusBarItemEl, "span");
		plugin.statusTextEl.className = "keepsidian-status-text";
	}

	if (!plugin.progressContainerEl) {
		plugin.progressContainerEl = createStatusElement(plugin.statusBarItemEl, "div");
		plugin.progressContainerEl.className = "keepsidian-progress indeterminate";
	}
	if (!plugin.progressBar && plugin.progressContainerEl) {
		plugin.progressBar = new ProgressBarComponent(plugin.progressContainerEl);
		plugin.progressBar.setValue(0);
	}
}

function getSummary(plugin: KeepSidianPlugin): LastSyncSummary | null {
	return plugin.lastSyncSummary ?? null;
}

function clearScheduledSyncUiHides(plugin: KeepSidianPlugin) {
	if (plugin.progressNoticeHideTimeout) {
		window.clearTimeout(plugin.progressNoticeHideTimeout);
		plugin.progressNoticeHideTimeout = null;
	}
	if (plugin.progressBarHideTimeout) {
		window.clearTimeout(plugin.progressBarHideTimeout);
		plugin.progressBarHideTimeout = null;
	}
}

export function initializeStatusBar(plugin: KeepSidianPlugin) {
	ensureStatusBarElements(plugin);
	updateStatusBarSummary(plugin);
	if (plugin.progressContainerEl) {
		plugin.progressContainerEl.classList.add(HIDDEN_CLASS);
		plugin.progressContainerEl.classList.remove("complete", "failed");
		plugin.progressContainerEl.classList.add("indeterminate");
	}
	if (plugin.progressBar) {
		plugin.progressBar.setValue(0);
	}
}

export function updateStatusBarSummary(plugin: KeepSidianPlugin) {
	ensureStatusBarElements(plugin);
	const summary = getSummary(plugin);
	const attempt = plugin.settings.lastSyncAttempt;
	if (
		attempt &&
		(!summary ||
			attempt.updatedAt > summary.timestamp ||
			(attempt.updatedAt === summary.timestamp && attempt.outcome !== "success"))
	) {
		setStatusBarText(plugin, formatAttemptSummary(attempt));
		setStatusBarTooltip(plugin, formatAttemptSummary(attempt));
		return;
	}
	setStatusBarText(plugin, formatStatusBarText(summary));
	setStatusBarTooltip(plugin, formatStatusBarTooltip(summary));
}

export function startSyncUI(plugin: KeepSidianPlugin) {
	plugin.processedNotes = 0;
	plugin.totalNotes = null;
	ensureStatusBarElements(plugin);
	clearScheduledSyncUiHides(plugin);

	if (plugin.progressNotice) {
		getNoticeControls(plugin.progressNotice)?.hide();
		plugin.progressNotice = null;
	}

	if (plugin.progressContainerEl) {
		plugin.progressContainerEl.classList.remove(HIDDEN_CLASS);
		plugin.progressContainerEl.classList.remove("complete", "failed");
		if (!plugin.progressContainerEl.classList.contains("indeterminate")) {
			plugin.progressContainerEl.classList.add("indeterminate");
		}
	}
	plugin.progressBar?.setValue(0);

	setStatusBarText(plugin, `${getSyncPhaseLabel(plugin)}: 0/?`);
	setStatusBarTooltip(plugin, `KeepSidian ${getSyncPhaseLabel(plugin).toLowerCase()}...`);
	plugin.progressModal?.setProgress(0, undefined);

	plugin.progressNotice = new Notice(formatSyncNoticeMessage(plugin.processedNotes, plugin.totalNotes), 0);
}

export function reportSyncProgress(plugin: KeepSidianPlugin) {
	plugin.processedNotes += 1;
	const total = plugin.totalNotes ?? undefined;
	const text =
		typeof total === "number"
			? `${getSyncPhaseLabel(plugin)}: ${plugin.processedNotes}/${total}`
			: `${getSyncPhaseLabel(plugin)}: ${plugin.processedNotes}`;
	setStatusBarText(plugin, text);
	setStatusBarTooltip(plugin, `KeepSidian ${getSyncPhaseLabel(plugin).toLowerCase()}...`);
	if (plugin.progressContainerEl && plugin.progressBar && typeof total === "number" && total > 0) {
		const pct = Math.max(0, Math.min(100, Math.round((plugin.processedNotes / total) * 100)));
		plugin.progressContainerEl.classList.remove("indeterminate");
		plugin.progressBar.setValue(pct);
	}
	plugin.progressModal?.setProgress(plugin.processedNotes, total);
	updateProgressNotice(plugin);
}

function normalizeSyncRunStatus(status: SyncRunStatus | boolean): SyncRunStatus {
	if (typeof status === "boolean") {
		return status ? "success" : "failed";
	}
	return status;
}

export function finishSyncUI(plugin: KeepSidianPlugin, status: SyncRunStatus | boolean, attachmentWarnings = 0) {
	const normalizedStatus = normalizeSyncRunStatus(status);
	const success = normalizedStatus === "success" || normalizedStatus === "warning";
	clearScheduledSyncUiHides(plugin);
	if (plugin.progressNotice) {
		const noticeControls = getNoticeControls(plugin.progressNotice);
		if (noticeControls) {
			noticeControls.setMessage(
				success
					? normalizedStatus === "warning"
						? t("sync.warningResult",{notes:t("sync.success"),warnings:t("sync.attachmentWarnings",{count:attachmentWarnings})})
						: t("sync.success")
					: normalizedStatus === "canceled"
						? t("sync.canceled")
						: t("sync.failedSentence")
			);
			const delay = success ? 4000 : normalizedStatus === "canceled" ? 6000 : 10000;
			const activeNotice = plugin.progressNotice;
			plugin.progressNoticeHideTimeout = window.setTimeout(() => {
				if (plugin.progressNotice === activeNotice) {
					noticeControls.hide();
					plugin.progressNotice = null;
				}
				plugin.progressNoticeHideTimeout = null;
			}, delay);
		}
	}
	const totalValue = plugin.totalNotes ?? undefined;
	const summary: LastSyncSummary = {
		timestamp: Date.now(),
		processedNotes: plugin.processedNotes,
		totalNotes: typeof totalValue === "number" && totalValue > 0 ? totalValue : null,
		success,
		status: normalizedStatus,
		...(attachmentWarnings > 0 ? { attachmentWarnings } : {}),
		mode: plugin.currentSyncMode ?? "import",
	};
	plugin.lastSyncSummary = summary;
	plugin.settings.lastSyncSummary = summary;
	plugin.currentSyncPhaseLabel = null;
	updateStatusBarSummary(plugin);
	if (plugin.progressContainerEl) {
		plugin.progressContainerEl.toggleClass("complete", success);
		plugin.progressContainerEl.toggleClass("failed", !success);
		plugin.progressBarHideTimeout = window.setTimeout(() => {
			if (plugin.progressContainerEl) {
				plugin.progressContainerEl.classList.add(HIDDEN_CLASS);
			}
			plugin.progressBarHideTimeout = null;
		}, 3000);
	}
	plugin.progressModal?.setComplete(normalizedStatus, plugin.processedNotes, attachmentWarnings);
	plugin.progressModal?.setIdleSummary(summary);
	void Promise.resolve(plugin.saveSettings()).catch(() => {
		new Notice(t("sync.historyFailed"));
	});
}

export function setTotalNotes(plugin: KeepSidianPlugin, total: number) {
	if (typeof total !== "number" || total <= 0) return;
	plugin.totalNotes = total;
	setStatusBarText(plugin, t("sync.countProgress",{label:getSyncPhaseLabel(plugin),processed:plugin.processedNotes,total}));
	setStatusBarTooltip(plugin, t("sync.syncing"));
	if (plugin.progressContainerEl) {
		plugin.progressContainerEl.classList.remove("indeterminate");
	}
	if (plugin.progressBar) {
		const pct = Math.max(0, Math.min(100, Math.round((plugin.processedNotes / total) * 100)));
		plugin.progressBar.setValue(pct);
	}
	plugin.progressModal?.setProgress(plugin.processedNotes, total);
	updateProgressNotice(plugin);
}

export function refreshSyncLanguage(plugin: KeepSidianPlugin) {
 if (plugin.isSyncInProgress()) {
  setStatusBarText(plugin,t("sync.countProgress",{label:getSyncPhaseLabel(plugin),processed:plugin.processedNotes,total:plugin.totalNotes ?? "?"}));
  updateProgressNotice(plugin);
 } else updateStatusBarSummary(plugin);
}
