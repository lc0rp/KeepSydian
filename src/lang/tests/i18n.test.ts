import { createTranslator, languages, readAppLocale, resolveLocale } from "../index";
import { en } from "../en";
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

	it("previews draft translations with per-key English fallback", () => {
		const { t } = createTranslator("de-AT", { includeDrafts: true });
		expect(t("commands.syncNow")).toBe("Jetzt synchronisieren");
		expect(t("settings.backup.description")).toBe(en["settings.backup.description"]);
		// 21 is singular in Russian but plural in an untranslated English sentence.
		expect(createTranslator("ru", { includeDrafts: true }).t("sync.attachmentWarnings", { count: 21 })).toBe(
			"21 attachment warnings"
		);
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
	const placeholders = (text: string): string[] =>
		[...new Set(text.match(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g) ?? [])].sort();
	const protectedTokens = (text: string): string[] =>
		[...new Set(text.match(/(?<!\{)\{(?:title|(?:now|note)\.[a-z*]+)\}(?!\})/g) ?? [])].sort();

	for (const definition of Object.values(languages)) {
		it(`${definition.locale} contains only known keys, nonempty text, and matching placeholders`, () => {
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
				}
			}
		});
	}

	it("keeps missing translations explicit instead of copying English into draft locales", () => {
		for (const definition of Object.values(languages).filter((language) => language.status === "draft")) {
			expect(Object.keys(definition.messages).length).toBeLessThan(Object.keys(en).length);
			expect(definition.messages["settings.backup.description"]).toBeUndefined();
			for (const [key, message] of Object.entries(definition.messages)) {
				expect(message).not.toEqual(en[key as MessageKey]);
			}
		}
	});
});
