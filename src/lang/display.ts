import { t } from "./ui";
import { en } from "./en-plain-lang";
import type { MessageKey } from "./types";
import type { SyncPlanEntry } from "../types/sync-plan";
import { getEffectiveKeepColorValues, KEEP_COLOR_OPTIONS, type KeepColorValue } from "../types/subscription";

const sourceLabels = new Map<string, MessageKey>(
	(Object.keys(en) as MessageKey[]).flatMap((key) =>
		typeof en[key] === "string" ? [[en[key] as string, key] as [string, MessageKey]] : []
	)
);
/** Only pass plugin-owned labels/reasons, never note titles, paths, or contents. */
export function localizePluginLabel(label: string): string {
	const key = sourceLabels.get(label);
	return key ? t(key) : label;
}

export function planEntryDetail(entry: SyncPlanEntry): string {
	const meta = entry.meta;
	if (meta?.downloadDetails?.length) return meta.downloadDetails.map((code) => t(`download.${code}`)).join(" ");
	if (!meta?.uploadDetail) return meta?.detail ? localizePluginLabel(meta.detail) : "";
	const { pendingMerge, skipReason } = meta.uploadDetail;
	if (skipReason)
		return t(
			skipReason === "unresolved-conflict"
				? "upload.unresolved"
				: skipReason === "up-to-date"
					? "upload.unchanged"
					: "upload.neverConflictCopies"
		);
	const parts: string[] = [];
	if (meta.attachmentCount) parts.push(t("upload.attachments", { count: meta.attachmentCount }));
	if (meta.missingAttachmentCount) parts.push(t("upload.missingAttachments", { count: meta.missingAttachmentCount }));
	if (pendingMerge) parts.push(t("upload.pendingMerge"));
	if (entry.action === "conflict-copy") parts.push(t("upload.conflictCopy"));
	return parts.join(" ");
}

export function colorLabel(value: KeepColorValue): string {
	return t(`colors.${value}`);
}
export function formatKeepColorSummary(values: string[]): string {
	const colors = getEffectiveKeepColorValues(values);
	return colors.length === KEEP_COLOR_OPTIONS.length
		? t("colors.all")
		: colors.length <= 2
			? colors.map(colorLabel).join(", ")
			: t("colors.selected", { count: colors.length });
}
