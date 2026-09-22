# Sync Center merge actions

Run: `merge-actions-20260922`. Scope: `lc0rp/KeepSydian`, task branch only. ChatGPT implements through the GitHub connector. Codex validates locally and in the browser. This document records design and acceptance criteria; it does not authorize a merge or a writer-role change.

## Behavior

The review grouping row shows **Merge action:** when any row is a merge candidate, including a conflict-only plan. The selector follows the chips and uses the existing flexible spacer and wrapping control styles. It is absent during execution and from plans without merge candidates. The four exact choices are:

1. **Merge & save conflicts**: merge clean changes; save a separate local conflict copy when the merge conflicts. Preserve the original. On upload, preserve both originals and send no conflicting payload.
2. **Merge & skip conflicts**: merge clean changes; skip the whole conflicting note without writing its content, attachments, or last-synced timestamp.
3. **Merge & overwrite conflicts**: merge clean changes; replace a conflicting note's body with the source body.
4. **Overwrite all, no merge**: use the source body for every selected overlap without invoking the merge algorithm during execution.

The source is Keep during download and the vault during upload. These are whole-note conflict decisions. Existing frontmatter and attachment conventions remain in place. The choice belongs to the reviewed run, survives filtering and refreshing, and carries into the upload phase of two-way sync. New runs default to saving conflicts. Existing identical, up-to-date, unselected, and excluded notes remain outside the selected operation.

## Upload safety and two-way behavior

Manual upload review fetches remote snapshots and matches stable Keep note identities rather than titles. Missing linked notes or changed snapshots fail closed. Execution rechecks all selected local and remote snapshots before its first write and guards local edits before each upload batch and before applying returned timestamps. Missing success acknowledgments do not stamp reviewed notes.

The existing push endpoint has no compare-and-swap field. Remote edits between the preflight read and the server write remain a race; this implementation does not claim atomic conflict protection. Concurrent editing should be avoided during validation and synchronization. A server-side conditional-write contract would require separate authorization for that repository.

Download conflicts that are saved or skipped are protected from the subsequent upload phase. Clean downloaded merges are explicitly included in the upload plan, even though the download has updated their local sync timestamps. The global successful-download checkpoint advances only after all stages succeed and no preserved conflicts remain. A run with no second-stage upload work can finish directly.

## Validation

GitHub CI tests and builds the exact task head, records the checkout SHA, and runs on task-branch pushes. PR checks also check out the PR head explicitly. Local reports are additional evidence, not independent CI proof.

Codex should validate from the committed task head with a disposable backed-up vault and synthetic Keep notes. Run `npm run coverage`, `npm run build`, and the available desktop/browser verification. Exercise all four choices in download, upload, and both stages of two-way sync, covering clean additions, conflicting edits, local-only deletion, unchanged notes, selected subsets, missing attachments, request failure, changed-after-review notes, and cancellation. Confirm actual content on both sides and inspect sync stamps, not only result text.

Confirm the selector sits at the right of the chip row on desktop, wraps without clipping on a narrow screen, supports keyboard selection, appears for a conflict-only plan, retains its choice during filtering/refresh and two-way transition, cannot change a running plan through a detached control, and resets on a new run. Confirm saved and skipped download conflicts never leak into the upload payload. Use sanitized evidence without account identifiers, credentials, real note contents, or attachment URLs.

Store the latest product screenshots under `screenshots/merge-actions-20260922/` and the validation report alongside them. Report the exact tested commit, commands and outcomes, environmental limitations, and screenshot paths. Return a refreshed C2C-GH envelope with live head/base pins and the task PR. Codex must not implement or modify source as part of validation without Luke's explicit authorization.
