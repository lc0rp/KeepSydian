# Resumable hosted release repair

Status: reviewed code proposal; activation and live validation remain gated. Beta.8 was separately recovered and published; this branch does not republish it.

The backend must be deployed and verified before the client is built. The client now requires an exact successful backend deploy/ref job proof, immutable backend core, archive digest and matching source/version/model/runtime/revision/image tuple. The automatic handoff supplies an exact expected client dispatcher SHA, so a moving main branch cannot silently change the reviewed release.

Build evidence binds all three asset hashes to client source/version/backend URL. Recovery accepts an explicit prior run/artifact/head tuple, verifies canonical run and workflow provenance, and reuses the exact bytes. It retains intent before tag POST, reconciles accepted-but-lost writes, and never overwrites conflicting refs or assets. A second recovery retains source binding. Only the frozen original beta.8 artifact has a documented source-binding compatibility exception.

The legacy tag-triggered publisher is retired for future source trees. Existing historical trees are unchanged. New source commits must contain retirement and match the main workflow tree before building. Own-repository writes retain GITHUB_TOKEN Contents:write; a preflight guard does not establish the unknown beta.8 tag failure's exact cause or prove hosted tag permission behavior.

A separately approved backend-proof-reader App needs Actions:read only on lc0rp/KeepSidianServer. Configure BACKEND_RELEASE_APP_ID and secret BACKEND_RELEASE_APP_PRIVATE_KEY only after exact approval. The separate server-side dispatcher App needs Actions:write only on this client repository; both repositories configure its exact CLIENT_RELEASE_ACTOR_ID, and this repository additionally configures CLIENT_RELEASE_ACTOR_LOGIN. There are no configured App identities or credentials in this change and no persistent access was granted. Empty identities fail closed. Manual recovery remains restricted to Luke on main.

For recovery, workflow_dispatch release-client.yml on reviewed main with expected_head, backend_run/backend_artifact/backend_head, and recovery_run/recovery_artifact/recovery_head. It skips npm/build. Expired or unverifiable evidence, wrong source, failed backend deploy/refs, unresolved write outcomes and conflicting release assets stop for canonical reconciliation; no blind duplicate publication.

See the paired backend change's `docs/08-operations/release-ci-repair.md` for the incident matrix, full trust/token proposal, exact recovery contract and bounded live-validation plan. See `release/pins.json` for the immutable engine graph. Preserve pinned source/core commits when merging. Keep this plan recovery-only until a new release tuple and budget have been reviewed. No claim of hosted autonomy follows from local tests.

## App-free read-only beta.8 validation

The dispatcher defaults to `mode: validate-beta8`. Supply the exact resulting main SHA as `expected_head`; leave backend/recovery inputs blank. Its separate validation job passes no App secret, grants only Contents:read and Actions:read, and never enters build/publish jobs. The fixed validator restores original run 37883112419/artifact 11595093861, verifies its archive/files against retained SHA-256 values, reads source tag/release 408002984 and the three fixed asset IDs, compares downloaded bytes, and performs at most 5 public capability/subscription GETs. Foreign endpoints, mutations, redirects, drift, missing/expired evidence, oversized responses and deadlines stop without repair/retry. There is no backend-private-repository read or Google credential in this job.

The corresponding server validation is dispatched separately by Luke; it uses existing federation and no Apps. Neither receipt claims successful release proof, and validation receipts cannot be consumed as release receipts. See the backend runbook's minimal first-stage package: exactly two validation runs, at most 10 private plus 10 public runner minutes, 15 total application GETs, no production mutations, no reruns, $0.17 planning envelope including storage/GCP contingency. Keep ordinary CI suppressed until separately authorized.

For full release mode the user must generate, transfer and configure any approved App private key through their secure GitHub handoff. The agent must never retrieve, generate, transmit or configure it, including through protected stdin or temporary files. No App setup is required for read-only validation. Preserve referenced commits on merge; validation uses the resulting main SHA and requires no new release plan or invented version.

The original client artifact expires **2026-10-10 04:18:03 UTC**; the paired server artifact expires **04:04:35 UTC** that day. Validation after expiry fails closed; no silent local-copy fallback or artifact substitution.
