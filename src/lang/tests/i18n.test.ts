import { createTranslator, languages, readAppLocale, resolveLocale } from "../index";
import { en } from "../en-plain-lang";
import { en as originalEnglish } from "../en";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, MessageKey } from "../types";
import { resolveNotePath } from "../../services/note-path-resolver";
import { DEFAULT_SETTINGS } from "../../types/keepsidian-plugin-settings";

describe("language catalog foundation", () => {
	it.each([
		[undefined, "en"],
		[null, "en"],
		[42, "en"],
		["", "en"],
		["not a locale", "en"],
		["en-GB", "en"],
		[" DE_de ", "de"],
		["ru-RU", "ru"],
		["es-MX", "en"],
		["zh", "zh"],
		["zh-CN", "zh"],
		["zh-SG", "zh"],
		["zh-Hans", "zh"],
		["zh-Hans-TW", "zh"],
		["zh-Hant", "en"],
		["zh-TW", "en"],
		["zh-HK", "en"],
		["zh-MO", "en"],
		["zh-Hant-CN", "en"],
		["zh-TW-x-hans", "en"],
		["zh-TW-u-nu-hans", "en"],
		["zh-HK-x-hans", "en"],
		["zh-MO-x-hans", "en"],
		["zh-Hans-CN-x-hant", "zh"],
		["zh-Hans-CN-u-nu-hant", "zh"],
		["zh-Hant-CN-x-hans", "en"],
		["zh-CN-u-nu-latn", "zh"],
		["zh-CN-u-co-pinyin", "zh"],
		["zh-SG-u-co-pinyin", "zh"],
		["zh-u-co-pinyin", "zh"],
		["zh-x-hant", "zh"],
		["zh-Latn-CN-x-hans", "en"],
		["zh-AU-x-hans", "en"],
		["ar", "en"],
	])("resolves %p to %s", (input, expected) => {
		expect(resolveLocale(input)).toBe(expected);
	});

	it("supports an absent or failing language API on older Obsidian", () => {
		expect(readAppLocale()).toBe("en");
		expect(
			readAppLocale(() => {
				throw new Error("unavailable");
			})
		).toBe("en");
		expect(readAppLocale(() => "de-DE")).toBe("de");
	});

	it("keeps unreviewed drafts disabled by default", () => {
		for (const locale of ["zh", "ru", "de"]) {
			const translator = createTranslator(locale);
			expect(translator.locale).toBe("en");
			expect(translator.t("commands.syncNow")).toBe("Sync now");
		}
	});

	it("previews draft translations", () => {
		const { t } = createTranslator("de-AT", { includeDrafts: true });
		expect(t("commands.syncNow")).toBe("Jetzt synchronisieren");
		expect(t("settings.backup.description")).toBe(languages.de.messages["settings.backup.description"]);
	});

	it("falls back to revised English text, grammar and formatting for a missing translation", () => {
		// Model a future untranslated key without leaving today's drafts incomplete.
		const replacement = jest.replaceProperty(languages, "ru", { ...languages.ru, messages: {} });
		try {
			const { t } = createTranslator("ru", { includeDrafts: true });
			expect(t("settings.backup.description")).toBe(en["settings.backup.description"]);
			// 21 is singular in Russian but plural in an untranslated English sentence.
			expect(t("sync.attachmentWarnings", { count: 21 })).toBe("21 warnings");
			expect(t("sync.attachmentWarnings", { count: 1000 })).toBe("1,000 warnings");
		} finally {
			replacement.restore();
		}
	});

	it.each([
		[0, "0 notes"],
		[1, "1 note"],
		[2, "2 notes"],
	])("uses English cardinal forms for %s", (count, expected) => {
		expect(createTranslator().t("sync.notes", { count })).toBe(expected);
	});

	it.each([
		[0, "0 заметок"],
		[1, "1 заметка"],
		[2, "2 заметки"],
		[5, "5 заметок"],
		[21, "21 заметка"],
		[1.5, "1,5 заметки"],
	])("uses Russian cardinal forms for %s", (count, expected) => {
		expect(createTranslator("ru", { includeDrafts: true }).t("sync.notes", { count })).toBe(expected);
	});

	it("uses Chinese other and German one/other forms", () => {
		const zh = createTranslator("zh", { includeDrafts: true });
		const de = createTranslator("de", { includeDrafts: true });
		for (const count of [0, 1, 2]) expect(zh.t("sync.notes", { count })).toBe(`${count} 条笔记`);
		expect(de.t("sync.notes", { count: 1 })).toBe("1 Notiz");
		expect(de.t("sync.notes", { count: 1000 })).toBe("1.000 Notizen");
	});

	it.each([
		["en", 1, "1 warning"],
		["en", 2, "2 warnings"],
		["zh", 0, "0 条警告"],
		["zh", 1, "1 条警告"],
		["de", 1, "1 Warnung"],
		["de", 2, "2 Warnungen"],
		["ru", 0, "0 предупреждений"],
		["ru", 1, "1 предупреждение"],
		["ru", 2, "2 предупреждения"],
		["ru", 5, "5 предупреждений"],
		["ru", 21, "21 предупреждение"],
		["ru", 1.5, "1,5 предупреждения"],
	])("pluralizes combined attachment and AI warnings in %s for %s", (locale, count, expected) => {
		expect(createTranslator(locale, { includeDrafts: true }).t("sync.attachmentWarnings", { count })).toBe(expected);
	});

	it.each(["toString", "constructor", "__proto__", "nope.key"])("rejects unknown key %s clearly", (key) => {
		expect(() => createTranslator().t(key as MessageKey)).toThrow(`Unknown message key: ${key}`);
	});

	it("falls back to English rather than an inherited catalog entry", () => {
		const messages = Object.create({ "commands.syncNow": "inherited text" }) as typeof languages.ru.messages;
		const replacement = jest.replaceProperty(languages, "ru", { ...languages.ru, messages });
		try {
			expect(createTranslator("ru", { includeDrafts: true }).t("commands.syncNow")).toBe("Sync now");
		} finally {
			replacement.restore();
		}
	});

	it("requires a numeric count and preserves visibly missing interpolation values", () => {
		const { t } = createTranslator();
		expect(() => t("sync.notes")).toThrow(TypeError);
		expect(() => t("sync.notes", { count: "2" })).toThrow(TypeError);
		expect(() => t("sync.notes", { count: NaN })).toThrow(TypeError);
		expect(t("errors.filePath")).toBe("File error at {{path}}");
	});

	it("interpolates once as plain text without treating values or filename tokens as templates", () => {
		const { t } = createTranslator();
		const path = "<vault>/中文/Привет/مرحبا/$&/{{status}}.md";
		const message = t("errors.filePath", { path, status: 500 });
		expect(message).toBe(`File error at ${path}`);
		const element = document.createElement("div");
		element.textContent = message;
		expect(element.children).toHaveLength(0);
		expect(t("settings.filename.description", { title: "must not substitute" })).toContain("{title}-{note.year}");
	});

	it("formats presentation values explicitly without changing machine values", () => {
		const { formatNumber, formatDateTime } = createTranslator("de", { includeDrafts: true });
		expect(formatNumber(1234.5)).toBe("1.234,5");
		const date = new Date("2026-10-12T12:00:00Z");
		expect(formatDateTime(date, { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" })).toBe(
			"12.10.2026"
		);
		expect(date.toISOString()).toBe("2026-10-12T12:00:00.000Z");
	});

	it("keeps Unicode note paths and stable date tokens independent of the selected UI locale", () => {
		const note = { title: "中文 Привет مرحبا café", created: new Date(2026, 9, 12, 12) };
		const settings = {
			...DEFAULT_SETTINGS,
			saveLocation: "Keep/{note.year}",
			noteFileNamePattern: "{title}-{note.date}",
		};
		for (const locale of ["en", "de", "ru", "zh"]) {
			createTranslator(locale, { includeDrafts: true }).t("sync.notes", { count: 2 });
			expect(resolveNotePath({}, settings, note)).toBe("Keep/2026/中文 Привет مرحبا café-2026-10-12.md");
		}
	});
});

describe("catalog integrity", () => {
	const forms = (message: Message): string[] => (typeof message === "string" ? [message] : Object.values(message));
	const placeholders = (text: string): string[] => (text.match(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g) ?? []).sort();
	const protectedTokens = (text: string): string[] =>
		(text.match(/(?<!\{)\{(?:title|(?:now|note)\.[a-z*]+)\}(?!\})/g) ?? []).sort();
	const protectedLiterals = (text: string): string[] =>
		(text.match(/Google Keep|KeepSidian|Obsidian|GitHub|KIM|OAuth|2–3|Example@gmail\.com/g) ?? []).sort();

	it("covers every cardinal plural category in each current catalog", () => {
		for (const definition of Object.values(languages)) {
			const categories = new Intl.PluralRules(definition.locale).resolvedOptions().pluralCategories;
			for (const message of Object.values(definition.messages)) {
				if (typeof message === "string") continue;
				for (const category of categories) expect(message[category]?.trim()).toBeTruthy();
			}
		}
	});

	it("keeps two-way sync discoverable and consent explicit", () => {
		expect(en["commands.twoWaySync"]).toMatch(/two-way sync/i);
		expect(en["settings.optIn.name"]).toMatch(/opt in to two-way sync/i);
	});

	it("explains the ASCII comma required by the existing filter parser in Chinese", () => {
		for (const key of ["supporter.include.description", "supporter.exclude.description"] as const) {
			expect(languages.zh.messages[key]).toContain("英文逗号（,）");
		}
	});

	it("preserves the original English file byte for byte", () => {
		const bytes = readFileSync(join(__dirname, "../en.ts"));
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			"bd5639436acbd71f511958f56387176772ac96c588860a59bb54974e47889c58"
		);
	});

	it("preserves English keys, message shapes, placeholders, filename syntax and factual literals", () => {
		expect(Object.keys(en).sort()).toEqual(Object.keys(originalEnglish).sort());
		for (const key of Object.keys(en) as MessageKey[]) {
			const source = originalEnglish[key];
			const revised = en[key];
			expect(typeof revised).toBe(typeof source);
			if (typeof revised !== "string") expect(Object.keys(revised)).toEqual(Object.keys(source));
			const originals = forms(source);
			for (const [i, text] of forms(revised).entries()) {
				expect(placeholders(text)).toEqual(placeholders(originals[i]));
				expect(protectedTokens(text)).toEqual(protectedTokens(originals[i]));
				expect(protectedLiterals(text)).toEqual(protectedLiterals(originals[i]));
			}
		}
	});

	for (const definition of Object.values(languages)) {
		it(`${definition.locale} contains only known keys, nonempty text, and matching placeholders`, () => {
			expect(Object.keys(definition.messages).sort()).toEqual(Object.keys(en).sort());
			for (const [key, message] of Object.entries(definition.messages)) {
				expect(Object.prototype.hasOwnProperty.call(en, key)).toBe(true);
				const source = en[key as MessageKey];
				expect(typeof message).toBe(typeof source);
				const sourceText = forms(source)[0];
				if (typeof message !== "string") expect(message.other.trim()).not.toBe("");
				for (const text of forms(message)) {
					expect(text.trim()).not.toBe("");
					expect(placeholders(text)).toEqual(placeholders(sourceText));
					expect(protectedTokens(text)).toEqual(protectedTokens(sourceText));
					expect(protectedLiterals(text)).toEqual(protectedLiterals(sourceText));
				}
			}
		});
	}

	it("preserves the literal filename examples in every catalog", () => {
		for (const definition of Object.values(languages)) {
			const folder = definition.messages["settings.saveLocation.description"];
			const filename = definition.messages["settings.filename.description"];
			for (const example of [
				"{now.date}",
				"{note.year}",
				"/KeepSidian/{now.year}/{note.month}-{note.day}",
				"/path/to/daily notes",
			]) {
				expect(folder).toContain(example);
			}
			for (const example of ["{title}-{now.date}", "{title}-{note.year}"]) expect(filename).toContain(example);
		}
	});

	it("keeps all 138 translations draft and avoids English placeholders except the literal email example", () => {
		for (const definition of Object.values(languages).filter((language) => language.status === "draft")) {
			expect(Object.keys(definition.messages)).toHaveLength(138);
			for (const [key, message] of Object.entries(definition.messages)) {
				if (key === "settings.email.placeholder") {
					expect(message).toBe(en[key]);
					continue;
				}
				expect(message).not.toEqual(en[key as MessageKey]);
			}
		}
	});
});
