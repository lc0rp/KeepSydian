import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
});
