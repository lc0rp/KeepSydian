# Short-lived token client candidate

This isolated feature branch enables short-lived authentication by default; it
is not released. Only an explicit build-time `KEEPSIDIAN_ACCESS_V1=false`
selects legacy compatibility. That override is never an automatic fallback.
The exact lowercase value `false` re-enables MASTER-token authentication to
the backend and legacy browser-token registration; it is a security downgrade,
not an operational disable switch. Values such as `FALSE`, `0`, and an empty
value do not disable access-v1. No user settings are changed. Android Google
authentication uses a focused native CapacitorHttp adapter when the observed
host capabilities are present; unsupported native hosts fail closed with no
browser or legacy fallback. Mobile backend requests retain Fetch, and iOS retains
the existing Google Fetch path. Actual native Google and iOS compatibility remain
unverified by these offline implementation tests.

Registration exchanges the existing browser token
directly with Google's fixed auth endpoint using the existing `ac2dm` form.
The resulting master token uses the existing local settings storage. Before an
outbound Keep request, the client exchanges that master for an in-memory access
token requesting exactly `memento`, `reminders`, and `userinfo.email`.

Authenticated requests use the configured HTTPS backend's `/keep/access-v1/`
routes with `X-Keep-Auth-Protocol: access-v1`, `X-User-Email`, and access-only
Bearer credentials. Public capability discovery sends no Google credential.
The server independently verifies identity, scopes, expiry, and current
entitlements. Subscription/customer paths retain their existing behavior.

No enabled request falls back to legacy registration or master-token backend
authentication. Desktop transports explicitly verify TLS before sending the body.
Mobile backend/iOS Fetch relies on browser certificate validation and uses redirect:error,
mode:cors, credentials:omit, cache:no-store and referrerPolicy:no-referrer. It
uses the browser User-Agent deliberately. Android native Google exchange retains
the fixed GoogleAuth/1.4 header, text response mode and serialized form unchanged.
Android native HTTPS uses the host's normal HTTPS/TLS defaults; the adapter installs
no TLS or certificate-verification override. The native redirect/cookie/timeout
fixtures used synthetic HTTP, so they do not establish actual Google HTTPS/TLS
interoperability, which remains unverified.
App/signature/device/scopes are unchanged. A simple form POST may reach Google
before CORS blocks the response; this unknown outcome is never retried.
Decoded streamed bytes and visible response headers are bounded after delivery;
these checks do not cap browser pre-delivery allocation or hidden wire headers.
Binary media remains binary, and text decoding uses fatal UTF-8. Desktop/browser
Google authentication has a 30-second total deadline. Android native Google uses
30-second connect/read inactivity timeouts, not a total deadline or cancellation
guarantee. Native responses are buffered before 16KiB ASCII/text and 8KiB header
validation; these are post-response checks, not native memory caps. The native
host may reuse shared cookies. No cookie omission/isolation/persistence guarantee
is made. Backend requests retain the
legacy client's absence of a total deadline rather than shortening an admitted
paid or mutation operation. Sanitized HTTP status, exact allowlisted server
codes, and bounded Retry-After metadata remain available to existing callers;
these errors explicitly prohibit automatic retries in download and media code.
Refresh occurs before an outbound admission; response failures do not trigger
refresh, replay, or paid/mutation retries. Access expiry must be an absolute
epoch timestamp, with a 60-second admission margin and an explicit maximum
accepted remaining lifetime of 24 hours. These are local admission policies,
not claims about Google's token lifetime.

Compatibility gates remain: Android native Google interoperability, iOS Google
browser-UA/CORS acceptance for the actual app
origin, mobile HTTPS/TLS, backend CORS, iOS, older runtime support and full plugin
loading are not established by this candidate's offline checks. Prior Android
Obsidian 1.12.7/WebView 143 HTTP fixtures verify only their observed redirect,
CORS, abort and stream behavior, not Google compatibility. HTTP backend overrides
fail closed. The perform-oauth Android ID uses the
existing registration constant; the old Python Keep client derived its device
ID locally, so this is an explicit compatibility difference pending validation.
No new device discovery or settings migration is introduced.

