import type KeepSidianPlugin from "main";
import { requestUrl } from "obsidian";
import { clean, gt, lt, satisfies, valid, validRange } from "semver";
import type { TokenHelperAssetManifest, TokenHelperManifest } from "../../types/token-helper";
import { logRetrievalWizardEvent } from "./retrievalSessionLogger";

declare const require: ((moduleId: string) => unknown) | undefined;

export const TOKEN_HELPER_SOURCE_URL = "https://github.com/lc0rp/keepsidian-token-helper";
export const TOKEN_HELPER_RELEASES_API_URL = "https://api.github.com/repos/lc0rp/keepsidian-token-helper/releases";
export const TOKEN_HELPER_PROTOCOL_VERSION = 1;

export type { TokenHelperAssetManifest, TokenHelperManifest } from "../../types/token-helper";

type FsModule = typeof import("fs");
type OsModule = typeof import("os");
type PathModule = typeof import("path");
type CryptoModule = typeof import("crypto");
type ChildProcessModule = typeof import("child_process");

export type TokenHelperPhase = "checking" | "download" | "verify" | "install" | "launch" | "signin" | "capture";

export interface TokenHelperProgress {
	phase: TokenHelperPhase;
	percent?: number;
	message: string;
}

export type TokenHelperState =
	| { status: "ready"; helperPath: string; installedVersion?: string; latest?: TokenHelperManifest }
	| { status: "missing"; latest: TokenHelperManifest }
	| {
			status: "outdated";
			helperPath: string;
			installedVersion?: string;
			latest: TokenHelperManifest;
	  }
	| {
			status: "incompatible";
			helperPath: string;
			installedVersion?: string;
			latest: TokenHelperManifest;
	  }
	| { status: "unavailable"; reason: string; helperPath?: string; installedVersion?: string };

export type TokenHelperRuntimeEvent =
	| { type: "ready"; version: string; protocolVersion: number }
	| { type: "progress"; phase: TokenHelperPhase; percent?: number; message: string }
	| { type: "token"; oauthToken: string }
	| { type: "error"; code: string; message: string; recoverable?: boolean };

interface RuntimeDeps {
	fs: FsModule;
	os: OsModule;
	path: PathModule;
	crypto: CryptoModule;
	childProcess: ChildProcessModule;
}

interface GitHubReleaseAsset {
	name: string;
	browserDownloadUrl: string;
}

interface GitHubRelease {
	id: number;
	tagName: string;
	draft: boolean;
	prerelease: boolean;
	assets: GitHubReleaseAsset[];
}

interface CompatibilityLookup {
	manifest?: TokenHelperManifest;
	latestSeenReleaseId?: number;
}

const RELEASES_PER_PAGE = 100;
const MAX_RELEASE_PAGES = 10;

const logHelperEvent = (
	level: "info" | "warn" | "error" | "debug",
	message: string,
	metadata: Record<string, unknown> = {}
) => {
	void logRetrievalWizardEvent(level, message, metadata);
};

function loadNodeModule<T>(moduleId: string): T {
	if (typeof require !== "function") {
		throw new Error("Desktop helper unavailable because Node require is not available.");
	}
	return require(moduleId) as T;
}

function loadRuntimeDeps(): RuntimeDeps {
	return {
		fs: loadNodeModule<FsModule>("fs"),
		os: loadNodeModule<OsModule>("os"),
		path: loadNodeModule<PathModule>("path"),
		crypto: loadNodeModule<CryptoModule>("crypto"),
		childProcess: loadNodeModule<ChildProcessModule>("child_process"),
	};
}

function getHelperBaseDir(deps: RuntimeDeps): string {
	return deps.path.join(deps.os.homedir(), ".keepsidian", "token-helper");
}

function getDefaultHelperPath(deps: RuntimeDeps): string {
	const executableName = deps.os.platform() === "win32" ? "keepsidian-token-helper.exe" : "keepsidian-token-helper";
	return deps.path.join(getHelperBaseDir(deps), executableName);
}

