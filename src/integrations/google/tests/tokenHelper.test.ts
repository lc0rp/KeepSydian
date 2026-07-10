/**
 * @jest-environment jsdom
 */
import { EventEmitter } from "events";
import { requestUrl } from "obsidian";
import type KeepSidianPlugin from "main";
import { getTokenHelperState, installTokenHelper, runTokenHelper, type TokenHelperManifest } from "../tokenHelper";
import { DEFAULT_SETTINGS } from "../../../types/keepsidian-plugin-settings";

jest.mock("obsidian", () => ({
	...jest.requireActual("obsidian"),
	requestUrl: jest.fn(),
}));

jest.mock("fs", () => ({
	existsSync: jest.fn(),
	mkdirSync: jest.fn(),
	writeFileSync: jest.fn(),
	chmodSync: jest.fn(),
	renameSync: jest.fn(),
	unlinkSync: jest.fn(),
}));

jest.mock("os", () => ({
	homedir: jest.fn(() => "/tmp/keepsidian-home"),
	platform: jest.fn(() => "darwin"),
	arch: jest.fn(() => "arm64"),
}));

jest.mock("child_process", () => ({
	spawn: jest.fn(),
}));

const fsMock = jest.requireMock("fs") as {
	existsSync: jest.Mock;
	mkdirSync: jest.Mock;
	writeFileSync: jest.Mock;
	chmodSync: jest.Mock;
	renameSync: jest.Mock;
	unlinkSync: jest.Mock;
};

const childProcessMock = jest.requireMock("child_process") as {
	spawn: jest.Mock;
};

const requestUrlMock = requestUrl as unknown as jest.Mock;

function createManifest(
	version = "0.2.0",
	pluginVersionRange = ">=2.0.15 <3.0.0",
	protocolVersions = [1]
): TokenHelperManifest {
	return {
		version,
		pluginVersionRange,
		protocolVersions,
		assets: [
			{
				platform: "darwin",
				arch: "arm64",
				url: `https://github.com/lc0rp/keepsidian-token-helper/releases/download/v${version}/helper`,
				sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
				size: 5,
			},
		],
	};
}

interface MockRelease {
	id: number;
	manifest?: TokenHelperManifest;
	tag?: string;
	prerelease?: boolean;
}

function mockReleaseLookup(releases: MockRelease[]): void {
	requestUrlMock.mockResolvedValueOnce({
		json: releases.map((release) => ({
			id: release.id,
			tag_name: release.tag ?? `v${release.manifest?.version ?? "0.0.0"}`,
			draft: false,
			prerelease: release.prerelease ?? false,
			assets: release.manifest
				? [
						{
							name: "helper-manifest.json",
							browser_download_url: `https://github.com/lc0rp/keepsidian-token-helper/releases/download/v${release.manifest.version}/helper-manifest.json`,
						},
					]
				: [],
		})),
		text: "",
	});
	for (const release of releases) {
		if (release.manifest) {
			requestUrlMock.mockResolvedValueOnce({
				json: release.manifest,
				text: JSON.stringify(release.manifest),
			});
		}
	}
}

function createPlugin(
	settings: Partial<KeepSidianPlugin["settings"]> = {},
	pluginVersion = "2.0.15"
): KeepSidianPlugin {
	return {
		settings: {
			...DEFAULT_SETTINGS,
			email: "test@example.com",
			...settings,
		},
		saveSettings: jest.fn().mockResolvedValue(undefined),
		manifest: { version: pluginVersion },
	} as unknown as KeepSidianPlugin;
}

function createMockProcess(): EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
} {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	const copy = new ArrayBuffer(buffer.byteLength);
	new Uint8Array(copy).set(buffer);
	return copy;
}

