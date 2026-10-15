import * as obsidian from "obsidian";
import { createTranslator } from "./index";
import type { MessageKey, MessageParameters } from "./types";

export type LanguagePreference = "system" | "en" | "zh" | "ru" | "de";
export interface UiLanguageSettings {
	language?: LanguagePreference;
	useDraftTranslations?: boolean;
}

// One plugin instance per Obsidian vault/window. This changes presentation only.
let readSettings: () => UiLanguageSettings = () => ({});
let cachedKey = "";
let cachedTranslator = createTranslator();
const listeners = new Set<() => void>();
let notifiedLocale = "en";

export function onUiLanguageChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function refreshUiLanguage(): void {
	const locale = getUiTranslator().locale;
	if (locale === notifiedLocale) return;
	notifiedLocale = locale;
	for (const listener of listeners) listener();
}

export function bindUiLanguage(settings: () => UiLanguageSettings): () => void {
	readSettings = settings;
	cachedKey = "";
	return () => {
		if (readSettings === settings) {
			readSettings = () => ({});
			cachedKey = "";
		}
	};
}

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
	return value === "en" || value === "zh" || value === "ru" || value === "de" ? value : "system";
}

export function getAppLanguage(): string {
	try {
		return typeof obsidian.getLanguage === "function" ? obsidian.getLanguage() : "en";
	} catch {
		return "en";
	}
}

export function getUiTranslator() {
	const settings = readSettings();
	const preference = normalizeLanguagePreference(settings.language);
	const language = preference === "system" ? getAppLanguage() : preference;
	const includeDrafts = settings.useDraftTranslations === true;
	const key = `${language}:${includeDrafts}`;
	if (key !== cachedKey) {
		cachedTranslator = createTranslator(language, { includeDrafts });
		cachedKey = key;
	}
	return cachedTranslator;
}

export function t(key: MessageKey, parameters?: MessageParameters): string {
	return getUiTranslator().t(key, parameters);
}

export function formatUiDateTime(value: number | Date): string {
	// Language is not a regional preference. Preserve the user's system date order/timezone.
	return new Date(value).toLocaleString();
}
