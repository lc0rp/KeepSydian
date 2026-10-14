import { t } from "./ui";
import { en } from "./en-plain-lang";
import type { MessageKey } from "./types";
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
