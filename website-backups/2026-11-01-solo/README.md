# KeepToObsidian Solo website backup — 2026-11-01

This folder preserves the publicly published page at <https://soloist.ai/keeptoobsidian>. It follows the HyperAqt `website-backups/2026-10-01-solo` convention. This is an archive, not a deployment; plugin code, hosting and release configuration are unchanged.

## Open the backup

Open `index.html` in a browser. Images, stylesheets and fonts are local under `assets/`. If local fonts are restricted, serve this folder with `python3 -m http.server 8000` and open <http://localhost:8000>.

`content.md` contains the readable published text. `source/published.html` preserves server-rendered HTML with scripts and serialized account/settings data removed; it retains remote references and is provenance only. Prefer `index.html` for offline viewing.

## Preserved and excluded

- One historical KeepToObsidian marketing page, including the published $0 and $3/month plans. This is not current KeepSydian documentation.
- 37 public assets: 2 stylesheets, 25 font files, and 10 images/icons, including stylesheet dependencies.
- `asset-inventory.json` records public source URLs, byte counts and local SHA-256 hashes. `verification.json` records checks and limitations. `SHA256SUMS` covers every other file.

The offline page has local asset references, scripts removed, an archive notice, and disabled contact form controls. Content Security Policy blocks network connections and form submission. Public outbound links remain available and require internet when followed.

Following the HyperAqt backup's data-minimization policy, raw embedded page data, account/settings serialization, runtime JavaScript bundles, web manifest and response headers are not included. The original capture ZIP remains separate. No private form submissions, newsletter/customer records, credentials, unpublished drafts or authenticated account export are included.

## Verification and limitations

The original ZIP integrity and file checksums passed before preparation. All archived local resource references resolve and no remote loaded asset references remain in the offline page. The public live page was visually inspected during capture. Offline browser visual verification was unavailable; static verification does not guarantee pixel-identical rendering. Runtime navigation, analytics, consent UI and service backends are not reproduced. Images present only in embedded settings, but not referenced by the rendered page or CSS, were not downloaded.

Original content and third-party assets retain their existing rights and attribution; archiving does not grant redistribution rights.