describe("token helper manager", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		requestUrlMock.mockReset();
		fsMock.existsSync.mockReturnValue(false);
	});

	test("reports missing helper with the newest compatible release", async () => {
		const plugin = createPlugin();
		const manifest = createManifest();
		mockReleaseLookup([{ id: 20, manifest }]);

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({ status: "missing", latest: manifest });
		expect(plugin.settings.tokenHelperLastSeenReleaseId).toBe(20);
		expect(plugin.settings.tokenHelperCheckedForPluginVersion).toBe("2.0.15");
	});

	test("reports ready helper when the installed version is current", async () => {
		const manifest = createManifest();
		const plugin = createPlugin({
			tokenHelperPath: "/tmp/helper",
			tokenHelperVersion: manifest.version,
			tokenHelperInstalledManifest: manifest,
		});
		fsMock.existsSync.mockReturnValue(true);
		mockReleaseLookup([{ id: 20, manifest }]);

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({
			status: "ready",
			helperPath: "/tmp/helper",
			installedVersion: "0.2.0",
		});
	});

	test("reports outdated helper when a newer compatible release exists", async () => {
		const installedManifest = createManifest("0.1.0");
		const latestManifest = createManifest("0.2.0");
		const plugin = createPlugin({
			tokenHelperPath: "/tmp/helper",
			tokenHelperVersion: installedManifest.version,
			tokenHelperInstalledManifest: installedManifest,
		});
		fsMock.existsSync.mockReturnValue(true);
		mockReleaseLookup([{ id: 20, manifest: latestManifest }]);

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({
			status: "outdated",
			installedVersion: "0.1.0",
			latest: latestManifest,
		});
	});

	test("skips a newer incompatible release and selects the next compatible release", async () => {
		const incompatibleManifest = createManifest("1.0.0", ">=3.0.0");
		const compatibleManifest = createManifest("0.3.0");
		const plugin = createPlugin();
		mockReleaseLookup([
			{ id: 30, manifest: incompatibleManifest },
			{ id: 20, manifest: compatibleManifest },
		]);

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({ status: "missing", latest: compatibleManifest });
		expect(plugin.settings.tokenHelperLastSeenReleaseId).toBe(30);
	});

	test("does not cache a release until its compatibility manifest is available", async () => {
		const compatibleManifest = createManifest("0.3.0");
		const plugin = createPlugin();
		mockReleaseLookup([
			{ id: 30, tag: "v0.4.0" },
			{ id: 20, manifest: compatibleManifest },
		]);

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({ status: "missing", latest: compatibleManifest });
		expect(plugin.settings.tokenHelperLastSeenReleaseId).toBe(20);
	});

	test("checks only releases newer than the cached release ID", async () => {
		const cachedManifest = createManifest("0.2.0");
		const newManifest = createManifest("0.3.0");
		const plugin = createPlugin({
			tokenHelperCompatibleManifest: cachedManifest,
			tokenHelperLastSeenReleaseId: 20,
			tokenHelperCheckedForPluginVersion: "2.0.15",
		});
		mockReleaseLookup([
			{ id: 30, manifest: newManifest },
			{ id: 20, manifest: cachedManifest },
		]);

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({ status: "missing", latest: newManifest });
		expect(requestUrlMock).toHaveBeenCalledTimes(2);
	});

	test("rescans compatibility when the KeepSidian version changes", async () => {
		const latestManifest = createManifest("0.3.0");
		const plugin = createPlugin({
			tokenHelperLastSeenReleaseId: 30,
			tokenHelperCheckedForPluginVersion: "2.0.14",
		});
		mockReleaseLookup([{ id: 30, manifest: latestManifest }]);

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({ status: "missing", latest: latestManifest });
		expect(requestUrlMock).toHaveBeenCalledTimes(2);
	});

	test("reports incompatible when the installed helper is newer than the compatible target", async () => {
		const installedManifest = createManifest("1.0.0", ">=3.0.0");
		const compatibleManifest = createManifest("0.3.0");
		const plugin = createPlugin({
			tokenHelperPath: "/tmp/helper",
			tokenHelperVersion: installedManifest.version,
			tokenHelperInstalledManifest: installedManifest,
		});
		fsMock.existsSync.mockReturnValue(true);
		mockReleaseLookup([{ id: 20, manifest: compatibleManifest }]);

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({ status: "incompatible", latest: compatibleManifest });
	});

	test("uses a compatible installed helper when the release check fails", async () => {
		const installedManifest = createManifest();
		const plugin = createPlugin({
			tokenHelperPath: "/tmp/helper",
			tokenHelperVersion: installedManifest.version,
			tokenHelperInstalledManifest: installedManifest,
		});
		fsMock.existsSync.mockReturnValue(true);
		requestUrlMock.mockRejectedValueOnce(new Error("Network error"));

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({
			status: "ready",
			helperPath: "/tmp/helper",
			installedVersion: "0.2.0",
		});
	});

	test("reports unavailable when the release check fails and no helper is installed", async () => {
		const plugin = createPlugin();
		requestUrlMock.mockRejectedValueOnce(new Error("Network error"));

		const state = await getTokenHelperState(plugin);

		expect(state).toMatchObject({ status: "unavailable", reason: "Network error" });
	});

	test("rejects helper download when checksum mismatches", async () => {
		const plugin = createPlugin();
		const manifest = createManifest();
		requestUrlMock.mockResolvedValueOnce({ arrayBuffer: toArrayBuffer(Buffer.from("world")) });

		await expect(installTokenHelper(plugin, manifest, jest.fn())).rejects.toThrow("checksum verification");
		expect(fsMock.writeFileSync).not.toHaveBeenCalled();
	});

	test("installs helper atomically after verifying checksum", async () => {
		const plugin = createPlugin();
		const manifest = createManifest();
		requestUrlMock.mockResolvedValueOnce({ arrayBuffer: toArrayBuffer(Buffer.from("hello")) });
		const onProgress = jest.fn();

		const helperPath = await installTokenHelper(plugin, manifest, onProgress);

		expect(helperPath).toBe("/tmp/keepsidian-home/.keepsidian/token-helper/keepsidian-token-helper");
		expect(fsMock.writeFileSync).toHaveBeenCalledWith(`${helperPath}.download`, expect.any(Uint8Array));
		expect(fsMock.chmodSync).toHaveBeenCalledWith(`${helperPath}.download`, 0o755);
		expect(fsMock.renameSync).toHaveBeenCalledWith(`${helperPath}.download`, helperPath);
		expect(plugin.settings.tokenHelperVersion).toBe("0.2.0");
		expect(plugin.settings.tokenHelperInstalledManifest).toEqual(manifest);
	});

	test("launches helper after a valid ready handshake and emits the token", async () => {
		const plugin = createPlugin({ tokenHelperPath: "/tmp/helper", tokenHelperVersion: "0.2.0" });
		fsMock.existsSync.mockReturnValue(true);
		const child = createMockProcess();
		childProcessMock.spawn.mockReturnValue(child);
		const onEvent = jest.fn();

		const runPromise = runTokenHelper(plugin, onEvent);
		child.stdout.emit(
			"data",
			Buffer.from(
				'{"type":"ready","version":"0.2.0","protocolVersion":1}\n{"type":"token","oauthToken":"oauth2_4/test"}\n'
			)
		);
		child.emit("close", 0);
		await runPromise;

		expect(onEvent).toHaveBeenCalledWith({ type: "ready", version: "0.2.0", protocolVersion: 1 });
		expect(onEvent).toHaveBeenCalledWith({ type: "token", oauthToken: "oauth2_4/test" });
	});

	test("rejects a token emitted before the ready handshake", async () => {
		const plugin = createPlugin({ tokenHelperPath: "/tmp/helper" });
		fsMock.existsSync.mockReturnValue(true);
		const child = createMockProcess();
		childProcessMock.spawn.mockReturnValue(child);

		const runPromise = runTokenHelper(plugin, jest.fn());
		child.stdout.emit("data", Buffer.from('{"type":"token","oauthToken":"oauth2_4/test"}\n'));

		await expect(runPromise).rejects.toThrow("compatibility handshake");
	});

	test("rejects an unsupported helper protocol", async () => {
		const plugin = createPlugin({ tokenHelperPath: "/tmp/helper", tokenHelperVersion: "0.2.0" });
		fsMock.existsSync.mockReturnValue(true);
		const child = createMockProcess();
		childProcessMock.spawn.mockReturnValue(child);

		const runPromise = runTokenHelper(plugin, jest.fn());
		child.stdout.emit("data", Buffer.from('{"type":"ready","version":"0.2.0","protocolVersion":2}\n'));

		await expect(runPromise).rejects.toThrow("protocol 2 is not supported");
	});
});
