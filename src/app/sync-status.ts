import type { LastSyncSummary, SyncMode, SyncRunStatus } from "../types/keepsidian-plugin-settings";

function formatCount(summary: LastSyncSummary, includeNotesWord = true): string {
	const { processedNotes, totalNotes } = summary;
	const base =
		typeof totalNotes === "number" && totalNotes > 0 ? `${processedNotes}/${totalNotes}` : `${processedNotes}`;
	if (!includeNotesWord) {
		return base;
	}
	const noteLabel = processedNotes === 1 && totalNotes !== 1 ? "note" : "notes";
	return `${base} ${noteLabel}`;
}

function describeMode(mode: SyncMode): string {
	switch (mode) {
		case "two-way":
			return "two-way sync";
		case "push":
			return "upload";
		case "import":
		default:
			return "import";
	}
}

function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "unknown time";
	}
	try {
		return date.toLocaleString();
	} catch {
		return date.toISOString();
	}
}

function getSummaryStatus(summary: LastSyncSummary): SyncRunStatus {
	return summary.status ?? (summary.success ? "success" : "failed");
}

function formatAttachmentWarnings(summary: LastSyncSummary): string {
	const count = summary.attachmentWarnings ?? 0;
	return `${count} attachment warning${count === 1 ? "" : "s"}`;
}

export function formatStatusBarText(summary: LastSyncSummary | null): string {
	if (!summary) {
		return "Last sync: never";
	}
	const status = getSummaryStatus(summary);
	if (status === "canceled") {
		return "Last sync canceled";
	}
	if (status === "failed") {
		return "Last sync failed";
	}
	if (status === "warning") {
		return "Last sync completed with warnings";
	}
	return typeof summary.totalNotes === "number" && summary.totalNotes > 0
		? `Last synced: ${formatCount(summary, false)}`
		: `Last synced: ${formatCount(summary)}`;
}

export function formatStatusBarTooltip(summary: LastSyncSummary | null): string {
	if (!summary) {
		return "KeepSidian has not synced yet.";
	}
	const formattedTime = formatTimestamp(summary.timestamp);
	const status = getSummaryStatus(summary);
	if (status === "canceled") {
		const count = formatCount(summary);
		return `KeepSidian last sync was canceled: ${formattedTime} (processed ${count}).`;
	}
	if (status === "failed") {
		const count = formatCount(summary);
		return `KeepSidian last sync failed: ${formattedTime} (processed ${count}).`;
	}
	if (status === "warning") {
		const count = formatCount(summary);
		return `KeepSidian last sync completed with ${formatAttachmentWarnings(summary)}: ${formattedTime} (processed ${count}).`;
	}
	const count = formatCount(summary);
	return `KeepSidian last synced: ${formattedTime} (${count}).`;
}

export function formatModalSummary(summary: LastSyncSummary | null): string {
	if (!summary) {
		return "No sync has been run yet.";
	}
	const formattedTime = formatTimestamp(summary.timestamp);
	const modeText = describeMode(summary.mode);
	const count = formatCount(summary);
	const status = getSummaryStatus(summary);
	if (status === "success") {
		return `Last ${modeText} completed on ${formattedTime}: Synced ${count}.`;
	}
	if (status === "warning") {
		return `Last ${modeText} completed on ${formattedTime}: Synced ${count} with ${formatAttachmentWarnings(summary)}.`;
	}
	if (status === "canceled") {
		return `Last ${modeText} attempt on ${formattedTime} was canceled after ${count}.`;
	}
	return `Last ${modeText} attempt on ${formattedTime} failed after ${count}.`;
}
