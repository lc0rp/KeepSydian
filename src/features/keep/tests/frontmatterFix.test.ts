import KeepSidianPlugin from "main";
import { ensurePascalCaseFrontmatter } from "../migrations/fixFrontmatterCasing";
import { ambiguousMigrationCases, mixedNewlineMigrationCases } from "./frontmatterFixtures";

describe("ensurePascalCaseFrontmatter", () => {
	function createPlugin(content: string) {
		const adapter = {
			list: jest.fn().mockResolvedValue({ files: ["Keep/note.md"], folders: [] }),
			read: jest.fn().mockResolvedValue(content),
			write: jest.fn().mockResolvedValue(undefined),
		};

		const plugin = {
			app: {
				vault: {
					adapter,
				},
			},
			settings: {
				email: "user@example.com",
				token: "token",
				saveLocation: "Keep",
				keepSidianLastSuccessfulSyncDate: null,
				frontmatterPascalCaseFixApplied: false,
			},
			saveSettings: jest.fn().mockResolvedValue(undefined),
		} as unknown as KeepSidianPlugin;

		return { plugin, adapter };
	}

	it("updates hyphenated frontmatter keys", async () => {
		const original = [
			"---",
			"google-keep-created-date: 2024-01-01T00:00:00Z",
			"google-keep-updated-date: 2024-01-02T00:00:00Z",
			"google-keep-url: https://keep.google.com/#NOTE/fixture",
			"Title: Example",
			"---",
			"Body",
		].join("\n");

		const { plugin, adapter } = createPlugin(original);

		await ensurePascalCaseFrontmatter(plugin);

		expect(adapter.write).toHaveBeenCalledWith(
			"Keep/note.md",
			expect.stringContaining("GoogleKeepCreatedDate: 2024-01-01T00:00:00Z")
		);
		expect(adapter.write).toHaveBeenCalledWith(
			"Keep/note.md",
			expect.stringContaining("GoogleKeepUpdatedDate: 2024-01-02T00:00:00Z")
		);
		expect(adapter.write).toHaveBeenCalledWith(
			"Keep/note.md",
			expect.stringContaining("GoogleKeepUrl: https://keep.google.com")
		);
		expect(plugin.settings.frontmatterPascalCaseFixApplied).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it.each(ambiguousMigrationCases)("leaves ambiguous $kind byte-for-byte unchanged", async ({ body }) => {
		const original = `---\n${body}\n---\nLocal content\n`;
		const { plugin, adapter } = createPlugin(original);
		await ensurePascalCaseFrontmatter(plugin);
		expect(adapter.write).not.toHaveBeenCalled();
		expect(plugin.settings.frontmatterPascalCaseFixApplied).toBe(true);
		await ensurePascalCaseFrontmatter(plugin);
		expect(adapter.read).toHaveBeenCalledTimes(1);
	});

	it.each(mixedNewlineMigrationCases)("preserves every non-key byte with mixed newlines: %j", async (original) => {
		const { plugin, adapter } = createPlugin(original);
		await ensurePascalCaseFrontmatter(plugin);
		expect(adapter.write).toHaveBeenCalledWith("Keep/note.md", original.replace("google-keep-url:", "GoogleKeepUrl:"));
	});

	it.each([
		'google-keep-url: https://keep.google.com/#NOTE/n1\nmetadata: "first\ngoogle-keep-url: literal text\nlast"',
		'google-keep-created-date: "first\ngoogle-keep-created-date: literal text\nlast"',
		'google-keep-url: https://keep.google.com/#NOTE/n1\nmetadata: &cycle\n  self: *cycle',
		'google-keep-url: https://keep.google.com/#NOTE/n1\nmetadata: !!binary aGVsbG8=',
	])("skips an unproven candidate without modifying its original: %s", async (body) => {
		const { plugin, adapter } = createPlugin(`---\n${body}\n---\nBody`);
		await ensurePascalCaseFrontmatter(plugin);
		expect(adapter.write).not.toHaveBeenCalled();
	});

	it("allows a root-key rename while preserving single-line arrays and dates", async () => {
		const original = "---\ngoogle-keep-url: https://keep.google.com/#NOTE/n1\nmetadata: {values: [2024-01-01, null, .nan, true, text]}\n---\nBody";
		const { plugin, adapter } = createPlugin(original);
		await ensurePascalCaseFrontmatter(plugin);
		expect(adapter.write).toHaveBeenCalledWith("Keep/note.md", original.replace("google-keep-url:", "GoogleKeepUrl:"));
	});

	it("does nothing when already applied", async () => {
		const { plugin, adapter } = createPlugin("---\n---\nBody");
		plugin.settings.frontmatterPascalCaseFixApplied = true;

		await ensurePascalCaseFrontmatter(plugin);

		expect(adapter.list).not.toHaveBeenCalled();
		expect(adapter.write).not.toHaveBeenCalled();
	});

	it("marks completion when no files need updates", async () => {
		const { plugin, adapter } = createPlugin("---\nTitle: Example\n---\nBody");

		await ensurePascalCaseFrontmatter(plugin);

		expect(adapter.write).not.toHaveBeenCalled();
		expect(plugin.settings.frontmatterPascalCaseFixApplied).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it("retries on read failure", async () => {
		const { plugin, adapter } = createPlugin("---\n---\nBody");
		adapter.read.mockRejectedValue(new Error("boom"));

		await ensurePascalCaseFrontmatter(plugin);

		expect(plugin.settings.frontmatterPascalCaseFixApplied).toBe(false);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});

	it.each(["google-keep-url: null", "GoogleKeepUrl: https://keep.google.com/#NOTE/n1\ngoogle-keep-url: null"])(
		"preserves invalid identity when migration is called directly: %s", async (identity) => {
			const { plugin, adapter } = createPlugin(`---\n${identity}\n---\nBody`);
			await ensurePascalCaseFrontmatter(plugin);
			expect(adapter.write).not.toHaveBeenCalled();
			expect(plugin.settings.frontmatterPascalCaseFixApplied).toBe(false);
		}
	);

	it.each(["GoogleKeepUrl", '"GoogleKeepUrl"', "'GoogleKeepUrl'"])(
		"preserves equivalent aliases when canonical key %s already exists", async (key) => {
			const original = `---\n${key}: https://keep.google.com/#NOTE/n1\ngoogle-keep-url: https://keep.google.com/u/0/#NOTE/%6E1\n---\nBody`;
			const { plugin, adapter } = createPlugin(original);
			await ensurePascalCaseFrontmatter(plugin);
			expect(adapter.write).not.toHaveBeenCalled();
			expect(plugin.settings.frontmatterPascalCaseFixApplied).toBe(true);
		}
	);

	it("defers a multiline nested document without changing top-level keys", async () => {
		const original = "---\ngoogle-keep-url: https://keep.google.com/#NOTE/n1\nmetadata:\n  google-keep-url: unrelated\n---\nBody";
		const { plugin, adapter } = createPlugin(original);
		await ensurePascalCaseFrontmatter(plugin);
		expect(adapter.write).not.toHaveBeenCalled();
	});

	it("does not treat a migration key in a comment as stored metadata", async () => {
		const { plugin, adapter } = createPlugin("---\n# google-keep-url remains unlinked\n---\nBody");
		await ensurePascalCaseFrontmatter(plugin);
		expect(adapter.write).not.toHaveBeenCalled();
		expect(plugin.settings.frontmatterPascalCaseFixApplied).toBe(true);
	});

	it("preserves an existing quoted date key while migrating a URL with CRLF", async () => {
		const original = '---\r\n"GoogleKeepCreatedDate": 2024-01-01\r\ngoogle-keep-created-date: 2024-01-01\r\ngoogle-keep-url: https://keep.google.com/#NOTE/n1\r\n---\r\nBody';
		const { plugin, adapter } = createPlugin(original);
		await ensurePascalCaseFrontmatter(plugin);
		expect(adapter.write).toHaveBeenCalledWith("Keep/note.md", original.replace("google-keep-url:", "GoogleKeepUrl:"));
	});
});
