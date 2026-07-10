/**
 * @jest-environment jsdom
 */
import { App, PluginSettingTab, Notice, Platform } from "obsidian";
import { KeepSidianSettingsTab } from "../KeepSidianSettingsTab";
import KeepSidianPlugin from "../../../main";
import { SubscriptionService } from "services/subscription";
import { DEFAULT_SETTINGS } from "../../../types/keepsidian-plugin-settings";
import { exchangeOauthToken } from "../../../integrations/google/keepToken";
import { getTokenHelperState, runTokenHelper } from "../../../integrations/google/tokenHelper";
import { TokenHelperInstallModal } from "../../modals/TokenHelperInstallModal";

type CreateElOptions = {
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	cls?: string | string[];
};

type HTMLElementWithCreateEl = HTMLElement & {
	createEl(
		this: HTMLElementWithCreateEl,
		tag: string,
		options?: CreateElOptions | string,
		callback?: (el: HTMLElementWithCreateEl) => void
	): HTMLElementWithCreateEl;
	createDiv(
		this: HTMLElementWithCreateEl,
		options?: CreateElOptions | string,
		callback?: (el: HTMLElementWithCreateEl) => void
	): HTMLElementWithCreateEl;
};

type CreateElFn = HTMLElementWithCreateEl["createEl"];

type KeepSidianSettingsTabInternals = {
	addEmailSetting(containerEl: HTMLElement): void;
	addSyncTokenSetting(containerEl: HTMLElement): void;
	addSaveLocationSetting(containerEl: HTMLElement): void;
	addSubscriptionSettings(containerEl: HTMLElement): Promise<void>;
	addSupportSection(containerEl: HTMLElement): void;
	isValidEmail(email: string): boolean;
	handleTokenPaste(event: ClipboardEvent): Promise<void>;
	handleTokenHelperLaunch(): Promise<void>;
	renderSettings(): Promise<void>;
};

