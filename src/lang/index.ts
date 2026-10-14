/// <reference lib="es2018.intl" />
import { en } from "./en-plain-lang";
import { de } from "./de";
import { ru } from "./ru";
import { zh } from "./zh";
import type { LanguageDefinition, Locale, Message, MessageKey, MessageParameters } from "./types";

export const languages: Readonly<Record<Locale, LanguageDefinition>> = {
	en: { locale: "en", name: "English", status: "source", messages: en },
	zh,
	ru,
	de,
};

/** Resolve an Obsidian language code, not the OS/browser language or note content. */
export function resolveLocale(appLanguage: unknown): Locale {
	if (typeof appLanguage !== "string" || !appLanguage.trim()) return "en";
	let tag: string;
	try {
		tag = Intl.getCanonicalLocales(appLanguage.trim().replace(/_/g, "-"))[0].toLowerCase();
	} catch {
		return "en";
	}
	const [base] = tag.split("-");
	if (base === "zh") {
		// Obsidian uses zh for Simplified Chinese. Never map Traditional to Simplified.
		// Script and region occur before variants/extensions/private-use subtags.
		// A later "hans" or "hant" is data, not a script (for example zh-TW-x-hans).
		const parts = tag.split("-");
		const script = /^[a-z]{4}$/.test(parts[1] ?? "") ? parts[1] : undefined;
		const regionCandidate = parts[script ? 2 : 1];
		const region = /^(?:[a-z]{2}|\d{3})$/.test(regionCandidate ?? "") ? regionCandidate : undefined;
		if (script) return script === "hans" ? "zh" : "en";
		return !region || region === "cn" || region === "sg" ? "zh" : "en";
	}
	return base === "de" || base === "ru" ? base : "en";
}

/** getLanguage is public only since Obsidian 1.8.7. Inject a guarded reader later. */
export function readAppLocale(readLanguage?: () => unknown): Locale {
	try {
		return resolveLocale(readLanguage?.());
	} catch {
		return "en";
	}
}

function hasText(message: Message | undefined): message is Message {
	return typeof message === "string" ? message.trim().length > 0 : Boolean(message?.other.trim());
}

/**
 * Foundation only: no production callers yet. Drafts require explicit preview opt-in.
 * Results are plain text for textContent/createEl({text}), never HTML.
 */
export function createTranslator(appLanguage?: unknown, options: { includeDrafts?: boolean } = {}) {
	const requestedLocale = resolveLocale(appLanguage);
	const candidate = languages[requestedLocale];
	const locale = candidate.status === "draft" && !options.includeDrafts ? "en" : requestedLocale;
	const catalog = languages[locale].messages;

	const t = (key: MessageKey, parameters: MessageParameters = {}): string => {
		if (!Object.prototype.hasOwnProperty.call(en, key)) {
			throw new TypeError(`Unknown message key: ${key}`);
		}
		const translated = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
		const useTranslation = hasText(translated);
		const message: Message = useTranslation ? translated : en[key];
		// A fallback sentence must also use English grammar and number formatting.
		const messageLocale = useTranslation ? locale : "en";
		let template: string;
		if (typeof message === "string") {
			template = message;
		} else {
			const count = parameters.count;
			if (typeof count !== "number" || !Number.isFinite(count)) {
				throw new TypeError(`A finite numeric count is required for ${key}`);
			}
			const form = new Intl.PluralRules(messageLocale).select(count);
			template = message[form] || message.other;
		}
		return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (placeholder, name: string) => {
			if (!Object.prototype.hasOwnProperty.call(parameters, name)) return placeholder;
			const value = parameters[name];
			return typeof value === "number" ? new Intl.NumberFormat(messageLocale).format(value) : value;
		});
	};
	return {
		locale,
		t,
		formatNumber: (value: number, formatOptions?: Intl.NumberFormatOptions) =>
			new Intl.NumberFormat(locale, formatOptions).format(value),
		formatDateTime: (value: Date | number, formatOptions?: Intl.DateTimeFormatOptions) =>
			new Intl.DateTimeFormat(locale, formatOptions).format(value),
	};
}