export function isTokenHelperInstalled(plugin: KeepSidianPlugin): boolean {
	try {
		const deps = loadRuntimeDeps();
		const helperPath = plugin.settings.tokenHelperPath || getDefaultHelperPath(deps);
		return deps.fs.existsSync(helperPath);
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function normalizeAsset(value: unknown): TokenHelperAssetManifest | null {
	if (!isRecord(value)) {
		return null;
	}
	if (
		typeof value.platform !== "string" ||
		typeof value.arch !== "string" ||
		typeof value.url !== "string" ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/i.test(value.sha256) ||
		(typeof value.size === "number" && (!Number.isInteger(value.size) || value.size < 0))
	) {
		return null;
	}
	return {
		platform: value.platform,
		arch: value.arch,
		url: value.url,
		sha256: value.sha256,
		size: typeof value.size === "number" ? value.size : undefined,
		fileName: typeof value.fileName === "string" ? value.fileName : undefined,
	};
}

function normalizeManifest(value: unknown): TokenHelperManifest | null {
	if (!isRecord(value) || typeof value.version !== "string" || !valid(value.version) || !Array.isArray(value.assets)) {
		return null;
	}
	const assets = value.assets.map(normalizeAsset);
	if (assets.some((asset) => asset === null)) {
		return null;
	}
	const protocolVersions = Array.isArray(value.protocolVersions)
		? value.protocolVersions.filter((protocol): protocol is number => Number.isInteger(protocol))
		: typeof value.protocolVersion === "number"
			? [value.protocolVersion]
			: [];
	const pluginVersionRange =
		typeof value.pluginVersionRange === "string"
			? value.pluginVersionRange
			: typeof value.minPluginVersion === "string"
				? `>=${value.minPluginVersion}`
				: "";
	if (protocolVersions.length === 0 || !pluginVersionRange || !validRange(pluginVersionRange)) {
		return null;
	}
	return {
		version: value.version,
		protocolVersions,
		pluginVersionRange,
		assets: assets as TokenHelperAssetManifest[],
	};
}

function normalizeRelease(value: unknown): GitHubRelease | null {
	if (
		!isRecord(value) ||
		typeof value.id !== "number" ||
		typeof value.tag_name !== "string" ||
		!Array.isArray(value.assets)
	) {
		return null;
	}
	const assets = value.assets.flatMap((asset): GitHubReleaseAsset[] => {
		if (!isRecord(asset) || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") {
			return [];
		}
		return [{ name: asset.name, browserDownloadUrl: asset.browser_download_url }];
	});
	return {
		id: value.id,
		tagName: value.tag_name,
		draft: value.draft === true,
		prerelease: value.prerelease === true,
		assets,
	};
}

function isAllowedDownloadUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "github.com" &&
			url.pathname.startsWith("/lc0rp/keepsidian-token-helper/releases/download/")
		);
	} catch {
		return false;
	}
}

function selectAsset(manifest: TokenHelperManifest, deps: RuntimeDeps): TokenHelperAssetManifest | undefined {
	return manifest.assets.find(
		(candidate) => candidate.platform === deps.os.platform() && candidate.arch === deps.os.arch()
	);
}

function isManifestCompatible(
	manifest: TokenHelperManifest | undefined,
	pluginVersion: string,
	deps: RuntimeDeps
): manifest is TokenHelperManifest {
	if (
		!manifest ||
		!valid(pluginVersion) ||
		!manifest.protocolVersions.includes(TOKEN_HELPER_PROTOCOL_VERSION) ||
		!satisfies(pluginVersion, manifest.pluginVersionRange, { includePrerelease: true })
	) {
		return false;
	}
	const asset = selectAsset(manifest, deps);
	return Boolean(asset && isAllowedDownloadUrl(asset.url));
}

