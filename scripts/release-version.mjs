import semver from "semver";

// Release channels stay alpha/beta; identifiers such as beta.6b are valid SemVer.
export const parseVersion = (version) => {
	const parsed = semver.parse(version, { loose: false });
	if (!parsed || parsed.version !== version || parsed.build.length > 0 ||
		(parsed.prerelease.length > 0 && (parsed.prerelease.length !== 2 ||
			!["alpha", "beta"].includes(parsed.prerelease[0])))) {
		throw new Error(`Invalid release semantic version: ${version}`);
	}
	return {
		major: parsed.major,
		minor: parsed.minor,
		patch: parsed.patch,
		baseVersion: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
		prerelease: parsed.prerelease.length ? {
			channel: parsed.prerelease[0],
			identifier: String(parsed.prerelease[1]),
			number: typeof parsed.prerelease[1] === "number" ? parsed.prerelease[1] : null,
		} : null,
	};
};

export const incrementPrerelease = (parsed) => {
	if (!parsed.prerelease || parsed.prerelease.number === null) {
		throw new Error("An alphanumeric prerelease requires an explicit --version; automatic numbering is ambiguous.");
	}
	return `${parsed.baseVersion}-${parsed.prerelease.channel}.${parsed.prerelease.number + 1}`;
};
