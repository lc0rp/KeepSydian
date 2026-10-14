import * as obsidian from "obsidian";
import { bindUiLanguage, getUiTranslator, onUiLanguageChanged, refreshUiLanguage, t } from "../ui";
import { createTranslator } from "../index";
import { resolveLoadedSettings } from "../../types/keepsidian-plugin-settings";
import { deletionReviewSummary } from "../../ui/modals/deletion-review";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "../../test-utils/fixtures/sync-plan";

describe("UI language preferences", () => {
	let cleanup: () => void;
	afterEach(() => {
		cleanup?.();
	});
	it("follows Obsidian, requires draft consent, and falls back for unsupported scripts", () => {
		let appLanguage = "ru";
		Object.defineProperty(obsidian, "getLanguage", { configurable: true, value: () => appLanguage });
		const settings = { language: "system" as const, useDraftTranslations: false };
		cleanup = bindUiLanguage(() => settings);
		expect(getUiTranslator().locale).toBe("en");
		settings.useDraftTranslations = true;
		expect(t("common.cancel")).toBe("Отмена");
		appLanguage = "zh-Hant";
		expect(getUiTranslator().locale).toBe("en");
		appLanguage = "de-DE";
		expect(getUiTranslator().locale).toBe("de");
	});
	it("refreshes listeners once per effective locale and cleans them up", () => {
		const settings = { language: "en" as "en" | "de", useDraftTranslations: true };
		cleanup = bindUiLanguage(() => settings);
		refreshUiLanguage();
		const changed = jest.fn(),
			unsubscribe = onUiLanguageChanged(changed);
		settings.language = "de";
		refreshUiLanguage();
		refreshUiLanguage();
		expect(changed).toHaveBeenCalledTimes(1);
		unsubscribe();
		settings.language = "en";
		refreshUiLanguage();
		expect(changed).toHaveBeenCalledTimes(1);
	});
	it("normalizes persisted unknown values without opting into drafts", () => {
		const settings = resolveLoadedSettings({ language: "unknown", useDraftTranslations: "true" } as never);
		expect(settings.language).toBe("system");
		expect(settings.useDraftTranslations).toBe(false);
	});
	it("keeps destructive action data stable while translating its explanation", () => {
		const plan = createPreparedSyncPlanFixture("push", "upload", [
			createSyncPlanEntryFixture("delete", "No longer in sync folder", {
				title: "Delete",
				path: "中文/Русский.md",
				stage: "upload",
			}),
		]).plan;
		const before = JSON.stringify(plan);
		cleanup = bindUiLanguage(() => ({ language: "de", useDraftTranslations: true }));
		expect(deletionReviewSummary(plan)).toContain("Google Keep-Papierkorb");
		expect(deletionReviewSummary(plan)).toContain("niemals endgültig");
		expect(JSON.stringify(plan)).toBe(before);
	});
	it("uses English plural fallback when an older runtime lacks PluralRules", () => {
		const original = Intl.PluralRules;
		try {
			Object.defineProperty(Intl, "PluralRules", { configurable: true, value: undefined });
			const tr = createTranslator("ru", { includeDrafts: true });
			expect(tr.locale).toBe("en");
			expect(tr.t("sync.notes", { count: 2 })).toBe("2 notes");
		} finally {
			Object.defineProperty(Intl, "PluralRules", { configurable: true, value: original });
		}
	});
});