async function fetchReleasePage(page: number): Promise<GitHubRelease[]> {
	const response = await requestUrl({
		url: `${TOKEN_HELPER_RELEASES_API_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`,
		method: "GET",
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	const value = response.json ?? JSON.parse(response.text);
	if (!Array.isArray(value)) {
		throw new Error("GitHub returned an invalid token helper release list.");
	}
	return value.map(normalizeRelease).filter((release): release is GitHubRelease => release !== null);
}

async function fetchReleaseManifest(release: GitHubRelease): Promise<TokenHelperManifest | null> {
	const manifestAsset = release.assets.find((asset) => asset.name === "helper-manifest.json");
	if (!manifestAsset) {
		return null;
	}
	if (!isAllowedDownloadUrl(manifestAsset.browserDownloadUrl)) {
		logHelperEvent("warn", "Ignoring token helper release with an unexpected manifest URL", {
			releaseId: release.id,
		});
		return null;
	}
	const response = await requestUrl({ url: manifestAsset.browserDownloadUrl, method: "GET" });
	const manifest = normalizeManifest(response.json ?? JSON.parse(response.text));
	const releaseVersion = clean(release.tagName);
	if (!manifest || !releaseVersion || manifest.version !== releaseVersion) {
		logHelperEvent("warn", "Ignoring token helper release with invalid compatibility metadata", {
			releaseId: release.id,
			tag: release.tagName,
		});
		return null;
	}
	return manifest;
}

function newerManifest(current: TokenHelperManifest | undefined, candidate: TokenHelperManifest): TokenHelperManifest {
	return !current || gt(candidate.version, current.version) ? candidate : current;
}

async function findLatestCompatibleManifest(plugin: KeepSidianPlugin, deps: RuntimeDeps): Promise<CompatibilityLookup> {
	const pluginVersion = plugin.manifest.version;
	const pluginVersionChanged = plugin.settings.tokenHelperCheckedForPluginVersion !== pluginVersion;
	const lastSeenReleaseId = pluginVersionChanged ? undefined : plugin.settings.tokenHelperLastSeenReleaseId;
	let compatible = isManifestCompatible(plugin.settings.tokenHelperCompatibleManifest, pluginVersion, deps)
		? plugin.settings.tokenHelperCompatibleManifest
		: isManifestCompatible(plugin.settings.tokenHelperInstalledManifest, pluginVersion, deps)
			? plugin.settings.tokenHelperInstalledManifest
			: undefined;
	let latestSeenReleaseId: number | undefined;
	let reachedPreviousScan = false;

	for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
		const releases = await fetchReleasePage(page);
		for (const release of releases) {
			if (lastSeenReleaseId && release.id === lastSeenReleaseId) {
				reachedPreviousScan = true;
				break;
			}
			if (release.draft || release.prerelease) {
				continue;
			}
			const manifest = await fetchReleaseManifest(release);
			if (manifest && typeof latestSeenReleaseId !== "number") {
				latestSeenReleaseId = release.id;
			}
			if (manifest && isManifestCompatible(manifest, pluginVersion, deps)) {
				compatible = newerManifest(compatible, manifest);
				if (pluginVersionChanged || !lastSeenReleaseId) {
					reachedPreviousScan = true;
					break;
				}
			}
		}
		if (reachedPreviousScan || releases.length < RELEASES_PER_PAGE) {
			break;
		}
		if (page === MAX_RELEASE_PAGES) {
			throw new Error("Too many token helper releases were returned to complete a compatibility check.");
		}
	}

	return { manifest: compatible, latestSeenReleaseId };
}

async function saveCompatibilityLookup(plugin: KeepSidianPlugin, lookup: CompatibilityLookup): Promise<void> {
	const pluginVersionChanged = plugin.settings.tokenHelperCheckedForPluginVersion !== plugin.manifest.version;
	plugin.settings.tokenHelperLastCheckedAt = Date.now();
	plugin.settings.tokenHelperCheckedForPluginVersion = plugin.manifest.version;
	if (pluginVersionChanged) {
		plugin.settings.tokenHelperLastSeenReleaseId = lookup.latestSeenReleaseId;
	} else if (typeof lookup.latestSeenReleaseId === "number") {
		plugin.settings.tokenHelperLastSeenReleaseId = lookup.latestSeenReleaseId;
	}
	plugin.settings.tokenHelperCompatibleManifest = lookup.manifest;
	await plugin.saveSettings();
}

export async function getTokenHelperState(plugin: KeepSidianPlugin): Promise<TokenHelperState> {
	const deps = loadRuntimeDeps();
	const helperPath = plugin.settings.tokenHelperPath || getDefaultHelperPath(deps);
	const exists = deps.fs.existsSync(helperPath);
	let lookup: CompatibilityLookup;
	try {
		lookup = await findLatestCompatibleManifest(plugin, deps);
		await saveCompatibilityLookup(plugin, lookup);
	} catch (error) {
		plugin.settings.tokenHelperLastCheckedAt = Date.now();
		await plugin.saveSettings();
		const reason = error instanceof Error ? error.message : String(error);
		const installedManifestCompatible = isManifestCompatible(
			plugin.settings.tokenHelperInstalledManifest,
			plugin.manifest.version,
			deps
		);
		if (exists && (installedManifestCompatible || !plugin.settings.tokenHelperInstalledManifest)) {
			logHelperEvent("warn", "Token helper release check unavailable; using installed helper", { reason });
			return { status: "ready", helperPath, installedVersion: plugin.settings.tokenHelperVersion };
		}
		return { status: "unavailable", reason, helperPath, installedVersion: plugin.settings.tokenHelperVersion };
	}

	const latest = lookup.manifest;
	if (!latest) {
		if (exists && !plugin.settings.tokenHelperInstalledManifest) {
			logHelperEvent("warn", "Using legacy installed helper without cached compatibility metadata");
			return { status: "ready", helperPath, installedVersion: plugin.settings.tokenHelperVersion };
		}
		return {
			status: "unavailable",
			reason: "No compatible token helper release is available for this KeepSidian version.",
			helperPath,
			installedVersion: plugin.settings.tokenHelperVersion,
		};
	}
	if (!exists) {
		return { status: "missing", latest };
	}
	if (plugin.settings.tokenHelperVersion === latest.version) {
		return { status: "ready", helperPath, installedVersion: plugin.settings.tokenHelperVersion, latest };
	}
	if (
		valid(plugin.settings.tokenHelperVersion ?? "") &&
		lt(plugin.settings.tokenHelperVersion as string, latest.version)
	) {
		return { status: "outdated", helperPath, installedVersion: plugin.settings.tokenHelperVersion, latest };
	}
	return { status: "incompatible", helperPath, installedVersion: plugin.settings.tokenHelperVersion, latest };
}

export async function installTokenHelper(
	plugin: KeepSidianPlugin,
	manifest: TokenHelperManifest,
	onProgress: (progress: TokenHelperProgress) => void
): Promise<string> {
	const deps = loadRuntimeDeps();
	if (!isManifestCompatible(manifest, plugin.manifest.version, deps)) {
		throw new Error("This token helper release is not compatible with the installed KeepSidian version.");
	}
	const asset = selectAsset(manifest, deps);
	if (!asset) {
		throw new Error(`No token helper download is available for ${deps.os.platform()}/${deps.os.arch()}.`);
	}
	if (!isAllowedDownloadUrl(asset.url)) {
		throw new Error("Token helper release contains an unexpected download URL.");
	}
	const helperPath = getDefaultHelperPath(deps);
	const helperDir = deps.path.dirname(helperPath);
	const temporaryPath = `${helperPath}.download`;
	onProgress({ phase: "download", percent: 5, message: "Downloading helper..." });
	const response = await requestUrl({ url: asset.url, method: "GET" });
	const body = response.arrayBuffer;
	if (!body) {
		throw new Error("Token helper download did not return a binary response.");
	}
	const bytes = new Uint8Array(body);
	if (typeof asset.size === "number" && bytes.byteLength !== asset.size) {
		throw new Error("Token helper download size did not match the release manifest.");
	}
	onProgress({ phase: "verify", percent: 70, message: "Verifying download..." });
	const digest = deps.crypto.createHash("sha256").update(bytes).digest("hex");
	if (digest.toLowerCase() !== asset.sha256.toLowerCase()) {
		throw new Error("Token helper download failed checksum verification.");
	}
	onProgress({ phase: "install", percent: 85, message: "Installing helper..." });
	deps.fs.mkdirSync(helperDir, { recursive: true });
	try {
		deps.fs.writeFileSync(temporaryPath, bytes);
		if (deps.os.platform() !== "win32") {
			deps.fs.chmodSync(temporaryPath, 0o755);
		}
		if (deps.os.platform() === "win32" && deps.fs.existsSync(helperPath)) {
			deps.fs.unlinkSync(helperPath);
		}
		deps.fs.renameSync(temporaryPath, helperPath);
	} catch (error) {
		if (deps.fs.existsSync(temporaryPath)) {
			deps.fs.unlinkSync(temporaryPath);
		}
		throw error;
	}
	plugin.settings.tokenHelperPath = helperPath;
	plugin.settings.tokenHelperVersion = manifest.version;
	plugin.settings.tokenHelperInstalledManifest = manifest;
	plugin.settings.tokenHelperCompatibleManifest = manifest;
	plugin.settings.tokenHelperConsentAcceptedAt = Date.now();
	await plugin.saveSettings();
	onProgress({ phase: "install", percent: 100, message: "Helper installed." });
	logHelperEvent("info", "Token helper installed", {
		version: manifest.version,
		platform: asset.platform,
		arch: asset.arch,
	});
	return helperPath;
}

function parseHelperLine(line: string): TokenHelperRuntimeEvent | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	const parsed = JSON.parse(trimmed) as TokenHelperRuntimeEvent;
	if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
		throw new Error("Token helper emitted an invalid JSON event.");
	}
	return parsed;
}

