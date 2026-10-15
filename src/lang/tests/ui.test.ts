import * as obsidian from "obsidian";
import { bindUiLanguage, getAppLanguage, getUiTranslator, onUiLanguageChanged, refreshUiLanguage, t } from "../ui";
import { createTranslator } from "../index";
import { planEntryDetail } from "../display";
import { formatAttemptStatus, formatAttemptSummary } from "../../app/sync-attempt";
import { resolveLoadedSettings } from "../../types/keepsidian-plugin-settings";
import { deletionReviewSummary } from "../../ui/modals/deletion-review";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "../../test-utils/fixtures/sync-plan";

describe("UI language preferences", () => {
	let cleanup: () => void;
	afterEach(() => {
		cleanup?.();
	});
	it("guards the actual Obsidian language API when absent or throwing, preserving explicit overrides", () => {
		const original = Object.getOwnPropertyDescriptor(obsidian, "getLanguage");
		try {
			for (const value of [
				undefined,
				() => {
					throw new Error("Unavailable on old runtime");
				},
			]) {
				Object.defineProperty(obsidian, "getLanguage", { configurable: true, value });
				cleanup = bindUiLanguage(() => ({ language: "system", useDraftTranslations: true }));
				expect(getAppLanguage()).toBe("en");
				expect(getUiTranslator().locale).toBe("en");
				cleanup();
				cleanup = bindUiLanguage(() => ({ language: "de", useDraftTranslations: true }));
				expect(getUiTranslator().locale).toBe("de");
				cleanup();
			}
		} finally {
			if (original) Object.defineProperty(obsidian, "getLanguage", original);
			else delete (obsidian as { getLanguage?: () => string }).getLanguage;
		}
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
	it("localizes combined upload safety details at render time without changing plan data", () => {
		const entry = createSyncPlanEntryFixture("conflict-copy", "Conflict copy", {
			stage: "upload",
			title: "Upload",
			path: "中文/Русский.md",
			meta: {
				attachmentCount: 2,
				missingAttachmentCount: 1,
				detail: "Legacy English details",
				uploadDetail: { pendingMerge: true },
			},
		});
		const before = JSON.stringify(entry);
		cleanup = bindUiLanguage(() => ({ language: "de", useDraftTranslations: true }));
		expect(planEntryDetail(entry)).toContain("2 aktualisierte Anhänge");
		expect(planEntryDetail(entry)).toContain("1 referenzierter Anhang fehlt");
		expect(planEntryDetail(entry)).toContain("Beide Originale bleiben unverändert");
		expect(planEntryDetail(entry)).toContain("bestätigten Upload");
		expect(JSON.stringify(entry)).toBe(before);
	});
	it("keeps attempt IDs in tooltips and preserves ready-for-review and phase context", () => {
		const attempt = {
			id: "attempt-12345678-1234-1234-1234-123456789abc",
			mode: "import" as const,
			phase: "review" as const,
			startedAt: 1,
			updatedAt: 2,
			fetchedCount: 1,
			elapsedMs: 1,
			logUnavailable: false,
		};
		cleanup = bindUiLanguage(() => ({ language: "en" }));
		expect(formatAttemptStatus(attempt)).toBe("Last attempt: Ready for review");
		expect(formatAttemptStatus({ ...attempt, outcome: "failed" })).toBe("Last attempt: Failed");
		expect(formatAttemptSummary(attempt)).toContain(attempt.id);
		expect(formatAttemptSummary(attempt)).toContain("1 note · Review");
		expect(() => formatAttemptSummary({ ...attempt, phase: "future-phase" } as never)).not.toThrow();
	});
	it("uses singular English and Russian count forms in notices", () => {
		const en = createTranslator("en"),
			ru = createTranslator("ru", { includeDrafts: true });
		for (const key of ["notices.aiFailed", "notices.aiImported", "notices.resume"] as const) {
			expect(en.t(key, { count: 1 })).not.toContain("1 notes");
		}
		expect(ru.t("notices.resume", { count: 1 })).toContain("1 заметка");
		expect(ru.t("notices.resume", { count: 2 })).toContain("2 заметки");
		expect(ru.t("notices.resume", { count: 5 })).toContain("5 заметок");
	});
});
