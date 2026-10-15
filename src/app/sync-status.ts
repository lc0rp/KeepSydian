import type { LastSyncSummary } from "../types/keepsidian-plugin-settings";
import { t, formatUiDateTime } from "../lang/ui";

function formatCount(summary: LastSyncSummary): string {
	return typeof summary.totalNotes === "number" && summary.totalNotes > 0
		? t("sync.noteRatio", { processed: summary.processedNotes, total: summary.totalNotes })
		: t("sync.notes", { count: summary.processedNotes });
}
export function formatStatusBarText(summary: LastSyncSummary | null): string {
	if (!summary) return t("sync.last.never");
	const status = summary.status ?? (summary.success ? "success" : "failed");
	if (status === "canceled") return t("sync.last.canceled");
	if (status === "failed") return t("sync.last.failed");
	if (status === "warning") return t("sync.last.warning");
	return t("sync.last.count", { count: formatCount(summary) });
}
export function formatStatusBarTooltip(summary: LastSyncSummary | null): string {
	if (!summary) return t("sync.notYet");
	const time = Number.isFinite(summary.timestamp) ? formatUiDateTime(summary.timestamp) : t("sync.unknownTime");
	const status = summary.status ?? (summary.success ? "success" : "failed");
	const statusText =
		status === "success"
			? t("sync.success")
			: status === "canceled"
				? t("sync.canceled")
				: status === "warning"
					? t("sync.last.warning")
					: t("sync.failedSentence");
	const mode = t(
		summary.mode === "push"
			? "sync.mode.upload"
			: summary.mode === "two-way"
				? "sync.mode.twoWay"
				: "sync.mode.download"
	);
	const parameters = { status: `${mode} · ${statusText}`, time, notes: formatCount(summary) };
	return summary.status === "warning"
		? t("sync.warningSummary", {
				...parameters,
				warnings: t("sync.attachmentWarnings", { count: summary.attachmentWarnings ?? 0 }),
			})
		: t("sync.summary", parameters);
}
export function formatModalSummary(summary: LastSyncSummary | null): string {
	return summary ? formatStatusBarTooltip(summary) : t("sync.noRun");
}
