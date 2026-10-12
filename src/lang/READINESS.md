# KeepSydian multilingual readiness

Assessed 2026-10-12 against plugin revision `2ddb2f363bb3affa7389e3760ea77db91327a4a3`
(2.1.0-beta.7). This is a planning/catalog foundation, not a localized release.

## Recommendation

Pilot **Simplified Chinese and Russian**, then **German** if a third language fits the review budget.
This is an evidence-based prioritization, not a claim that these are Obsidian's second, third and
fourth most-used languages. Public evidence reviewed here does not establish that ranking or
KeepSydian-specific demand. Confirm the order with voluntary user requests and native contributors.

| Candidate | Actual ecosystem evidence | What it does not establish |
| --- | --- | --- |
| Simplified Chinese (`zh`) | Obsidian links its Chinese forum from its official site. On 2026-10-12 the forum displayed 6,857 help topics and 1,506 experience-sharing topics. Obsidian's translations project also identifies a dedicated Chinese maintainer community. | Topic counts are not unique users, active users, UI-language share or Google Keep adoption. Traditional Chinese is a separate locale. |
| Russian (`ru`) | The public Russian Obsidian Telegram channel displayed 5,639 subscribers when retrieved on 2026-10-12. A Homepage plugin request opened 2025-11-02 led to an offered translation on 2026-01-08 and closure via translation PR on 2026-01-15. | Channel subscribers and a concrete plugin request demonstrate community presence/demand, not population share or demand for this plugin. |
| German (`de`) | An Obsidian forum discussion on 2025-07-01 explicitly raised German localization/help barriers and elicited a translation contributor. A community post dated 2026-04-15 describes an extensive German Obsidian guide. | These are qualitative signals; evidence here is weaker for relative audience size than for Chinese/Russian community presence. |

Sources, all accessed 2026-10-12:

