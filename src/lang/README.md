# Language catalogs

This is a dormant localization foundation. The plugin still renders its existing English strings;
no production module imports this folder. See [readiness and rollout plan](READINESS.md).

## Files and status

| File | Purpose | Status on 2026-10-14 |
| --- | --- | --- |
| [en-plain-lang.ts](en-plain-lang.ts) | Canonical English source after plain-language review | All 138 entries reviewed; 58 revised, 80 retained |
| [en.ts](en.ts) | Preserved original English extraction, including its original header | 138 entries; unchanged archive, not the active source |
| [zh.ts](zh.ts) | Simplified Chinese (`zh`, matching Obsidian) | 138 AI-authored draft entries |
| [ru.ts](ru.ts) | Russian | 138 AI-authored draft entries |
| [de.ts](de.ts) | German | 138 AI-authored draft entries |
| [types.ts](types.ts) | Keys, message shapes, language status | TypeScript checked |
| [index.ts](index.ts) | Locale resolution, fallback, interpolation, plurals, display formatting | Tested, not wired to UI |
| [tests/i18n.test.ts](tests/i18n.test.ts) | Catalog and compatibility checks | Included in Jest |

Each draft covers all 138 current keys: 137 translated entries and the unchanged literal email example.
These are **not native-speaker-approved translations**. No English placeholder prose remains. Future
untranslated keys should be omitted so they fall back to English. Full catalog coverage is not full
plugin coverage: safety dialogs, dynamic sync-plan explanations, helper progress and several settings
still need extraction. None of the app's UI is localized by this change.

The English pass used the installed local `plain-lang` skill, which requires a separate copy and an
unchanged original. Both the registry and message types now use `en-plain-lang.ts`. Do not update the
archived `en.ts`; its original header is preserved as part of the copy contract. See the
[plain-language and translation review](PLAIN_LANGUAGE_REVIEW.md) for provenance, fidelity and limits.

## Translator rules

1. Add/change English in `en-plain-lang.ts` first. Use stable semantic keys, not English sentences as keys.
2. Add only actual translations to a locale's `messages`. Leave untranslated keys absent.
3. Preserve `{{name}}` placeholders exactly, but reorder them as the language requires. A numeric value
   is formatted for the language of the selected message. Pass IDs, paths, versions and codes as strings.
4. Single-brace filename syntax (`{title}`, `{note.date}`, `{now.year}`, etc.) is literal documentation,
   not translation interpolation. Never translate token names, API fields, enum values or persisted keys.
5. Translate complete sentences. Avoid concatenated suffixes, English word order, and `count === 1`
   grammar. Plural entries use `Intl.PluralRules` categories with a mandatory `other` form.
6. Match Obsidian terminology; keep product names, URLs and examples that define a protocol intact.
   The existing mix of KeepSidian/KeepSydian spelling is preserved; a brand-copy cleanup is separate work.
7. Never use a translated UI message to create note content, filenames, frontmatter, tags, logs or server
   requests. User-authored note titles and text are values, never translation keys.
8. Use returned text with `textContent`, `setText`, or `createEl({ text })`. This API does not escape HTML
   and must not be used with `innerHTML`. Add rich text via DOM nodes, not translator-supplied markup.
9. Keep the whole locale marked `draft` until native review, complete agreed-surface coverage, and
   rendered desktop/mobile acceptance. Do not mark a partial locale reviewed just to enable it.

The current key-completeness assertion deliberately fails when English grows. Translate new keys or
explicitly adjust the test to document an incomplete draft; never insert English placeholder prose
to pass it. The translator still supports absent keys and tests that fallback with a partial fixture.

## Previewing a draft in a test

```ts
import { createTranslator } from "./index";

const { t } = createTranslator("ru-RU", { includeDrafts: true });
t("commands.syncNow");
t("sync.notes", { count: 21 }); // 21 заметка
t("errors.filePath", { path: "Keep/中文.md" });
```

Omitting `includeDrafts` returns English for every current draft locale. A missing translation falls
back per key, including English plural rules and numeric formatting. Missing interpolation arguments
remain visibly `{{name}}`; plural messages require a finite numeric `count` and throw on programmer
misuse. Unknown keys throw a clear `Unknown message key` error; inherited catalog properties are
ignored. Keys and string/plural shapes are typed; argument names are not yet inferred by TypeScript.

`resolveLocale` accepts the Obsidian app language. It normalizes case/underscores and regional German
and Russian tags. `zh`, `zh-CN`, `zh-SG`, and explicit `zh-Hans` use Simplified Chinese. Traditional
Chinese (`zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant`) falls back to English until its own catalog exists.
Only the actual script/region subtags select a Chinese catalog: Unicode extensions and private-use
text do not. For example, `zh-TW-x-hans` stays English and `zh-CN-u-nu-latn` selects Simplified Chinese.
Unknown, absent or invalid locales fall back to English. These rules do not inspect note contents.

`readAppLocale` accepts an optional reader so integration can feature-detect Obsidian's `getLanguage`
API (available since 1.8.7). A missing/failing reader returns English, preserving support for 1.6.5.
No browser language guessing, storage writes, global language changes or private Obsidian API are used.
Decide separately whether older Obsidian needs a plugin-specific language override.

`formatNumber` and `formatDateTime` format display values only. Pass valid values and an explicit time
zone where required; date formatting throws on an invalid date. Existing machine dates, ISO receipts,
local-time filename tokens and date input parsing are outside this helper.
Regional formatting is not preserved by the catalog resolver (`en-GB` becomes `en`). Decide how to
retain regional display preferences before replacing existing system-locale date formatting.

## Verification

```sh
npm test -- --runInBand src/lang/tests/i18n.test.ts --coverage=false
npm test -- --runInBand
npm run build
```

Before wiring any surface, add caller-level assertions for every parameter and state. Keep stable
command IDs and `data-keepsidian-*` selectors in E2E tests. Never activate drafts in a release build
merely to obtain a screenshot.
