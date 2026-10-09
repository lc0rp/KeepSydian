# Resumable hosted release repair

Status: reviewed code proposal; activation and live validation remain gated. Beta.8 was separately recovered and published; this branch does not republish it.

The backend must be deployed and verified before the client is built. The client now requires an exact successful backend deploy/ref job proof, immutable backend core, archive digest and matching source/version/model/runtime/revision/image tuple. The automatic handoff supplies an exact expected client dispatcher SHA, so a moving main branch cannot silently change the reviewed release.

Build evidence binds all three asset hashes to client source/version/backend URL. Recovery accepts an explicit prior run/artifact/head tuple, verifies canonical run and workflow provenance, and reuses the exact bytes. It retains intent before tag POST, reconciles accepted-but-lost writes, and never overwrites conflicting refs or assets. A second recovery retains source binding. Only the frozen original beta.8 artifact has a documented source-binding compatibility exception.

The legacy tag-triggered publisher is retired for future source trees. Existing historical trees are unchanged. New source commits must contain retirement and match the main workflow tree before building. Own-repository writes retain GITHUB_TOKEN Contents:write; a preflight guard does not establish the unknown beta.8 tag failure's exact cause or prove hosted tag permission behavior.

A separately approved backend-proof-reader App needs Actions:read only on lc0rp/KeepSidianServer. Configure BACKEND_RELEASE_APP_ID and secret BACKEND_RELEASE_APP_PRIVATE_KEY only after exact approval. The separate server-side dispatcher App needs Actions:write only on this client repository; both repositories configure its exact CLIENT_RELEASE_ACTOR_ID, and this repository additionally configures CLIENT_RELEASE_ACTOR_LOGIN. There are no configured App identities or credentials in this change and no persistent access was granted. Empty identities fail closed. Manual recovery remains restricted to Luke on main.

For recovery, workflow_dispatch release-client.yml on reviewed main with expected_head, backend_run/backend_artifact/backend_head, and recovery_run/recovery_artifact/recovery_head. It skips npm/build. Expired or unverifiable evidence, wrong source, failed backend deploy/refs, unresolved write outcomes and conflicting release assets stop for canonical reconciliation; no blind duplicate publication.

See the paired backend change's `docs/08-operations/release-ci-repair.md` for the incident matrix, full trust/token proposal, exact recovery contract and bounded live-validation plan. See `release/pins.json` for the immutable engine graph. Preserve pinned source/core commits when merging. Keep this plan recovery-only until a new release tuple and budget have been reviewed. No claim of hosted autonomy follows from local tests.
