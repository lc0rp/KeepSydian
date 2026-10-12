# Plain-language and translation review

Reviewed 2026-10-12. Scope: all 138 entries in the English catalog, followed by Simplified Chinese,
Russian and German drafts of the revised source. This remains a dormant foundation.

## Method and preserved source

Used the actual installed `plain-lang` skill at
`~/.codex/skills/luke-agent-public-skills/plain-lang/SKILL.md` and its
`references/iso-24495-1.md` guide. Its focus is relevant, findable, understandable and usable wording
with factual and operative content preserved. This is a skill-guided editorial pass, not an ISO
certification or reader-usability study.

The intended readers are Obsidian users setting up Google Keep sync, reviewing sync actions and
responding to errors. Instructions now state actions directly, split long explanations and use
consistent upload/download wording. Short, clear labels remain unchanged.

The skill requires an unchanged original and a separate copy created before rewriting. `en.ts` was
copied to `en-plain-lang.ts`, then only the copy was revised. Original SHA-256 before and after:

```text
bd5639436acbd71f511958f56387176772ac96c588860a59bb54974e47889c58
```

The original remains an archive. The catalog registry and message types import the revised copy.
All 138 keys were reviewed: **57 entries changed; 81 retained**. No key, placeholder name, English
plural category or single-brace filename token changed.

## Main wording changes

| Before | Revised wording | Purpose |
| --- | --- | --- |
| Perform two-way sync | Sync in both directions | State the action directly. |
| Location preview:- your notes will be saved here: | Your notes will be saved here: | Remove the redundant label and punctuation. |
| OAuth flow | Google sign-in (OAuth) | Explain the setting while retaining the technical term. |
| Change the default sync interval. | Change the default time between syncs. | Use familiar wording; the setting label still specifies hours. |
| Backup advisory ⚠️ | Back up your vault ⚠️ | Put the required protective action first. |
| Unchecked | Not selected | Describe the sync item's selection state. |
| Pushed Google Keep notes. | Uploaded notes to Google Keep. | Use the same direction terminology as commands and modes. |

## Meaning and terminology checks

The editorial review compared every English entry with the original and each translated entry with
the revised source. The following meanings are retained, with no stronger guarantees:

- Tokens allow access to Google Keep data. Secure storage uses Obsidian secret storage **when
  available**; no unconditional secure-storage claim is added.
- Two-way sync is experimental. Media uploads are unsupported. KeepSidian **tries** to archive
  conflicting Google Keep notes; it does not promise successful recovery. Downloads remain limited
  to the configured save location. The backup warning and explicit opt-in remain.
- The helper is a separate open-source download, outside the community plugin bundle. It launches
  only from the stated screen, opens a real browser, captures the local OAuth cookie and sends that
  cookie directly to KeepSidian on the same computer. Source code and release checksums remain
  available for review. Token and cookie are not silently treated as synonyms.
- Delete, overwrite, merge, conflict copy and skipped conflict remain distinct actions/states.
  Generic failures still direct users to the log; no new retry or data-safety promise is added.
- Supporter gating, active-only default, pinned/archived choices, retained original titles, hours,
  external Google form, and the approximate 2–3-minute survey duration remain.
- Product names, placeholder values, email/path examples and filename syntax remain literal. The
  original mix of the terms wizard and helper is retained for the existing separate UI contexts;
  their displayed names should be reconciled with the helper UI during integration.

| English term | Simplified Chinese draft | Russian draft | German draft |
| --- | --- | --- | --- |
| Vault | 仓库 | хранилище | Vault |
| Sync token | 同步令牌 | токен синхронизации | Synchronisationstoken |
| Download / upload | 下载 / 上传 | скачивание / отправка | Herunterladen / Hochladen |
| Delete / overwrite / merge | 删除 / 覆盖 / 合并 | удалить / перезаписать / объединить | Löschen / Überschreiben / Zusammenführen |
| Wizard / helper | 向导 / 助手 | мастер / помощник | Assistent / Hilfsprogramm |

These are working terms, not a claim of native review or exact alignment with every current Obsidian
translation. Review official terminology in context before activation, especially secret storage,
supporter status, sync review and the wizard/helper labels.

## Draft coverage and quality limits

Each of `zh.ts`, `ru.ts` and `de.ts` now has **138 of 138 keys**: 137 translated entries plus the
unchanged literal email example. Together they contain 414 draft entries; 306 entries were added.
Existing draft entries were also reconciled with revised English. No English placeholder prose is
marked translated. Chinese uses `other`, German `one`/`other`, and Russian
`one`/`few`/`many`/`other` for both plural messages.

Every non-English catalog remains `draft` and requires explicit test-preview opt-in. There are
**zero native-approved entries**. Full coverage of this subset does not mean the plugin is fully
localized. No translator service, API spend or private-code upload was used. No note content,
filenames, persistence fields or live UI were changed.

Before activation, native reviewers should check naturalness, terminology and every warning against
the English source in rendered desktop/mobile context. Also verify wrapping, accessibility, mixed
scripts and the remaining uncatalogued surfaces. Automated checks cannot establish those outcomes.

## Verification

- Focused catalog tests: 56 passed. Checks include original-file SHA-256, stable keys and shapes,
  placeholder/token multiplicity, protected names/numbers/examples, complete draft coverage,
  fallback grammar/formatting and plurals including Russian zero, fractions and 21.
- Full Jest suite with coverage: 57 suites / 844 tests passed.
- Production build: TypeScript, ESLint and bundle checks passed. The same two existing lint warnings
  remain in `features/keep/deletions.ts:142` and `features/keep/sync.ts:275`.
- All three catalog Markdown files pass the repository's Markdown rules. Changed TypeScript passes
  Prettier. The original English file retains the hash above.
- Built `main.js` is byte-identical to the earlier dormant-foundation checkpoint (SHA-256
  `ded0c5a6373d597fc745f324e56d958f11f648ce7d83ff5501d9147e41d65f6a`). No production imports were added.
- Native-speaker review and rendered UI acceptance: outstanding; drafts remain disabled.
