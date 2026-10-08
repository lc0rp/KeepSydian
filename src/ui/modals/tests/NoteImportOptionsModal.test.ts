/**
 * @jest-environment jsdom
 */
import KeepSidianPlugin from "main";
import { App } from "obsidian";
import { NoteImportOptionsModal } from "../NoteImportOptionsModal";
import { DEFAULT_SETTINGS } from "../../../types";

type MockCreateElOptions = {
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	cls?: string | string[];
};

type MockElement = HTMLElement & {
	createEl(
		this: MockElement,
		tag: string,
		options?: MockCreateElOptions | string,
		callback?: (el: MockElement) => void
	): MockElement;
	empty: () => void;
};

type CreateElFn = MockElement["createEl"];

interface MockButtonComponent {
	setButtonText: jest.Mock<MockButtonComponent, [string]>;
	setCta: jest.Mock<MockButtonComponent, []>;
	onClick: jest.Mock<MockButtonComponent, [() => void]>;
}

interface MockExtraButtonComponent {
	setIcon: jest.Mock<MockExtraButtonComponent, [string]>;
	setTooltip: jest.Mock<MockExtraButtonComponent, [string]>;
	onClick: jest.Mock<MockExtraButtonComponent, [() => void]>;
}

function createElImpl(
	this: MockElement,
	tag: string,
	options?: MockCreateElOptions | string,
	callback?: (el: MockElement) => void
): MockElement {
	const element = attachCreateEl(document.createElement(tag));
	if (typeof options === "string") {
		element.className = options;
	} else if (options) {
		if (typeof options.text === "string") {
			element.textContent = options.text;
		} else if (options.text instanceof DocumentFragment) {
			element.appendChild(options.text);
		}
		if (options.cls) {
			const classes = Array.isArray(options.cls) ? options.cls : [options.cls];
			for (const cls of classes) {
				if (cls) {
					element.classList.add(String(cls));
				}
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
	if (typeof callback === "function") {
		callback(element);
	}
	return element;
}

const typedCreateEl = createElImpl as unknown as CreateElFn;

const attachCreateEl = <T extends HTMLElement>(element: T): MockElement & T => {
	const mockElement = element as MockElement & T;
	if (mockElement.createEl !== typedCreateEl) {
		mockElement.createEl = typedCreateEl;
	}
	if (typeof mockElement.empty !== "function") {
		mockElement.empty = () => {
			mockElement.innerHTML = "";
		};
	}
	return mockElement;
};

class ButtonComponentMock implements MockButtonComponent {
	private readonly el: HTMLButtonElement;
	setButtonText: jest.Mock<MockButtonComponent, [string]>;
	setCta: jest.Mock<MockButtonComponent, []>;
	onClick: jest.Mock<MockButtonComponent, [() => void]>;

	constructor(el: HTMLButtonElement) {
		this.el = el;
		this.setButtonText = jest.fn<MockButtonComponent, [string]>((text) => {
			this.el.textContent = text;
			return this;
		});
		this.setCta = jest.fn<MockButtonComponent, []>(() => this);
		this.onClick = jest.fn<MockButtonComponent, [() => void]>((fn) => {
			this.el.addEventListener("click", fn);
			return this;
		});
	}
}

class ExtraButtonComponentMock implements MockExtraButtonComponent {
	private readonly el: HTMLButtonElement;
	setIcon: jest.Mock<MockExtraButtonComponent, [string]>;
	setTooltip: jest.Mock<MockExtraButtonComponent, [string]>;
	onClick: jest.Mock<MockExtraButtonComponent, [() => void]>;

	constructor(el: HTMLButtonElement) {
		this.el = el;
		this.setIcon = jest.fn<MockExtraButtonComponent, [string]>((_icon) => this);
		this.setTooltip = jest.fn<MockExtraButtonComponent, [string]>((_tooltip) => this);
		this.onClick = jest.fn<MockExtraButtonComponent, [() => void]>((fn) => {
			this.el.addEventListener("click", fn);
			return this;
		});
	}
}

// Mock SubscriptionSettingsTab static method used by the modal

jest.mock("../../settings/SubscriptionSettingsTab", () => ({
	SubscriptionSettingsTab: {
		displayPremiumFeatures: jest.fn((contentEl: HTMLElement, plugin: KeepSidianPlugin, isActive: boolean) => {
			// Simulate that UI mutates some premium values prior to submit
			plugin.settings = { ...DEFAULT_SETTINGS };
			plugin.settings.premiumFeatures = {
				...(plugin.settings.premiumFeatures ?? {}),
				includeNotesTerms: ["foo"],
			};
			contentEl.createEl("div", {
				text: `Mocked displayPremiumFeatures - isActive: ${isActive}`,
			});
		}),
	},
}));

// DOM-driven Setting mock we can click
jest.mock("obsidian", () => {
	const actual = jest.requireActual("obsidian");

	class Setting {
		settingEl: MockElement;
		constructor(containerEl: HTMLElement) {
			this.settingEl = attachCreateEl(document.createElement("div"));
			containerEl.appendChild(this.settingEl);
		}
		setName(name: string) {
			this.settingEl.createEl("div", { text: name });
			return this;
		}
		setDesc(desc: string) {
			this.settingEl.createEl("div", { text: String(desc) });
			return this;
		}
		addButton(cb: (btn: MockButtonComponent) => void) {
			const btnEl = document.createElement("button");
			this.settingEl.appendChild(btnEl);
			const btn = new ButtonComponentMock(btnEl);
			cb(btn);
			return this;
		}
		addToggle(cb: (toggle: { setValue(value: boolean): unknown; onChange(handler: (value: boolean) => void): unknown }) => void) {
			const input = document.createElement("input");
			input.type = "checkbox";
			this.settingEl.appendChild(input);
			const toggle = {
				setValue: (value: boolean) => { input.checked = value; return toggle; },
				onChange: (handler: (value: boolean) => void) => { input.addEventListener("change", () => handler(input.checked)); return toggle; },
			};
			cb(toggle);
			return this;
		}
		addExtraButton(cb: (extra: MockExtraButtonComponent) => void) {
			const btnEl = document.createElement("button");
			this.settingEl.appendChild(btnEl);
			const extra = new ExtraButtonComponentMock(btnEl);
			cb(extra);
			return this;
		}
	}

	class Modal {
		app: App;
		contentEl: MockElement;
		modalEl: HTMLElement;
		titleEl: HTMLElement;

		constructor(app: App) {
			this.app = app;
			this.modalEl = document.createElement("div");
			this.titleEl = document.createElement("div");
			this.contentEl = attachCreateEl(document.createElement("div"));
			this.modalEl.appendChild(this.contentEl);
		}

		open() {}
		close() {}
		onOpen() {}
		onClose() {}
	}

	class PluginSettingTab {
		app: App;
		plugin: unknown;
		containerEl: MockElement;

		constructor(app: App, plugin: unknown) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = attachCreateEl(document.createElement("div"));
		}

		display() {}
	}

	class MockApp extends actual.App {}

	return { ...actual, Setting, Modal, PluginSettingTab, App: MockApp };
});

describe("NoteImportOptionsModal", () => {
	let app: App;
	let plugin: KeepSidianPlugin;
	const TEST_MANIFEST = {
		id: "keepsidian",
		name: "KeepSidian",
		author: "lc0rp",
		version: "0.0.1",
		minAppVersion: "0.0.1",
		description: "Import Google Keep notes.",
	};

	beforeEach(() => {
		jest.clearAllMocks();
		app = new App();
		plugin = new KeepSidianPlugin(app, TEST_MANIFEST);
		plugin.settings = { ...DEFAULT_SETTINGS };
	});

	test("renders, calls displayPremiumFeatures, and submits options", async () => {
		const onSubmit = jest.fn();
		const modal = new NoteImportOptionsModal(app, plugin, onSubmit);
		// Spy on close to ensure it is called
		const closeSpy = jest.spyOn(modal, "close").mockImplementation(() => {});

		await modal.onOpen();

		expect(modal.contentEl.textContent).toContain("Download options");
		const { SubscriptionSettingsTab } = await import("../../settings/SubscriptionSettingsTab");
		expect(SubscriptionSettingsTab.displayPremiumFeatures).toHaveBeenCalled();

		// Click the Import button
		const importBtn = Array.from(modal.contentEl.querySelectorAll("button")).find(
			(b) => b.textContent === "Import"
		) as HTMLButtonElement;
		expect(importBtn).toBeTruthy();
		importBtn.click();

		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ includeNotesTerms: ["foo"] }));
		expect(closeSpy).toHaveBeenCalled();
	});

	test("cancel button closes modal", async () => {
		const modal = new NoteImportOptionsModal(app, plugin, jest.fn());
		const closeSpy = jest.spyOn(modal, "close").mockImplementation(() => {});
		await modal.onOpen();

		const cancelBtn = Array.from(modal.contentEl.querySelectorAll("button")).find(
			(b) => b.textContent === "Cancel"
		) as HTMLButtonElement;
		expect(cancelBtn).toBeTruthy();
		cancelBtn.click();
		expect(closeSpy).toHaveBeenCalled();
	});

	test("legacy generation requires a fresh toggle and is never saved as a premium setting", async () => {
		const onSubmit = jest.fn();
		const modal = new NoteImportOptionsModal(app, plugin, onSubmit);
		await modal.onOpen();
		const input = modal.contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		expect(input.checked).toBe(false);
		input.checked = true;
		input.dispatchEvent(new Event("change"));
		Array.from(modal.contentEl.querySelectorAll("button")).find((button) => button.textContent === "Import")!.click();
		expect(onSubmit.mock.calls[0][0].legacyTagConsent).toBeDefined();
		expect(plugin.settings.premiumFeatures).not.toHaveProperty("legacyTagConsent");
		const next = new NoteImportOptionsModal(app, plugin, onSubmit);
		await next.onOpen();
		expect(next.contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
	});

	test("onClose empties content", () => {
		const modal = new NoteImportOptionsModal(app, plugin, jest.fn());
		modal.contentEl.createEl("div", { text: "to be removed" });
		modal.onClose();
		expect(modal.contentEl.innerHTML).toBe("");
	});
});
