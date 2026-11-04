import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { offlineBanner, assertOfflineBundle } from "./legacy-e2e.mjs";

test("ordinary E2E blocks Google, backend, and missing-hook registration before native I/O", () => {
  let calls = 0;
  const context = { URL, require: () => { calls++; return { requestUrl: () => { calls++; }, request: () => { calls++; } }; } };
  runInNewContext(offlineBanner(), context);
  const native = context.require("obsidian");
  assert.throws(() => context.fetch("https://backend.invalid"), /blocked/);
  assert.throws(() => new context.XMLHttpRequest(), /blocked/);
  calls = 0;
  for (const url of ["https://android.clients.google.com/auth", "https://backend.invalid/register", "http://127.0.0.1:8080/keep/sync/v2"]) {
    assert.throws(() => native.requestUrl({ url }), /blocked/);
    assert.throws(() => native.request(url), /blocked/);
  }
  for (const id of ["https", "node:https", "http", "net", "tls"]) assert.throws(() => context.require(id), /blocked/);
  assert.equal(calls, 0);
});

test("sync-attempt permits only its exact loopback sync origin", () => {
  let calls = 0;
  const context = { URL, require: () => ({ requestUrl: () => ++calls }) };
  runInNewContext(offlineBanner("http://127.0.0.1:43210"), context);
  const native = context.require("obsidian");
  native.requestUrl({ url: "http://127.0.0.1:43210/keep/sync/v2" });
  for (const url of ["http://127.0.0.1:43211/keep/sync/v2", "http://127.0.0.1:43210/register", "https://android.clients.google.com/auth"])
    assert.throws(() => native.requestUrl({ url }), /blocked/);
  assert.equal(calls, 1);
});

test("build defaults enabled; only exact lowercase false or explicit test lane selects legacy", () => {
  const source = readFileSync("esbuild.config.mjs", "utf8");
  const expression = source.match(/"process.env.KEEPSIDIAN_ACCESS_V1": JSON.stringify\(([^\n]+)\),/)[1];
  for (const value of [undefined, "", "true", "FALSE", "0", "false"]) {
    for (const legacyE2E of [false, true]) {
      assert.equal(runInNewContext(expression, { legacyE2E, process: { env: { KEEPSIDIAN_ACCESS_V1: value } } }), legacyE2E || value === "false" ? "false" : "true");
    }
  }
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.match(scripts["e2e:desktop"], /^npm run build:e2e:legacy &&/);
  assert.match(scripts["e2e:android"], /^npm run build:e2e:legacy &&/);
  assert.match(scripts["build:e2e:legacy"], /production legacy-e2e$/);
  assert.throws(() => assertOfflineBundle("esbuild.config.mjs"), /production bundles are refused/);
  for (const file of ["wdio.conf.mts", "wdio.mobile.conf.mts"]) assert.match(readFileSync(file, "utf8"), /assertOfflineBundle\(\)/);
  const sync = readFileSync("test/specs/sync-attempt.e2e.ts", "utf8");
  assert.match(sync, /offlineBanner\(`http:\/\/127.0.0.1:/);
  assert.match(sync, /"process.env.KEEPSIDIAN_ACCESS_V1": JSON.stringify\("false"\)/);
});