jest.mock("../../modals/NoteImportOptionsModal", () => ({
	NoteImportOptionsModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

jest.mock("../../../integrations/google/keepToken", () => ({
	exchangeOauthToken: jest.fn(),
}));

jest.mock("../../../integrations/google/tokenHelper", () => ({
	getTokenHelperState: jest.fn(),
	runTokenHelper: jest.fn(),
}));

jest.mock("../../modals/TokenHelperInstallModal", () => ({
	TokenHelperInstallModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

function attachCreateEl(element: HTMLElement, createEl: CreateElFn): HTMLElementWithCreateEl {
	const elementWithCreate = element as HTMLElementWithCreateEl;
	elementWithCreate.createEl = createEl;
	const createDivImpl = function createDiv(
		this: HTMLElementWithCreateEl,
		options?: CreateElOptions | string,
		callback?: (el: HTMLElementWithCreateEl) => void
	) {
		return createEl.call(this, "div", options, callback);
	};
	elementWithCreate.createDiv = createDivImpl as unknown as typeof elementWithCreate.createDiv;
	return elementWithCreate;
}

const createElImpl = function createEl(
	this: HTMLElementWithCreateEl,
	tag: string,
	opts?: CreateElOptions | string,
	callback?: (el: HTMLElementWithCreateEl) => void
): HTMLElementWithCreateEl {
	const element = attachCreateEl(document.createElement(tag), createElImpl as unknown as CreateElFn);
	if (typeof opts === "string") {
		element.className = opts;
	} else if (opts && typeof opts === "object") {
		const options = opts;
		if (typeof options.text === "string") {
			element.textContent = options.text;
		} else if (options.text instanceof DocumentFragment) {
			element.appendChild(options.text);
		}
		if (options.cls) {
			const classes = Array.isArray(options.cls) ? options.cls : String(options.cls).split(/\s+/).filter(Boolean);
			for (const cls of classes) {
				element.classList.add(String(cls));
			}
		}
		if (options.attr) {
			for (const [key, value] of Object.entries(options.attr)) {
				if (value === null) {
					element.removeAttribute(key);
				} else {
					element.setAttribute(key, String(value));
				}
			}
		}
	}
	this.appendChild(element);
	if (callback) {
		callback(element);
	}
	return element;
} as unknown as CreateElFn;

// Mock obsidian
jest.mock("obsidian", () => ({
	...jest.requireActual("obsidian"),
	requestUrl: jest.fn(),
	Notice: jest.fn(),
	setIcon: jest.fn(),
	Platform: { isDesktopApp: true, isMobileApp: false },
}));

const mockSubscriptionService = () => {
	return {
		getEmail: jest.fn().mockReturnValue("test@example.com"),
		isSubscriptionActive: jest.fn().mockResolvedValue(true),
		getCache: jest.fn().mockReturnValue(undefined),
		setCache: jest.fn(),
		fetchSubscriptionInfo: jest.fn(),
		checkSubscription: jest.fn().mockResolvedValue({
			plan_details: { plan_id: "test_plan" },
			metering_info: { usage: 10, limit: 100 },
		}),
	} as unknown as SubscriptionService;
};

describe("KeepSidianSettingsTab", () => {
	let app: App;
	let plugin: KeepSidianPlugin;
	let settingsTab: KeepSidianSettingsTab;
	let settingsTabInternals: KeepSidianSettingsTabInternals;
	const helperManifest = {
		version: "0.1.0",
		protocolVersion: 1,
		assets: [],
	};

	const TEST_MANIFEST = {
		id: "keepsidian",
		name: "KeepSidian",
		author: "lc0rp",
		version: "0.0.1",
		minAppVersion: "0.0.1",
		description: "Import Google Keep notes.",
	};

	beforeEach(() => {
		jest.resetModules();
		jest.clearAllMocks();
		(Notice as jest.Mock).mockImplementation(() => ({
			setMessage: jest.fn(),
			hide: jest.fn(),
		}));
		Platform.isDesktopApp = true;
		Platform.isMobileApp = false;
		app = new App();
		plugin = new KeepSidianPlugin(app, TEST_MANIFEST);
		plugin.settings = {
			...DEFAULT_SETTINGS,
			email: "",
			token: "",
			saveLocation: "",
			subscriptionCache: undefined,
			premiumFeatures: {
				autoSync: false,
				syncIntervalMinutes: 5,
				includeNotesTerms: [],
				excludeNotesTerms: [],
				includeColors: [],
				pinnedStatus: "all",
				archivedStatus: "active-only",
				updateTitle: false,
				suggestTags: false,
				maxTags: 5,
				tagPrefix: "",
				limitToExistingTags: false,
			},
		};
		plugin.subscriptionService = mockSubscriptionService();
		settingsTab = new KeepSidianSettingsTab(app, plugin);
		settingsTabInternals = settingsTab as unknown as KeepSidianSettingsTabInternals;
		attachCreateEl(settingsTab.containerEl, createElImpl);

		// Reset the exchangeOauthToken mock
		(exchangeOauthToken as jest.Mock).mockReset();
		(getTokenHelperState as jest.Mock).mockReset();
		(runTokenHelper as jest.Mock).mockReset();
		(TokenHelperInstallModal as jest.Mock).mockClear();
		(getTokenHelperState as jest.Mock).mockResolvedValue({
			status: "ready",
			helperPath: "/tmp/keepsidian-token-helper",
			installedVersion: "0.1.0",
		});
		(runTokenHelper as jest.Mock).mockImplementation(async (_plugin, onEvent) => {
			await onEvent({ type: "token", oauthToken: "oauth_token_value" });
		});
	});

	test("two-way sync defaults stay disabled for safety", () => {
		expect(DEFAULT_SETTINGS.twoWaySyncBackupAcknowledged).toBe(false);
		expect(DEFAULT_SETTINGS.twoWaySyncEnabled).toBe(false);
		expect(DEFAULT_SETTINGS.twoWaySyncAutoSyncEnabled).toBe(false);
	});

	test("should instantiate correctly", () => {
		expect(settingsTab).toBeInstanceOf(PluginSettingTab);
	});

	test("should display settings correctly", async () => {
		const spyAddEmailSetting = jest.spyOn(settingsTabInternals, "addEmailSetting");
		const spyAddSyncTokenSetting = jest.spyOn(settingsTabInternals, "addSyncTokenSetting");
		const spyAddSaveLocationSetting = jest.spyOn(settingsTabInternals, "addSaveLocationSetting");
		const spyAddSubscriptionSettings = jest.spyOn(settingsTabInternals, "addSubscriptionSettings");
		const spyAddSupportSection = jest.spyOn(settingsTabInternals, "addSupportSection");

		await settingsTabInternals.renderSettings();

		expect(spyAddEmailSetting).toHaveBeenCalled();
		expect(spyAddSyncTokenSetting).toHaveBeenCalled();
		expect(spyAddSaveLocationSetting).toHaveBeenCalled();
		expect(spyAddSubscriptionSettings).toHaveBeenCalled();
		expect(spyAddSupportSection).toHaveBeenCalledTimes(2);
	});

	test("should hide helper retrieval on mobile", async () => {
		Platform.isDesktopApp = false;
		Platform.isMobileApp = true;

		await settingsTabInternals.renderSettings();

		expect(settingsTab.containerEl.textContent).toContain("Mobile: use a desktop-synced token");
		expect(settingsTab.containerEl.textContent).not.toContain("Retrieve token with helper");
	});

	test("should validate email properly", () => {
		expect(settingsTabInternals.isValidEmail("test@example.com")).toBe(true);
		expect(settingsTabInternals.isValidEmail("invalid-email")).toBe(false);
	});

	test("should handle oauth2_4 token paste specially", async () => {
		const event = {
			preventDefault: jest.fn(),
			clipboardData: {
				getData: jest.fn().mockReturnValue("oauth2_4/token_value"),
			},
		} as unknown as ClipboardEvent;

		(exchangeOauthToken as jest.Mock).mockResolvedValue(undefined);

		await settingsTabInternals.handleTokenPaste(event);

		expect(event.preventDefault).toHaveBeenCalled();
		expect(exchangeOauthToken).toHaveBeenCalledWith(settingsTab, plugin, "oauth2_4/token_value");
	});

	test("should let non-oauth2_4 pastes through normally", async () => {
		const event = {
			preventDefault: jest.fn(),
			clipboardData: {
				getData: jest.fn().mockReturnValue("any_other_text"),
			},
		} as unknown as ClipboardEvent;

		await settingsTabInternals.handleTokenPaste(event);

		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(exchangeOauthToken).not.toHaveBeenCalled();
	});

	test("should launch installed token helper and exchange returned token", async () => {
		plugin.settings.email = "test@example.com";
		const noticeMock = jest.fn();
		(Notice as jest.Mock).mockImplementation((...args) => {
			noticeMock(...args);
			return {
				setMessage: jest.fn(),
				hide: jest.fn(),
			};
		});

		await settingsTabInternals.handleTokenHelperLaunch();

		expect(getTokenHelperState).toHaveBeenCalledWith(plugin);
		expect(runTokenHelper).toHaveBeenCalledWith(plugin, expect.any(Function));
		expect(exchangeOauthToken).toHaveBeenCalledWith(settingsTab, plugin, "oauth_token_value");
		expect(noticeMock).not.toHaveBeenCalledWith("Please enter a valid email address before retrieving the token.");
	});

	test("should open install modal when helper is missing", async () => {
		plugin.settings.email = "test@example.com";
		(getTokenHelperState as jest.Mock).mockResolvedValue({
			status: "missing",
			latest: helperManifest,
		});

		await settingsTabInternals.handleTokenHelperLaunch();

		expect(TokenHelperInstallModal).toHaveBeenCalledWith(
			app,
			expect.objectContaining({
				plugin,
				manifest: helperManifest,
				mode: "install",
			})
		);
		expect(runTokenHelper).not.toHaveBeenCalled();
	});

	test("should open update modal when helper is outdated", async () => {
		plugin.settings.email = "test@example.com";
		(getTokenHelperState as jest.Mock).mockResolvedValue({
			status: "outdated",
			helperPath: "/tmp/helper",
			installedVersion: "0.0.1",
			latest: helperManifest,
		});

		await settingsTabInternals.handleTokenHelperLaunch();

		expect(TokenHelperInstallModal).toHaveBeenCalledWith(
			app,
			expect.objectContaining({
				plugin,
				manifest: helperManifest,
				mode: "update",
			})
		);
	});

	test("should block helper on mobile", async () => {
		Platform.isDesktopApp = false;
		Platform.isMobileApp = true;
		plugin.settings.email = "test@example.com";

		const noticeMock = jest.fn();
		(Notice as jest.Mock).mockImplementation((...args) => {
			noticeMock(...args);
			return {
				setMessage: jest.fn(),
				hide: jest.fn(),
			};
		});

		await settingsTabInternals.handleTokenHelperLaunch();

		expect(runTokenHelper).not.toHaveBeenCalled();
		expect(noticeMock).toHaveBeenCalledWith(
			"Token retrieval helper is only available on desktop. Paste a token instead."
		);
	});

	test("should show notice when helper is triggered without valid email", async () => {
		plugin.settings.email = "";

		const noticeMock = jest.fn();
		(Notice as jest.Mock).mockImplementation((...args) => {
			noticeMock(...args);
			return {
				setMessage: jest.fn(),
				hide: jest.fn(),
			};
		});

		await settingsTabInternals.handleTokenHelperLaunch();

		expect(noticeMock).toHaveBeenCalledWith("Please enter a valid email address before retrieving the token.");
	});
});
