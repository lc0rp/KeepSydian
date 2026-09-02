jest.mock("obsidian");

import { Notice } from "obsidian";
import KeepSidianPlugin from "../../main";
import { finishSyncUI, initializeStatusBar, startSyncUI } from "../../app/sync-ui";
import { HIDDEN_CLASS } from "../../app/ui-constants";
import { DEFAULT_SETTINGS } from "../../types/keepsidian-plugin-settings";

const TEST_MANIFEST = {
	id: "keepsidian",
	name: "KeepSidian",
	author: "lc0rp",
	version: "0.0.1",
	minAppVersion: "0.0.1",
	description: "Import Google Keep notes.",
};

type StatusBarStub = HTMLElement & {
	setAttribute: jest.Mock;
	addEventListener: jest.Mock;
	createEl: jest.Mock;
};

function createStatusBarStub(): StatusBarStub {
	const element = document.createElement("div");
	const stub = element as unknown as StatusBarStub;
	stub.setAttribute = jest.fn();
	stub.addEventListener = jest.fn();
	stub.createEl = jest.fn(<K extends keyof HTMLElementTagNameMap>(tag: K) => {
		const child = document.createElement(tag);
		stub.appendChild(child);
		return child;
	});
	return stub;
}

describe("status bar gating", () => {
	let plugin: KeepSidianPlugin;
	let statusBarItem: StatusBarStub;

	beforeEach(() => {
		statusBarItem = createStatusBarStub();
		const app = { workspace: {}, vault: {} } as unknown as KeepSidianPlugin["app"];
		plugin = new KeepSidianPlugin(app, TEST_MANIFEST);
		plugin.settings = { ...DEFAULT_SETTINGS };
		plugin.addStatusBarItem = jest.fn().mockReturnValue(statusBarItem);
		initializeStatusBar(plugin);
	});

	it("opens the sync center when the status bar is clicked", () => {
		const openSyncCenterSpy = jest.spyOn(plugin, "openSyncCenter").mockImplementation(() => {});
		const handler = (statusBarItem.addEventListener as jest.Mock).mock.calls.find(
			([eventName]) => eventName === "click"
		)?.[1] as (evt: MouseEvent) => void;

		expect(handler).toBeDefined();
		handler(new MouseEvent("click"));

		expect(openSyncCenterSpy).toHaveBeenCalledTimes(1);
		openSyncCenterSpy.mockRestore();
	});

	it("cancels stale finish timers when a new sync starts", () => {
		jest.useFakeTimers();
		const notices: Array<{ hide: jest.Mock; setMessage: jest.Mock }> = [];
		const NoticeMock = Notice as unknown as jest.Mock;
		NoticeMock.mockImplementation((message: string, timeout?: number) => {
			const notice = {
				message,
				timeout,
				hide: jest.fn(),
				setMessage: jest.fn(),
			};
			notices.push(notice);
			return notice;
		});

		startSyncUI(plugin);
		finishSyncUI(plugin, true);

		expect(notices).toHaveLength(1);
		expect(plugin.progressContainerEl?.classList.contains(HIDDEN_CLASS)).toBe(false);

		startSyncUI(plugin);

		expect(notices).toHaveLength(2);
		expect(notices[0]?.hide).toHaveBeenCalledTimes(1);
		expect(plugin.progressContainerEl?.classList.contains(HIDDEN_CLASS)).toBe(false);

		jest.advanceTimersByTime(10_000);

		expect(notices[1]?.hide).not.toHaveBeenCalled();
		expect(plugin.progressContainerEl?.classList.contains(HIDDEN_CLASS)).toBe(false);
		jest.useRealTimers();
	});

	it("still hides the finished sync UI after the configured delay when no new sync starts", () => {
		jest.useFakeTimers();
		const hide = jest.fn();
		const NoticeMock = Notice as unknown as jest.Mock;
		NoticeMock.mockImplementation((message: string, timeout?: number) => ({
			message,
			timeout,
			hide,
			setMessage: jest.fn(),
		}));

		startSyncUI(plugin);
		finishSyncUI(plugin, true);

		expect(plugin.progressContainerEl?.classList.contains(HIDDEN_CLASS)).toBe(false);

		jest.advanceTimersByTime(2999);
		expect(plugin.progressContainerEl?.classList.contains(HIDDEN_CLASS)).toBe(false);
		expect(hide).not.toHaveBeenCalled();

		jest.advanceTimersByTime(1);
		expect(plugin.progressContainerEl?.classList.contains(HIDDEN_CLASS)).toBe(true);

		jest.advanceTimersByTime(1000);
		expect(hide).toHaveBeenCalledTimes(1);
		jest.useRealTimers();
	});

	it("records canceled syncs distinctly from failed syncs", () => {
		finishSyncUI(plugin, "canceled");

		expect(plugin.lastSyncSummary).toEqual(
			expect.objectContaining({
				success: false,
				status: "canceled",
			})
		);
		expect(plugin.statusTextEl?.textContent).toBe("Last sync canceled");
	});

	it("records a completed sync with attachment warnings as successful but distinct", () => {
		const setMessage = jest.fn();
		const NoticeMock = Notice as unknown as jest.Mock;
		NoticeMock.mockImplementation(() => ({
			hide: jest.fn(),
			setMessage,
		}));
		startSyncUI(plugin);

		finishSyncUI(plugin, "warning", 2);

		expect(plugin.lastSyncSummary).toEqual(
			expect.objectContaining({
				success: true,
				status: "warning",
				attachmentWarnings: 2,
			})
		);
		expect(plugin.statusTextEl?.textContent).toBe("Last sync completed with warnings");
		expect(setMessage).toHaveBeenCalledWith("Synced Google Keep Notes with 2 attachment warnings.");
		expect(plugin.progressContainerEl?.classList.contains("complete")).toBe(true);
	});
});
