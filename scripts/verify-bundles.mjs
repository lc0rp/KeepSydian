#!/usr/bin/env node
/* eslint-env node */

import { readFileSync, existsSync } from "fs";

const REQUIRED_FILES = ["main.js"];

const fail = (message) => {
	console.error(message);
	process.exitCode = 1;
};

const readText = (path) => {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		fail(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return "";
	}
};

const requireElectronPattern = /(?<!["'`])\brequire\(\s*["']electron["']\s*\)/g;
const reviewSafetyPatterns = [
	{
		label: "dynamic <script> element creation",
		pattern: /document\.createElement\(\s*["']script["']\s*\)/g,
	},
	{
		label: "dynamic <style> element creation",
		pattern: /document\.createElement\(\s*["']style["']\s*\)/g,
	},
	{
		label: "string argument passed to setTimeout/setInterval",
		pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
	},
	{
		label: "Function constructor",
		pattern: /\b(?:new\s+)?Function\s*\(/g,
	},
	{
		label: "bundled Playwright/Puppeteer runtime",
		pattern: /\b(?:playwright|puppeteer)\b/i,
	},
];

for (const file of REQUIRED_FILES) {
	if (!existsSync(file)) {
		fail(`Missing build artifact: ${file} (run \`npm run build\`)`);
	}
}

if (process.exitCode) {
	process.exit(process.exitCode);
}

const mainJs = readText("main.js");
if (requireElectronPattern.test(mainJs)) {
	fail(
		'`main.js` contains `require("electron")`. This breaks mobile compatibility; keep Electron access behind desktop-only lazy runtime paths.'
	);
}

for (const { label, pattern } of reviewSafetyPatterns) {
	if (pattern.test(mainJs)) {
		fail(`\`main.js\` contains ${label}. This is blocked by Obsidian community plugin review.`);
	}
}

if (!process.exitCode) {
	console.log("Bundle verification passed: main.js has no prohibited review patterns.");
}
