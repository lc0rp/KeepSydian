import assert from "node:assert/strict";
import test from "node:test";
import { incrementPrerelease, parseVersion } from "./release-version.mjs";

test("beta.6b is accepted without truncating its identifier to 6", () => {
	const parsed = parseVersion("2.1.0-beta.6b");
	assert.equal(parsed.prerelease.identifier, "6b");
	assert.equal(parsed.prerelease.number, null);
	assert.throws(() => incrementPrerelease(parsed), /explicit --version/);
});

test("numeric automatic releases and stable releases retain their behavior", () => {
	assert.equal(incrementPrerelease(parseVersion("2.1.0-beta.6")), "2.1.0-beta.7");
	assert.equal(incrementPrerelease(parseVersion("2.1.0-alpha.9")), "2.1.0-alpha.10");
	assert.equal(parseVersion("2.1.0").prerelease, null);
});

test("invalid or unsupported release identifiers fail before mutation", () => {
	for (const version of ["v2.1.0", "02.1.0", "2.1.0-beta.06", "2.1.0-beta", "2.1.0-rc.1", "2.1.0-beta.6+build", "2.1.0-beta.6;echo bad"]) {
		assert.throws(() => parseVersion(version), /Invalid release semantic version/);
	}
});