export async function runTokenHelper(
	plugin: KeepSidianPlugin,
	onEvent: (event: TokenHelperRuntimeEvent) => Promise<void> | void
): Promise<void> {
	const deps = loadRuntimeDeps();
	const helperPath = plugin.settings.tokenHelperPath || getDefaultHelperPath(deps);
	if (!deps.fs.existsSync(helperPath)) {
		throw new Error("Token helper is not installed.");
	}
	await new Promise<void>((resolve, reject) => {
		const child = deps.childProcess.spawn(
			helperPath,
			[
				"retrieve",
				"--email",
				plugin.settings.email,
				"--protocol",
				String(TOKEN_HELPER_PROTOCOL_VERSION),
				"--format",
				"json",
				"--engine",
				"auto",
			],
			{ stdio: ["ignore", "pipe", "pipe"] }
		);
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let finished = false;
		let helperReady = false;
		let tokenEventPending = false;
		let tokenReceived = false;
		const finish = (error?: Error) => {
			if (finished) {
				return;
			}
			finished = true;
			if (error) {
				if (typeof child.kill === "function") {
					child.kill();
				}
				reject(error);
			} else {
				resolve();
			}
		};
		const handleEvent = (event: TokenHelperRuntimeEvent) => {
			try {
				if (event.type === "ready") {
					if (event.protocolVersion !== TOKEN_HELPER_PROTOCOL_VERSION) {
						finish(new Error(`Token helper protocol ${event.protocolVersion} is not supported.`));
						return;
					}
					if (plugin.settings.tokenHelperVersion && event.version !== plugin.settings.tokenHelperVersion) {
						finish(new Error("Installed token helper version does not match KeepSidian's verified metadata."));
						return;
					}
					helperReady = true;
				}
				if (event.type === "token" && !helperReady) {
					finish(new Error("Token helper returned a token before completing its compatibility handshake."));
					return;
				}
				const eventResult = onEvent(event);
				if (event.type === "token") {
					tokenReceived = true;
					tokenEventPending = true;
					Promise.resolve(eventResult)
						.then(() => {
							tokenEventPending = false;
							finish();
						})
						.catch((error: unknown) => {
							tokenEventPending = false;
							finish(error instanceof Error ? error : new Error(String(error)));
						});
				}
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};
		child.stdout?.on("data", (chunk: { toString: (encoding?: string) => string }) => {
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const event = parseHelperLine(line);
					if (event) {
						handleEvent(event);
					}
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
		child.stderr?.on("data", (chunk: { toString: (encoding?: string) => string }) => {
			stderrBuffer += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => {
			finish(error);
		});
		child.on("close", (code: number | null) => {
			if (finished) {
				return;
			}
			if (code === 0) {
				if (stdoutBuffer.trim()) {
					try {
						const event = parseHelperLine(stdoutBuffer);
						if (event) {
							handleEvent(event);
						}
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
						return;
					}
				}
				if (tokenEventPending) {
					return;
				}
				if (!tokenReceived) {
					finish(new Error("Token helper exited without returning a token."));
					return;
				}
				finish();
				return;
			}
			const suffix = stderrBuffer.trim() ? ` ${stderrBuffer.trim()}` : "";
			finish(new Error(`Token helper exited with code ${code ?? "unknown"}.${suffix}`));
		});
	});
}
