# Multilingual UI integration

Candidate dated 2026-10-14; based on PR31 merge `1c09069580a78cdfdf90d73995455bf83566a63d`.
This candidate is not a release or a native-approved translation.

## Behavior

- Language follows Obsidian by default, with explicit English, Simplified Chinese, Russian and German
  overrides. Draft translations require a separate opt-in; old settings therefore continue in English.
  Automatic app-language detection needs Obsidian 1.8.7 or later. When that API is unavailable,
  the default is English; explicit locale overrides still work.
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
They also cover upload conflict/attachment warnings and an open error after draft opt-out.
Screenshots are saved under ignored `output/i18n`.

Additional responsive and keyboard acceptance uses `wdio.i18n-acceptance.conf.mts`. Run it with
the same cache and Node 24 environment. The default desktop matrix uses CSS viewport widths
430, 768 and 1100. Set `KEEPSIDIAN_I18N_MOBILE=1` for Obsidian's Electron mobile emulation at
320, 390 and 768 pixels, including emulated touch metrics. These are not Capacitor/native devices.
`KEEPSIDIAN_I18N_WIDTH` selects one diagnostic width. Each width uses a fresh synthetic vault.

For each locale the spec checks the language selector and draft switch's computed accessible
names/roles, Tab/Shift-Tab/Space operation, draft fallback and focus after redraw, dialog naming,
checkbox selection/focus, forward/reverse focus containment, Escape/return focus, status/alert
semantics, translated safety warnings and horizontal overflow. The settings and sync center
carry the effective language attribute; note titles/paths have unspecified language, not a guessed
translation language. The settings opt-in description is associated with its switch.
The checks include both exact Tab boundaries and focus during a delayed subscription check.
At narrow widths, wrapping text repeats the full selected merge policy so its distinguishing
save, skip or overwrite wording remains visible even when the native select truncates.

The emulation harness warns about existing desktop-helper Node imports (`fs`, `os`, `path`,
`crypto`, `child_process`). The spec records those notices and lets them expire before screenshots;
it does not suppress them or claim that Electron proves native platform compatibility.

## Remaining acceptance and limits

- All 411 entries in each non-English catalog are AI drafts. Native reviewers must check terminology,
  consent, secret storage and destructive-action meanings in context before marking any locale reviewed.
- Narrow desktop screenshots are not Android or iOS E2E. The current Android service requires
  Appium shell access and grants app permissions. These steps were outside this task's authorization;
  native mobile acceptance is outstanding.
- The current desktop run uses Obsidian 1.12.4. Minimum-version behavior is covered by guarded API
  tests, not a real 1.6.5 launch. Available runtime caches contain 1.12.4, 1.12.7 and 1.13.7;
  no 1.6.5 runtime or matching driver was installed or downloaded.
- Detailed folder-verification diagnostics, unknown server/helper messages, generated sync logs, and external sign-in,
  billing, documentation and Google pages can remain English. The separate helper app is not translated.
- At a 320px desktop viewport, Obsidian's settings navigation leaves only a 10px plugin content
  column. The diagnostic still fails reflow (51px overflow in all four locales). A comparison with
  KeepSydian disabled reproduces the allocation and overflow in Obsidian's General and Editor tabs;
  all four plugin locales fit a controlled 280px allocation without a product change.
  See [the host boundary and regression procedure](SETTINGS_REFLOW.md). This remains open;
  the passing desktop matrix starts at 430px, where text fits but the settings column is cramped.
- Full RTL chrome, native screen-reader testing, theme/contrast certification and a complete audit
  of older settings controls and other dialogs remain future work. Automated accessibility acceptance
  covers the language controls and synthetic sync review paths above, not WCAG compliance.
- No production vault, account, plugin installation, release, push or merge is part of this candidate.

Next: obtain independent Claude Code and Codex review of the updated frozen candidate, then
arrange native-language, native-mobile and minimum-version acceptance before a production claim.
The original demand recommendation remains Chinese and Russian first, German third;
it is not a measured Obsidian language ranking.
