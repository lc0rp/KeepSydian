import * as path from "path";
import fs from "node:fs";

// See note in `wdio.conf.mts` (Homebrew's `xattr` breaks Obsidian installer setup on macOS).
const systemPathPrefix = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
process.env.PATH = `${systemPathPrefix}:${process.env.PATH ?? ""}`;

// Appium/ADB require an Android SDK path. If not already set, default to the
// standard Android Studio SDK location on macOS.
if (!process.env.ANDROID_SDK_ROOT && !process.env.ANDROID_HOME) {
	const defaultSdkRoot = path.resolve(process.env.HOME ?? "", "Library/Android/sdk");
	if (fs.existsSync(defaultSdkRoot)) {
		process.env.ANDROID_SDK_ROOT = defaultSdkRoot;
		process.env.ANDROID_HOME = defaultSdkRoot;
	}
}

const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
if (sdkRoot) {
	const androidPathParts = [
		path.join(sdkRoot, "platform-tools"),
		path.join(sdkRoot, "emulator"),
		path.join(sdkRoot, "cmdline-tools/latest/bin"),
	];
	process.env.PATH = `${androidPathParts.join(":")}:${process.env.PATH ?? ""}`;
}

const avdName = process.env.OBSIDIAN_AVD ?? "obsidian_test";

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./test/specs/**/*.e2e.ts"],
	exclude: ["./test/specs/**/*.live.e2e.ts"],

	// can't do android tests in parallel :(
	maxInstances: 1,

	capabilities: [
		{
			browserName: "obsidian",
			// obsidian app version to download
			browserVersion: "latest",
			platformName: "Android",
			"appium:automationName": "UiAutomator2",
			"appium:avd": avdName,
			// wdio-obsidian-service will handle installing and launching Obsidian
			"appium:noReset": true,
			"wdio:obsidianOptions": {
				plugins: ["."],
				vault: "test/vaults/simple",
			},
		},
	],

	services: [
		"obsidian",
		[
			"appium",
			{
				// Appium v3 requires insecure features to be in the form "<driver|*>:<feature>"
				args: { allowInsecure: "*:chromedriver_autodownload,*:adb_shell" },
			},
		],
	],

	reporters: ["obsidian"],

	// wdio-obsidian-service will download Obsidian versions into this directory
	cacheDir: path.resolve(".obsidian-cache"),
	mochaOpts: {
		ui: "bdd",
		timeout: 60000,
	},
	logLevel: "warn",
};
