# Merge action persistence corrections

Scope: run `merge-actions-20260922`, `lc0rp/KeepSydian`, PR 22. Luke requested direct ChatGPT corrections without another Codex validation handoff. This document does not authorize merging or changes to another repository.

## Confirmed remote body baseline

`KeepSidianLastSyncedDate` remains a local bookkeeping timestamp. It is no longer used by reviewed uploads to prove that Keep has not changed. Downloads store a SHA-256 fingerprint of the captured Keep body and stable note identity in the local-only `KeepSidianRemoteBaseline` property. Upload review compares the actual remote body to that fingerprint. Thus an edit between download review and download execution is detected even if its remote timestamp precedes the new local write timestamp or has unchanged precision.

Missing, invalid, or unavailable fingerprints are unknown baselines and use conservative merge handling. A confirmed unchanged baseline preserves intentional local-only deletions. Explicit overwrite-all retains its source-wins semantics. Successful, explicitly acknowledged uploads replace the baseline with a fingerprint of the accepted outgoing body. If the server transforms that body, its next differing response is conservatively merged. This is body conflict detection; remote metadata snapshot checks remain in the preflight path.

## Durable pending uploads

A clean downloaded merge writes `KeepSidianPendingUpload: true` together with its body and baseline in one vault write. The collector uses that marker independently of mtime, global download checkpoints, and in-memory force lists. Deselecting a note leaves its bytes unchanged during that upload, and the note remains eligible after abandonment, cancellation, refresh, partial failure, or restart. The global checkpoint may advance after the selected work completes; it cannot erase this per-note upload eligibility.

Only explicit server success followed by successful local reconciliation clears the pending marker. Missing acknowledgment, changed local content, changed pending attachment bytes, or failed local write retains pending state. These two internal properties are stripped from outgoing Keep payloads. A legacy or scheduled upload that encounters pending work also performs remote merge review with the safe default.

Pending notes retain local image references, and their referenced media is collected regardless of the download timestamp. Pending attachment bytes are checked against the reviewed payload before upload and before retiring pending state. Existing attachment conflict and download naming conventions are unchanged; this correction does not add a binary three-way merger.

## Regression coverage and boundaries

`src/app/tests/merge-action-persistence.test.ts` runs the real download engine, upload engine, note collector, comparison, attempt lifecycle and plan orchestration. External HTTP/vault I/O and UI are replaced. Cases cover all four policies for the T0/T1/T2 regression, unchanged remote timestamps, same-second local writes, deselected A with successful B and restart, abandonment/cancellation, partial failure/retry, missing acknowledgments, local write failure, confirmed local-only deletions, pending local attachments, changed attachment bytes and safe legacy upload fallback.

Web Crypto availability is checked at runtime. Failure leaves the baseline unknown and does not permit timestamp-based assumptions. The existing server API still has no atomic conditional-write contract; remote edits after preflight remain outside the guarantee. Browser/live validation and genuine product screenshots remain separate acceptance evidence, not implied by automated unit or pipeline tests.
