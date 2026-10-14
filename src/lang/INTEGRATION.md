# Multilingual UI integration

Candidate dated 2026-10-14; based on PR31 merge `1c09069580a78cdfdf90d73995455bf83566a63d`.
This candidate is not a release or a native-approved translation.

## Behavior

- Language follows Obsidian by default, with explicit English, Simplified Chinese, Russian and German
  overrides. Draft translations require a separate opt-in; old settings therefore continue in English.
- Settings redraw after a choice. Commands, ribbon, status and the sync center refresh after an
  effective locale change. Other open dialogs should be reopened. The public app-language reader is
  guarded and polled once per second with plugin-lifetime cleanup.
- Main settings, color/merge choices, feedback, helper onboarding, sync review/results, selection and
  warning counts, date-range validation, deletion disclosures and principal sync notices use catalogs.
- Plugin-owned plan labels are translated at the rendering boundary. Action codes, persisted settings
  keys, command IDs, receipts, note text, frontmatter, filenames, date tokens and sync requests retain
  their existing meanings. No translation provider is called.
- Text uses text nodes. Numeric parameters are formatted and plural messages use locale rules.
  Missing keys fall back to English. Older runtimes without PluralRules select English.
- Dates keep system regional formatting. Date input still requires the documented ASCII format.
  Mixed-direction note titles/paths wrap and retain their text; no RTL interface locale is supplied.

## Acceptance procedure

Run the Jest suite, production build and the isolated desktop spec. The spec requires already
installed cached binaries; it does not download an installer or remove quarantine attributes.
Use Node 24: the installed Node 26 runtime fails the WebDriver session transport.

```sh
npm test -- --runInBand
npm run build
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
NO_PROXY=localhost,127.0.0.1 \
KEEPSIDIAN_TEST_BINARY_CACHE=/path/to/existing/obsidian-cache \
./node_modules/.bin/wdio run wdio.i18n.conf.mts
```

The service creates a fresh profile and copies `test/vaults/simple`. Only synthetic review entries
and mocked services are used. The six desktop checks cover opt-in, four locales, command labels,
saved preferences, plugin reload, English fallback, recoverable deletion copy, literal malicious
markup in note titles, mixed scripts, narrow-window overflow and translated connection errors.
Screenshots are saved under ignored `output/i18n`.

## Remaining acceptance and limits

- All 378 entries in each non-English catalog are AI drafts. Native reviewers must check terminology,
  consent, secret storage and destructive-action meanings in context before marking any locale reviewed.
- Narrow desktop screenshots are not Android or iOS E2E. The current Android service requires
  Appium shell access and grants app permissions. These steps were outside this task's authorization;
  native mobile acceptance is outstanding.
- The current desktop run uses Obsidian 1.12.4. Minimum-version behavior is covered by guarded API
  tests, not a real 1.6.5 launch.
- Technical diagnostics, unknown server/helper messages, generated sync logs, and external sign-in,
  billing, documentation and Google pages can remain English. The separate helper app is not translated.
- Full RTL chrome and locale-specific accessibility review remain future work.
- No production vault, account, plugin installation, release, push or merge is part of this candidate.

Next: complete independent Claude Code and Codex review of one frozen candidate; resolve findings
and repeat affected checks. Then seek the new PR/merge decision and arrange native-language/mobile
acceptance. The original demand recommendation remains Chinese and Russian first, German third;
it is not a measured Obsidian language ranking.
