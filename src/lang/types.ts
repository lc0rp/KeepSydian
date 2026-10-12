import type { en } from "./en-plain-lang";

export type MessageKey = keyof typeof en;
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralMessage = Readonly<Partial<Record<PluralCategory, string>> & { other: string }>;
export type Message = string | PluralMessage;
export type TranslationCatalog = {
	readonly [Key in MessageKey]?: (typeof en)[Key] extends string ? string : PluralMessage;
};
export type Locale = "en" | "zh" | "ru" | "de";
export interface LanguageDefinition {
	readonly locale: Locale;
	readonly name: string;
	readonly status: "source" | "draft" | "reviewed";
	readonly messages: TranslationCatalog;
}
export type MessageParameters = Readonly<Record<string, string | number>>;
