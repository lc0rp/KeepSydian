jest.mock("obsidian");

import type { Plugin } from "obsidian";
import KeepSydianPlugin from "../main";
import { FeedbackSurveyModal } from "../ui/modals/FeedbackSurveyModal";

const TEST_MANIFEST = {
	id: "keepsidian",
	name: "KeepSydian",
	author: "lc0rp",
	version: "2.0.20",
	minAppVersion: "1.6.5",
	description: "Sync Google Keep notes to Obsidian.",
};

function createPlugin(savedData: Record<string, unknown> | null = {}) {
	const app = {
		workspace: {},
		vault: {},
	} as unknown as Plugin["app"];
	const plugin = new KeepSydianPlugin(app, TEST_MANIFEST);
	plugin.loadData = jest.fn().mockResolvedValue(savedData);
	plugin.saveData = jest.fn().mockResolvedValue(undefined);
	return plugin;
}

describe("post-install feedback prompt", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("shows after install and records the current version", async () => {
		const openSpy = jest.spyOn(FeedbackSurveyModal.prototype, "open");
		const plugin = createPlugin(null);

		await plugin.onload();

		expect(openSpy).toHaveBeenCalledTimes(1);
		expect(plugin.saveData).toHaveBeenCalledWith(
			expect.objectContaining({ feedbackPromptLastShownVersion: TEST_MANIFEST.version })
		);
		openSpy.mockRestore();
	});

	it("shows after an upgrade from an older version", async () => {
		const openSpy = jest.spyOn(FeedbackSurveyModal.prototype, "open");
		const plugin = createPlugin({ feedbackPromptLastShownVersion: "2.0.19" });

		await plugin.onload();

		expect(openSpy).toHaveBeenCalledTimes(1);
		expect(plugin.saveData).toHaveBeenCalledWith(
			expect.objectContaining({ feedbackPromptLastShownVersion: TEST_MANIFEST.version })
		);
		openSpy.mockRestore();
	});

	it("does not show again after it has been shown for this version", async () => {
		const openSpy = jest.spyOn(FeedbackSurveyModal.prototype, "open");
		const plugin = createPlugin({ feedbackPromptLastShownVersion: TEST_MANIFEST.version });

		await plugin.onload();

		expect(openSpy).not.toHaveBeenCalled();
		expect(plugin.saveData).not.toHaveBeenCalled();
		openSpy.mockRestore();
	});
});
