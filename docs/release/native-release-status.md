# Native release transition — inactive draft

The native Cloud Build design supersedes the earlier two-button reviewer-assertion proposal. This branch is not activation-ready. Both native policies are disabled. No trigger, IAM, WIF, release tag, deployment, merge, or paid validation run was changed by this work.

The intended sequence is an externally created server tag triggering Cloud Build, then an externally created client tag selected by the manual GitHub client workflow. The client verifies native build identity, exact image/revision readiness, and maps its version URL before building or publishing. A later client version can reuse that same backend. No GitHub App private key is proposed.

## Implemented and locally exercised

- Exact native build ID, project, trigger, service account, source SHA, tag, successful status and image digest checks.
- Etaged one-shot traffic PATCH; accepted lost responses reconcile through canonical state. Existing alias conflicts fail, all prior traffic remains, and idempotent recovery issues no second PATCH.
- Selected client tag resolution supports annotated tags. Recovery artifacts are checked against the selected source/version/backend/assets before cloud authentication or mapping.
- Server preflight captures current routing while comparing the runtime/security profile to reviewed configuration. The captured baseline stays fixed throughout that build; later releases can preserve aliases added since beta.8.
- Old manual write wrappers disabled in the proposed tree; legacy public release publisher remains retired.

## Independent review — remaining implementation blockers

1. Native server terminal-failure recovery is incomplete. If deployment succeeds but smoke or final images publication fails, the native build is not SUCCESS and the client correctly refuses it. A new build must not be treated as recovery. A durable receipt/native-image lineage and explicit deploy-only recovery path still need implementation and review.
2. Native repository identity must be bound beyond repository-name substitutions. The exact installed connector/source-provenance shape needs supported read-only inspection. Build resource name/location should also be checked.
3. Client verification currently checks exact source/image/readiness/runtime account/model/replay, but not the entire approved resources/secrets/network profile. Do not label it full runtime-profile verification.
4. Availability of resolved source provenance during WORKING is unproven. Fail closed; never substitute an operator-maintained SHA or silently relax identity checks.
5. New engine/core pins are draft checkpoints, not independent-review approval. Mutable builder images need reviewed immutable digests before activation.

The review's earlier baseline and API-prefix findings were addressed in the working draft; the scoped second review confirmed all three fixes. Reviewer ran 32 tests and six offline API rejection checks. Overall approval remains withheld for the open findings above.

## Actual trust finding and approval boundary

Retained evidence authorizes only the old server GitHub workflow: project number 162887264002, pool keepsidian-deploy/provider github-server-main, repository ID 824188057, actor/owner 2609441, main/manual/server wrapper and core SHA 43db9a2cf399d63290085813cd77569cd9af58ae. It does not authorize client repository 822100323. The proposed old server repin was not applied.

The retained Cloud Build trigger 43a37949-e2fa-4539-8bac-4404840f8c72 is disabled and matches main. Its retained build identity is the broad default Compute service account; do not re-enable that configuration. A fresh supported read was blocked by filesystem access to gcloud's credential cache. No cache copy, token extraction or authentication workaround was attempted. This is not evidence of expired credentials.

The smallest proposed activation bundle, still requiring exact review/approval after fresh metadata inspection, is:

- Separate client pool keepsidian-client-release/provider github-client-main and service account keepsidian-client-mapper@lc0rp-labs.iam.gserviceaccount.com. Trust only lc0rp/KeepSydian repository ID 822100323, owner/actor 2609441, triggering actor lc0rp enforced by workflow, main, workflow_dispatch, GitHub-hosted runner, exact wrapper path and independently reviewed reusable-core SHA. Subject must be repo:lc0rp/KeepSydian:ref:refs/heads/main. Do not modify or broaden the existing server provider.
- Client effective permissions: Cloud Build build read in lc0rp-labs; Cloud Run service get/update and revision get restricted to keepsidianserver where supported. `run.services.update` is broader than traffic-only: code narrows its use, IAM does not. Determine whether runtime actAs or registry reads are required using effective-permission evidence; do not grant them by inference. Project-level build read exposes private build metadata to the trusted public-client workflow and needs explicit approval.
- Dedicated keepsidian-cloudbuild@lc0rp-labs.iam.gserviceaccount.com. Proposed rights are repository-scoped Artifact Registry read/write, service-scoped Cloud Run get/update and revision get, actAs on the dedicated keepsidian-runtime account only, native build read and build logging. Resolve exact custom-role permission lists and binding resources before applying. No project Editor, secret payload read, custom App key, or arbitrary identity impersonation.
- Retarget the existing disabled trigger to reviewed external sv* tags and cloudbuild.yaml using that dedicated identity. Verify the existing Google-managed GitHub installation/repository connection and tag protection. Tagged source controls the deploy-capable build configuration, so allowed tag creators are a deployment trust boundary.

This is a design/permission inventory, not a grant command or an exact approval packet. Do not request approval to execute it until resource scopes, native connector evidence, core pins and recovery design are complete.

## Bounded live validation still to approve

No old budget carries over. First inspect connector/trigger/build/service/IAM metadata with supported read-only access. Then approve exact versions/source tags, immutable configuration, persistent grants and spend limits. Proposed jobs are bounded to 30 minutes each; normal client runs currently perform up to 15 application GETs across prebuild verification, prepublication verification and publication checks. These smoke routes invoke no AI; deployment/build/registry/Actions costs remain real and unapproved.

Required evidence: one new backend build and verified version URL; paired client publication; a second explicitly approved client version reusing that backend with zero backend build; injected partial failures recovered using exact original image/assets; rejected conflicting alias and mismatched artifact without mutation. Record native IDs, immutable image digests, revision readiness, all traffic before/after, exact GitHub run/artifact/core/source IDs and asset hashes. Until actually run, each live result is NOT RUN, never PASS based on mocks.

## Local validation checkpoint

Server full suite: 681 passed, 4 skipped, 90.09% coverage. Client Python suite: 113 tests, 7 skipped. Ruff and changed-workflow actionlint passed. New native mapper tests cover lost/rejected PATCH, conflicts, idempotence, backend reuse, source/image identity failures, readiness/runtime failures and smoke failure recovery. Four server baseline tests cover later aliases, runtime drift, non-convergence and existing version rejection. These are offline checks; live E2E is NOT RUN.