Tests use synthetic data and intercept actual client API and HTTPS boundaries;
they do not authenticate accounts or transmit to Google. A dependency symlink
reuses existing installed tools without installations or lockfile changes.

## Operational disable and offline E2E

To stop access-v1 operationally, set server `KEEPSIDIAN_ACCESS_V1_ENABLED=false`: capability/admission
must fail closed with HTTP 503. Keep the client default enabled so unavailable
service cannot cause legacy credential transmission. Do not rebuild with
`KEEPSIDIAN_ACCESS_V1=false` as an operational disable procedure.

Ordinary `e2e:desktop` and `e2e:android` deliberately use `build:e2e:legacy`.
These are synthetic legacy UI compatibility tests, not access-v1 acceptance.
Their bundle blocks Obsidian HTTP, Node network modules, and module-local
fetch/XMLHttpRequest; direct WDIO entry points reject an unmarked production
bundle. The sync-attempt fixture separately pins legacy mode and permits only
its exact loopback sync endpoint. Registration hooks return synthetic tokens.
The default production build remains enabled and contains none of these test
guards. Mobile legacy test success does not establish default-enabled mobile
Keep registration or sync support. Subscription information retains its existing
native transport behavior and does not carry a master token.

Normal `npm test` and the CI `npm run coverage` lane run the three offline lane
and I/O-guard regressions, then all 37 browser-mobile and 55 native-Google regressions,
before Jest. They can also be run directly with
`node --test test/support/legacy-e2e.test.mjs`. Access-v1 Jest tests exercise synthetic transports, including
malformed and missing capability responses. Run `node scripts/test-access-v1-mobile.mjs`
for 37 offline mobile regressions, including explicit-false legacy selection and
abort during a stalled response body; these simulate Fetch behavior and do not
establish live mobile compatibility. No installed-app E2E or live
validation was performed for this repair. Explicit live E2E scripts remain
separate and require their existing authorization and account setup.

The offline E2E banner guards module-local `fetch`/`XMLHttpRequest`, Node network
imports and Obsidian requests; it does not replace host-global `globalThis.fetch`.
The mobile transport uses that global Fetch only in the access-v1 path, which the
ordinary legacy E2E bundle explicitly disables. The mobile explicit-false
regression confirms native legacy routing with zero Fetch calls. This is a
guard for the current call paths, not a general sandbox for future global I/O.

CI selects Node 18.x. The mobile script uses Node's Web Fetch classes, Web Streams
and `node:test`, available in Node 18 ([globals](https://github.com/nodejs/node/blob/v18.20.8/doc/api/globals.md),
[test runner](https://github.com/nodejs/node/blob/v18.20.8/doc/api/test.md)); it runs with installed dependencies and
does not fetch packages or contact test endpoints. Its simulated requests do not
establish compatibility of any actual mobile WebView.

## Android native Google capability boundary

The adapter is selected by actual Obsidian `Platform.isMobileApp` and
`Platform.isAndroidApp` with desktop false, then requires Capacitor's Android
platform, registered CapacitorHttp helper and callable request API. Installed
Obsidian 1.12.7/build303 (APK SHA256
`74a0741f43b0ebb2e8777d4c22b2c33830a97b6be284385e53c3586117136f84`)
source and credential-free runtime fixtures support these capability checks and
`disableRedirects:true`; all returned 3xx are rejected. There is no trustworthy
native-version API in that fixture. Obsidian `apiVersion` follows the desktop
release cycle and is not used as fabricated APK attestation. Other host versions
are capability-gated, not claimed tested; no iOS native support is inferred.

The bridge logs request options and response data conditionally on its own
`isLoggingEnabled` flag. The adapter requires an own boolean false before invocation
and on return, without changing global logging. This assumes host logging remains
disabled during execution. Response logging occurs before promise resolution:
the post-check detects a changed state but cannot prevent an intervening log.
It is not a race-proof no-logging guarantee or a defense against hostile plugins.
Synthetic tests cover false-to-true rejection, absent/unknown/enabled logging,
helper absence, exact form/destination, returned status/URL/data validation and
no retry/fallback. Run `node scripts/test-access-v1-native-google.mjs` independently.
