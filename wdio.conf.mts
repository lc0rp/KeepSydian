import * as path from "path";

// wdio-obsidian-service runs `xattr -cr` on extracted installers on macOS.
// If Homebrew's `xattr` (which doesn't support `-r`) is earlier in PATH, setup fails.
const systemPathPrefix = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
process.env.PATH = `${systemPathPrefix}:${process.env.PATH ?? ""}`;

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./test/specs/**/*.e2e.ts"],
	exclude: ["./test/specs/**/*.live.e2e.ts"],
	// How many instances of Obsidian should be launched in parallel
	maxInstances: 4,

	capabilities: [
		{
			browserName: "obsidian",
			// obsidian app version to download
			browserVersion: "latest",
			"wdio:obsidianOptions": {
				// obsidian installer version
				// (see "Obsidian App vs Installer Versions" below)
				installerVersion: "latest",
				plugins: ["."],
				// If you need to switch between multiple vaults, you can omit
				// this and use reloadObsidian to open vaults during the tests
				vault: "test/vaults/simple",
			},
		},
	],

	services: ["obsidian"],
	// You can use any wdio reporter, but they show the Chromium version
	// instead of the Obsidian version. obsidian reporter just wraps
	// spec reporter to show the Obsidian version.
	reporters: ["obsidian"],

	// wdio-obsidian-service will download Obsidian versions into this directory
	cacheDir: path.resolve(".obsidian-cache"),
	mochaOpts: {
		ui: "bdd",
		timeout: 60000,
		// You can set mocha settings like "retry" and "bail"
	},
	logLevel: "warn",
};
