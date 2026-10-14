import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Explicit cached binaries avoid installer downloads and quarantine changes.
const cache = process.env.KEEPSIDIAN_TEST_BINARY_CACHE;
if (!cache) throw new Error("Set KEEPSIDIAN_TEST_BINARY_CACHE to an existing Obsidian test binary cache.");
export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./test/specs/i18n.e2e.ts"],
	maxInstances: 1,
	logLevel: "warn",
	reporters: ["obsidian"],
	services: [["obsidian", { versionsUrl: pathToFileURL(resolve(cache, "obsidian-versions.json")).href }]],
	cacheDir: resolve(".obsidian-cache"),
	capabilities: [
		{
			browserName: "obsidian",
			browserVersion: "1.12.4",
			"wdio:chromedriverOptions": { binary: resolve(cache, "electron-chromedriver/darwin-arm64/39.7.0/chromedriver") },
			"wdio:obsidianOptions": {
				installerVersion: "1.12.4",
				plugins: ["."],
				vault: "test/vaults/simple",
				binaryPath: resolve(cache, "obsidian-installer/darwin-arm64/Obsidian-1.12.4/Contents/MacOS/Obsidian"),
				appPath: resolve(cache, "obsidian-app/obsidian-1.12.4.asar"),
			},
		},
	],
	mochaOpts: { ui: "bdd", timeout: 60000 },
};
