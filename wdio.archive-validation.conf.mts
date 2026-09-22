import * as fs from "node:fs";
import * as path from "node:path";
import { config as base } from "./wdio.conf.mts";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Set ${name} for isolated archive validation.`);
	return value;
}

function requiredFile(name: string): string {
	const file = path.resolve(required(name));
	if (!fs.statSync(file).isFile()) throw new Error(`${name} must point to an existing file.`);
	return file;
}

// Explicit local files avoid installer extraction (including hdiutil on macOS).
// Keep their actual versions paired; never mix a local executable with an implicit "latest" app.
const binaryPath = requiredFile("OBSIDIAN_BINARY_PATH");
const appPath = requiredFile("OBSIDIAN_APP_PATH");
const appVersion = required("OBSIDIAN_APP_VERSION");
const installerVersion = required("OBSIDIAN_INSTALLER_VERSION");

export const config: WebdriverIO.Config = {
	...base,
	maxInstances: 1,
	capabilities: [
		{
			browserName: "obsidian",
			browserVersion: appVersion,
			"wdio:obsidianOptions": {
				appVersion,
				installerVersion,
				binaryPath,
				appPath,
				plugins: ["."],
				vault: "test/vaults/simple",
				// Keep WDIO's sandboxed profile and copy the fixture vault before launching.
				copy: true,
			},
		},
	],
};