- [Chinese Obsidian forum](https://forum-zh.obsidian.md/) — live category counts; undated page.
- [Official Obsidian site](https://obsidian.md/blog/) — links the Chinese forum in its footer.
- [Russian Obsidian channel](https://t.me/obsidianru) — live subscriber count; undated landing page.
- [Homepage Russian translation request](https://github.com/mirnovov/obsidian-homepage/issues/133)
  — 2025-11-02 through 2026-01-15; user request and contribution evidence.
- [German localization discussion](https://forum.obsidian.md/t/multilanguage-support-specifically-german/102466)
  — 2025-07-01. Its historical complaint about missing German help should not be treated as current availability.
- [German community guide announcement](https://en.ileif.de/2026/04/15/dont-panic-just-markup-a-german-language-obsidian-guide/)
  — 2026-04-15; resource availability, not usage telemetry.

### Availability is not popularity

The [official translation catalog](https://github.com/obsidianmd/obsidian-translations#existing-languages)
lists Chinese, Russian, German, Spanish, Japanese, Portuguese and many others. Its alphabetical rows
and completion markers describe **supported translations**, not popularity. They help align terminology
and locale identifiers; they cannot rank market demand. Spanish and Japanese remain plausible later
candidates; this research does not show that German is more widely used than either.

Obsidian's [privacy policy](https://obsidian.md/privacy), last updated 2023-11-01, says the app collects
no telemetry. The [2026 Obsidian October announcement](https://obsidian.md/blog/2026-obsidian-october/),
dated 2026-10-01, introduces its first State of Obsidian survey and promises a public report by year end.
No language-share results were available in the sources reviewed on 2026-10-12. Revisit the eventual
report if it includes language data and disclose its voluntary-response bias. Do not add plugin
telemetry to answer this question. No translation provider or paid API was used.

## Current readiness

The TypeScript/Obsidian component structure supports incremental extraction, and Unicode strings and
paths are already carried through the code. End-to-end multilingual UI readiness is low: there was no
catalog, locale selection, translator or localization test layer before this checkpoint.

A mechanical scan of non-test TypeScript found 59 `new Notice(...)` call sites in 13 files, 71
`setName`/`setDesc` calls in five files, 21 button/placeholder/tooltip calls in seven files, and 49
literal `text:` properties in ten files. These are overlapping extraction leads, not unique string
counts or a completeness measure. Dynamic builders, accessibility labels and thrown errors add more.

| Area | Evidence in current source | Remaining work |
| --- | --- | --- |
| Commands and settings | `app/commands.ts`, `ui/settings/KeepSidianSettingsTab/*`, `SubscriptionSettingsTab.ts`: inline English labels, descriptions and notices | Wire catalogs by surface; preserve IDs/values. Translate disabled/gated explanations as whole sentences. |
| Sync center/results | `ui/modals/SyncProgressModal.ts`, `app/sync-ui.ts`, `app/sync-status.ts`: captions, count suffixes, state descriptions, tooltips | Extract complete state messages and aria labels. `1/1 notes` and suffix assembly need deliberate grammar handling. |
| Safety and conflict review | `ui/modals/deletion-review.ts`, `merge-action-selector.ts`, domain merge labels and plan builders | Separate display text from stable action enums/receipts. Native-review destructive actions and backup/opt-in copy before activation. |
| Notices/errors | `services/errors.ts`, `app/main*.ts`, sync/push/services | Map stable error kind/code to messages. Keep raw diagnostics separate. Sync modal currently classifies some English error substrings. |
| Onboarding/auth/help | Token settings, `TokenHelperInstallModal.ts`, `integrations/google/tokenHelper.ts`, `FeedbackSurveyModal.ts` | Translate disclosure, validation, progress and accessibility text. Helper executable, Google sign-in, external docs and Google feedback form are separate surfaces. |
| Locale detection | No existing detector. Minimum app version is 1.6.5; installed/public API documents `getLanguage()` since 1.8.7 | Feature-detect at plugin startup, then inject translator. Reopen/reload after app-language change initially; decide an older-app override separately. |
| Plural/interpolation | English `count === 1`/`"s"` construction and string concatenation | Replace with whole messages and CLDR categories. New helper tests Russian one/few/many/other, Chinese other, English/German one/other. |
| Formatting | Three `toLocaleString()` calls without an explicit app locale; ASCII numeric settings; custom date parser requires `YYYY-MM-DD HH:MM` | Pass effective UI locale for display. Keep parser format explicit until a separate input redesign. Do not parse localized display strings as machine dates/numbers. |
| Layout/RTL | Physical left/right spacing in `styles.css`; no plugin-level bidi review | Use logical CSS, text expansion tests, mixed-direction path/title isolation, long-label wrapping and keyboard/screen-reader checks. No RTL support claim yet. |
| Persistence/sync | Filename patterns, fallback title, conflict suffixes, frontmatter and journal structures participate in identity | Keep these locale-invariant. Translation is UI-only; no note-content translation or data migration. |

API source: [Obsidian public declarations](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts)
(retrieved 2026-10-12), `getLanguage` documentation. This matches the locally installed API declarations.

## What this checkpoint adds

- `en-plain-lang.ts`: 138 source entries from commands, core settings, supporter settings, sync UI,
  notices, errors, token onboarding and feedback. All entries received a plain-language review:
  57 revised and 81 retained. Comments trace groups to original files. It is still an initial subset.
- `en.ts`: the original extraction preserved byte for byte under the local plain-lang skill's copy
  contract. It is no longer the canonical source; see [review details](PLAIN_LANGUAGE_REVIEW.md).
- `zh.ts`, `ru.ts`, `de.ts`: 138 draft entries each, derived from revised English. Each has 137
  translated entries and one preserved email example. All need native review; approved non-English
  coverage remains zero. Missing future translations still fall back to English.
- Typed keys/shapes; locale normalization and aliases; an injectable language reader; per-key English
  fallback; named interpolation; cardinal plurals; explicit display number/date formatting.
- Draft activation gate and Jest checks for catalog integrity, fallbacks, plural rules, old-app API
  absence, interpolation and Unicode filename invariance.

The helper has no storage, network, vault or UI side effects. No production import references it;
translations are not bundled into `main.js`. No package/manifest/version, runtime UI, sync algorithm,
server, note data or CSS was changed. The revised source preserves brand names, technical meaning,
warnings, placeholders and filename examples while simplifying the English wording.

## Persistence boundaries

- Keep command IDs, settings keys, request fields, error codes, color/filter enum values and subscription
  plan IDs stable. Translate only their displayed labels.
- Preserve `GoogleKeepCreatedDate`, `GoogleKeepUpdatedDate`, `KeepSidianLastSyncedDate`, identity URLs,
  deletion ledger and receipt fields, media paths, `_KeepSidianLogs`, and existing English diagnostics.
- Do not translate `{title}`/`{now.*}`/`{note.*}`, default paths, `Untitled KeepSidian Note`, conflict
  suffixes, attachment names, imported bodies, generated tags or smart-title content. The latter two
  are server/content features and need a separate language decision, not the UI locale.
- `services/note-path-resolver.ts` preserves Unicode letters while replacing prohibited path punctuation.
  Existing date tokens use local time and ASCII digits. Keep that behavior; UI locale is not a new
  timezone or filename policy. Unicode normalization/case collisions and cross-device sync need
  dedicated fixtures before any filename policy change.
- Some machine lists currently use `localeCompare` (attachments/ledger/scan). Audit whether ordering
  participates in hashes/comparisons before changing their locale or comparator. Do not localize them
  incidentally when formatting UI lists.

## Incremental rollout

1. **Foundation — this checkpoint.** Review catalogs and the UI/data boundary; keep runtime English.
   Rollback is removal/revert of `src/lang` only. No migration or release action is needed.
2. **One complete UI slice.** Wire guarded Obsidian locale detection and migrate commands plus basic
   settings using the English catalog first. Keep stable IDs. Add caller-level tests and a fixture
   preview for long labels. Compare rendered English before/after and inspect desktop/mobile.
3. **Complete critical flows.** Migrate sync setup/review/run/result, notices, errors, disabled states,
   token onboarding, safety prompts and aria text. Avoid translating persisted diagnostics; render
   stable error/action codes at the UI boundary. Add stale/missing-key checks and reconcile catalog
   changes when rebasing onto the release owner's final branch.
4. **Native review and pilot.** Recruit Chinese and Russian reviewers, then German. Review terminology,
   token privacy disclosures, destructive actions and fallback consistency in context. Finish the
   agreed surfaces before changing locale status to `reviewed`; do not ship the preview opt-in.
5. **Acceptance and later languages.** Use disposable multilingual fixtures with Chinese, Cyrillic,
   Arabic, combining accents, emoji and long titles. Test download/upload/conflict/deletion outcomes,
   restart, desktop/mobile, keyboard navigation, 30–50% expansion and an RTL pseudo-locale. Verify byte-
   identical note bodies and stable filenames/metadata across UI-language switches. Add real RTL
   locales only after bidi/layout review. Revisit survey evidence and contributor demand for the next wave.

English fallback is a safety net, not the acceptance criterion for a supposedly complete translation.
Approval to merge/release, and coordination with the desktop acceptance owner, remain future steps.

## Validation and working boundaries

- `npm run build`: passed TypeScript, ESLint and bundle checks. Two existing warnings remain:
  `features/keep/deletions.ts:142` uses `Vault.trash`; `features/keep/sync.ts:275` has an unused helper.
- Targeted Jest: 56 tests passed, including source preservation, complete draft keys, placeholder/token
  multiplicity, literal examples and new translated warning plurals. Full-suite results for this
  revision are recorded in [the plain-language review](PLAIN_LANGUAGE_REVIEW.md).
- New Markdown files pass lint. Repository-wide Markdown lint still reports 40 pre-existing line-length
  errors in older planning and screenshot reports; none are in this change.
- Dependencies were copied into this isolated checkout from the existing local installation;
  `npm ls --depth=0` passed. Node 26.8.1 / npm 11.19.0. No install scripts, new dependencies or services.
- Desktop E2E, installation and rendered acceptance were intentionally not run: the separate release
  task owns desktop focus and integration, and this dormant foundation changes no rendered surface.
  Unit tests do not establish linguistic quality, RTL behavior, or end-to-end localized UI acceptance.
- Read project AGENTS, docs map, UI/testing guidance and improvement-loop guidance. The checkout has
  no `.agents/skills`; the private guidance's legacy `.agents` link points to a retired path. Maintained
  project docs explicitly describe that situation. Available local skill descriptions were inspected;
  vault/UI automation skills were not applicable to this isolated catalog task.
- Work is isolated on `codex/multilingual-foundation` in a separate local clone. No push, merge, PR,
  release, plugin install, vault/UI access, raw session reads or private-code upload was performed.

Next concrete step: arrange native review while a follow-up change wires one complete English UI
slice after the current release is finished. Language priorities remain evidence-based candidates,
not measured usage rankings.
