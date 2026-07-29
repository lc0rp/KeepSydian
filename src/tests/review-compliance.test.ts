import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { satisfies } from "semver";

const rootPath = resolve(__dirname, "../..");

function readProjectFile(path: string): string {
	return readFileSync(resolve(rootPath, path), "utf8");
}

describe("Obsidian community review compliance", () => {
	it("keeps manifest copy and README free of review placeholders", () => {
		const manifest = JSON.parse(readProjectFile("manifest.json")) as {
			description: string;
		};
		const readme = readProjectFile("README.md");

		expect(manifest.description).not.toMatch(/\bObsidian\b/i);
		expect(readme).not.toMatch(/\[(?:description|todo)\]/i);
		expect(readme).not.toMatch(/\b(?:TODO|TBD)\b/);
	});

	it("uses window-qualified timers in every reviewed source file", () => {
		const reviewedFiles = [
			"src/app/main.ts",
			"src/app/sync-ui.ts",
			"src/features/keep/io/attachments.ts",
			"src/features/keep/sync.ts",
		];

		for (const path of reviewedFiles) {
			const source = readProjectFile(path);
			expect(source).not.toMatch(/(?<![\w.])(?:set|clear)(?:Timeout|Interval)\s*\(/);
		}
	});

	it("keeps sync status APIs compatible with the declared minimum app version", () => {
		expect(readProjectFile("src/app/sync-ui.ts")).not.toContain(".messageEl");
	});

	it("avoids main-window DOM globals and cross-window-unsafe element checks", () => {
		const reviewedFiles = [
			"src/ui/modals/SyncProgressModal.ts",
			"src/ui/settings/KeepSidianSettingsTab/tokenSettings.ts",
			"src/ui/settings/SubscriptionSettingsTab.ts",
		];

		for (const path of reviewedFiles) {
			const source = readProjectFile(path);
			expect(source).not.toMatch(/(?<![\w.])document\.(?:createElement|createDocumentFragment|createTextNode)/);
			expect(source).not.toMatch(/\binstanceof HTML(?:Button|Div|Span)Element\b/);
		}
	});

	it("avoids the review-flagged global, coercion, and assertion patterns", () => {
		const tokenExchange = readProjectFile("src/integrations/google/keepTokenExchange.ts");
		const keepApi = readProjectFile("src/integrations/server/keepApi.ts");
		const importOptionsModal = readProjectFile("src/ui/modals/NoteImportOptionsModal.ts");

		expect(tokenExchange).not.toContain("globalThis");
		expect(tokenExchange).not.toContain('"Failed to parse server response: " +');
		expect(tokenExchange).not.toMatch(/\berror as Error\b/);
		expect(keepApi).not.toMatch(/\bresponse as unknown\b/);
		expect(importOptionsModal).not.toMatch(/premiumFeatures as NoteImportOptions/);
	});

	it("does not disable community-enforced settings rules", () => {
		const reviewedFiles = [
			"src/ui/settings/KeepSidianSettingsTab.ts",
			"src/ui/settings/KeepSidianSettingsTab/tokenSettings.ts",
			"src/ui/settings/SubscriptionSettingsTab.ts",
		];

		for (const path of reviewedFiles) {
			const source = readProjectFile(path);
			expect(source).not.toMatch(
				/eslint-disable[^\n]*obsidianmd\/(?:settings-tab\/no-problematic-settings-headings|ui\/sentence-case)/
			);
		}
	});

	it("uses Obsidian DOM creation helpers in reviewed production source", () => {
		const reviewedFiles = [
			"src/app/main.ts",
			"src/ui/modals/SyncProgressModal.ts",
			"src/ui/settings/KeepSidianSettingsTab/tokenSettings.ts",
			"src/ui/settings/SubscriptionSettingsTab.ts",
		];

		for (const path of reviewedFiles) {
			expect(readProjectFile(path)).not.toMatch(/\.createElement\s*\(/);
		}
	});

	it("keeps the release workflow descriptive and provenance-attested", () => {
		const releaseWorkflow = readProjectFile(".github/workflows/release.yml");

		expect(releaseWorkflow).toContain("attestations: write");
		expect(releaseWorkflow).toContain("id-token: write");
		expect(releaseWorkflow).toContain("actions/attest@");
		expect(releaseWorkflow).toContain("--generate-notes");
	});

	it("does not rely on important CSS overrides", () => {
		expect(readProjectFile("styles.css")).not.toContain("!important");
	});

	it("locks every dependency named by the review to a remediated version", () => {
		const lock = JSON.parse(readProjectFile("package-lock.json")) as {
			packages: Record<string, { version?: string }>;
		};
		const safeRanges: Record<string, string> = {
			"@babel/core": ">7.29.0",
			"brace-expansion": ">=1.1.13 <2 || >=2.0.3 <3 || >=5.0.5",
			"js-yaml": ">=3.15.0 <4 || >=4.3.0",
			picomatch: ">=2.3.2 <3 || >=4.0.4",
		};

		for (const [dependency, safeRange] of Object.entries(safeRanges)) {
			const versions = Object.entries(lock.packages)
				.filter(([path]) => path === `node_modules/${dependency}` || path.endsWith(`/node_modules/${dependency}`))
				.map(([, metadata]) => metadata.version)
				.filter((version): version is string => version !== undefined);

			expect(versions.length).toBeGreaterThan(0);
			expect(versions.filter((version) => !satisfies(version, safeRange))).toEqual([]);
		}
	});
});
