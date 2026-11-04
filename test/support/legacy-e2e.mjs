import { readFileSync } from "node:fs";

export const OFFLINE_MARKER = "/* KEEPSIDIAN_LEGACY_E2E_NO_EXTERNAL_IO */";

/** Test bundles only: no external HTTP, even when a synthetic exchange hook is missing. */
export function offlineBanner(syncOrigin = "") {
	if (syncOrigin && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(syncOrigin)) {
		throw new Error("E2E sync origin must be explicit IPv4 loopback");
	}
	return `${OFFLINE_MARKER}
var fetch = function() { throw new Error("E2E fetch blocked"); };
var XMLHttpRequest = function() { throw new Error("E2E XMLHttpRequest blocked"); };
const __e2eNativeRequire = require;
require = function(id) {
  if (/^(node:)?(https?|http2|net|tls|dgram|dns)$/.test(id)) throw new Error("E2E network module blocked");
  const native = __e2eNativeRequire(id);
  if (id !== "obsidian") return native;
  const guard = function(input) {
    const target = new URL(typeof input === "string" ? input : input.url);
    if (!${JSON.stringify(syncOrigin)} || target.origin !== ${JSON.stringify(syncOrigin)} ||
        !target.pathname.startsWith("/keep/sync/") || target.username || target.password)
      throw new Error("E2E external request blocked");
  };
  return { ...native,
    requestUrl: function(input) { guard(input); return native.requestUrl(input); },
    request: function(input) { guard(input); return native.request(input); }
  };
};
`;
}

export function assertOfflineBundle(bundlePath = "main.js") {
	const source = readFileSync(bundlePath, "utf8");
	if (!source.startsWith("/*") || !source.slice(0, 500).includes(OFFLINE_MARKER)) {
		throw new Error("Ordinary E2E requires npm run build:e2e:legacy; production bundles are refused.");
	}
}
