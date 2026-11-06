import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	cwd: root, encoding: "utf8",
}).split("\0").filter((file) => file && existsSync(resolve(root, file))))];

test("plugin tests and runner configuration stay inside test/", () => {
	const misplaced = files.filter((file) => !file.startsWith("test/") &&
		(/(?:^|\/)(?:jest|wdio)[^/]*\.config\./.test(file) || /\.(?:test|e2e)\.[cm]?[jt]s$/.test(file)));
	assert.deepEqual(misplaced, []);
});

test("public release tooling is independent of backend control-plane configuration", () => {
	const tooling = files.filter((file) => file.startsWith("scripts/") || file.startsWith("release/") || file.startsWith(".github/workflows/"));
	for (const file of tooling) {
		assert(!/(?:backend_review|hosted-release(?:-beta\d+)?|native_cloud_release|native_client_selection|verify_backend_release)\.py$/.test(file),
			`Backend maintainer helper in plugin tree: ${file}`);
		assert.doesNotMatch(readFileSync(resolve(root, file), "utf8"),
			/KeepSidian(?:Server|Dev|Proj)|\.iam\.gserviceaccount\.com|cloudbuild\.googleapis\.com|buildTriggerId|trigger_id|build_service_account/,
			file);
	}
});

test("test artifacts and caches are ignored by Git", () => {
	for (const artifact of [".tmp/coverage/lcov.info", ".tmp/wdio/run.log", "test-results/probe.png", "screenshots/probe.png", "test/artifacts/probe.json", ".obsidian-cache/probe"]) {
		execFileSync("git", ["check-ignore", "--quiet", "--no-index", artifact], { cwd: root });
	}
});
