# Sync end-date verification

- Tested code SHA: `b0804d5fb1e363de56c269098c0dfb99a5f461fe`
- Evidence commit SHA: the commit containing this note and screenshot; reported separately from the tested code SHA in the C2C `EXECUTED` envelope.
- Environment: macOS, Node `v26.8.1`, npm `11.19.0`, Obsidian `1.14.1`, timezone `America/New_York` (EDT, UTC-04:00).
- App verification used an isolated `KeepSidianEndDateVault`. No sync was started.

## Automated checks

- `npm ci`: failed with exit 255 because the shared npm cache contains root-owned files (`EPERM`). The shared cache was left untouched.
- `npm ci --cache /private/tmp/npm-cache-sync-end-date-20260922`: passed (exit 0; 1,759 packages installed). npm reported 59 dependency audit findings: 3 low, 12 moderate, 40 high, and 4 critical. No dependency changes were made.
- `npm run coverage`: passed (exit 0).
- `npm run build`: passed (exit 0); lint reported one warning, `logErrorIfNotTest` unused in `src/features/keep/sync.ts:245`.
- `npm run wdio`: failed before test specs ran (exit 1). The Obsidian launcher setup failed at `hdiutil attach` with `Device not configured` while preparing Obsidian 1.13.7.
- GitHub Plugin CI run `35770841676` passed for the tested code SHA.

## Installed-plugin UI checks

Observed in the live Obsidian app and captured in [custom-range.png](custom-range.png):

- The heading is `START & END DATE`; the built-in scope is `Last sync → Now`.
- Custom mode shows `Start:` and `End:` fields with their respective help text. Both labels and inputs fit on one row at the captured window size; the end help text wraps naturally below its field without clipping.
- The help text describes inclusion after the start and before the end, and says a blank end uses the time sync starts.
- Entered `2025-04-12 09:17` and `2025-04-13 10:30`; switching to All dates and back to Custom retained both values. Tab from Start moved focus to End.
- A blank start showed validation; impossible date `2025-02-30 09:00` was rejected; future start `2099-01-01 09:00` was rejected; equal and reversed bounds showed `End date must be after the start date.`

## Not verified

- Narrow-window/responsive layout and the automated desktop browser suite (WDIO could not start).
- Upload-only behavior.
- Live server filtering for free or premium accounts, including strict end-boundary behavior and older notes updated inside the range.
- Runtime confirmation that the default end is captured once at sync start and remains fixed across pagination, retries, or resume; next-window boundary eligibility; checkpoint behavior on custom, failed, or canceled syncs; and request timezone conversion.

These service/runtime checks were not run because no controlled test account and disposable notes were available. No production sync or note write was attempted. Unit/coverage and CI results do not substitute for these live checks.
