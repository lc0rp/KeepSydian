import { resolveLoadedSettings, type KeepSidianPluginSettings } from "./keepsidian-plugin-settings";

describe("resolveLoadedSettings", () => {
	it("defaults imported image embeds to disabled for existing configs", () => {
		const resolved = resolveLoadedSettings({
			email: "existing@example.com",
		});

		expect(resolved.embedImportedImages).toBe(false);
	});

	it("deep-merges premium feature defaults for older saved configs", () => {
		const resolved = resolveLoadedSettings({
			premiumFeatures: {
				suggestTags: true,
				updateTitle: true,
			},
		} as Partial<KeepSidianPluginSettings>);

		expect(resolved.premiumFeatures.suggestTags).toBe(true);
		expect(resolved.premiumFeatures.updateTitle).toBe(true);
		expect(resolved.premiumFeatures.includeColors).toEqual([]);
		expect(resolved.premiumFeatures.pinnedStatus).toBe("all");
		expect(resolved.premiumFeatures.archivedStatus).toBe("active-only");
	});
});
