// __mocks__/obsidian.ts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yamlPackage = require("js-yaml") as {
	load: (yaml: string) => unknown;
	dump: (obj: unknown) => string;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const momentPackage = require("moment") as typeof import("moment");

type AttributeValue = string | number | boolean;

interface CreateElOptions {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, AttributeValue>;
}

type ToggleClassPrototype = typeof HTMLElement.prototype & {
	toggleClass?: (cls: string, force?: boolean) => HTMLElement;
};

type CreateElFunction = <K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	options?: CreateElOptions,
	callback?: (el: EnhancedElement<K>) => void
) => EnhancedElement<K>;

type EnhancableHTMLElement = HTMLElement & {
	createEl?: CreateElFunction;
	createDiv?: (options?: CreateElOptions, callback?: (el: EnhancedElement<"div">) => void) => EnhancedElement<"div">;
	empty?: () => void;
};

type EnhancedElement<K extends keyof HTMLElementTagNameMap> = HTMLElementTagNameMap[K] &
	EnhancableHTMLElement;

type EnhancedHTMLElementMap = {
	[K in keyof HTMLElementTagNameMap]: EnhancedElement<K>;
};

type StatusBarItemElement = EnhancedElement<"div"> & {
	setText: (text: string) => void;
};

const togglePrototype = HTMLElement.prototype as ToggleClassPrototype;

if (typeof togglePrototype.toggleClass !== "function") {
	togglePrototype.toggleClass = function (
		this: HTMLElement,
		cls: string,
		force?: boolean
	): HTMLElement {
		if (typeof force === "boolean") {
			this.classList.toggle(cls, force);
			return this;
		}
		if (this.classList.contains(cls)) {
			this.classList.remove(cls);
		} else {
			this.classList.add(cls);
		}
		return this;
	};
}

function applyOptions(target: HTMLElement, options?: CreateElOptions): void {
	if (!options) {
		return;
	}

	if (options.cls) {
		const classes = Array.isArray(options.cls) ? options.cls : [options.cls];
		classes
			.filter((cls): cls is string => Boolean(cls))
			.forEach((cls) => target.classList.add(cls));
	}

	if (options.text instanceof DocumentFragment) {
		target.appendChild(options.text);
	} else if (typeof options.text === "string") {
		target.textContent = options.text;
	}

	if (options.attr) {
		Object.entries(options.attr).forEach(([key, value]) => {
			target.setAttribute(key, String(value));
		});
	}
}

function enhanceElement<T extends HTMLElement>(element: T): T & EnhancableHTMLElement {
	const enhanced = element as T & EnhancableHTMLElement;

	if (!enhanced.createEl) {
		enhanced.createEl = function createChild<K extends keyof HTMLElementTagNameMap>(
			this: EnhancableHTMLElement,
			tagName: K,
			options?: CreateElOptions,
			callback?: (el: EnhancedElement<K>) => void
		): EnhancedHTMLElementMap[K] {
			const child = document.createElement(tagName) as HTMLElement;
			applyOptions(child, options);
			this.appendChild(child);
			const enhancedChild = enhanceElement(child) as EnhancedHTMLElementMap[K];
			if (callback) {
				callback(enhancedChild);
			}
			return enhancedChild;
		};
	}

	if (!enhanced.createDiv) {
		enhanced.createDiv = function createDiv(
			this: EnhancableHTMLElement,
			options?: CreateElOptions,
			callback?: (el: EnhancedElement<"div">) => void
		): EnhancedElement<"div"> {
			return (this.createEl as CreateElFunction)("div", options, callback);
		};
	}

	if (!enhanced.empty) {
		enhanced.empty = function empty(this: EnhancableHTMLElement): void {
			this.innerHTML = "";
		};
	}

	return enhanced;
}

export class App {
	workspace?: Record<string, unknown>;
}

type PluginManifest = Record<string, unknown>;

export class Plugin {
	app: App;
	manifest: PluginManifest;

	constructor(app: App, manifest: PluginManifest) {
		this.app = app;
		this.manifest = manifest;
	}

	onload(): void {}
	onunload(): void {}
	addCommand(): void {}
	addRibbonIcon(): void {}
	addSettingTab(): void {}
	loadData(): void {}
	saveData(): void {}
	registerDomEvent(): void {}
	registerInterval(): void {}
	addStatusBarItem(): StatusBarItemElement {
		const element = enhanceElement(document.createElement("div")) as StatusBarItemElement;
		element.setText = (text: string) => {
			element.textContent = text;
		};
		const createChild: CreateElFunction = function createChild<
			K extends keyof HTMLElementTagNameMap
		>(
			this: StatusBarItemElement,
			tagName: K,
			options?: CreateElOptions
		): EnhancedHTMLElementMap[K] {
			const child = document.createElement(tagName);
			applyOptions(child, options);
			this.appendChild(child);
			return enhanceElement(child) as EnhancedHTMLElementMap[K];
		}.bind(element);
		element.createEl = createChild;
		return element;
	}
}

class NoticeInstance {
	message: string | DocumentFragment;
	timeout?: number;

	constructor(message: string | DocumentFragment, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
	}

	setMessage(message: string | DocumentFragment): void {
		this.message = message;
	}

	hide(): void {}
}

export const Notice = jest.fn<NoticeInstance, [string | DocumentFragment, number | undefined]>(
	(message, timeout) => new NoticeInstance(message, timeout)
);

export function arrayBufferToBase64(data: ArrayBuffer): string {
	return Buffer.from(new Uint8Array(data)).toString("base64");
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	containerEl: EnhancedElement<"div">;

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = enhanceElement(document.createElement("div"));
	}
}

export function setIcon(element: HTMLElement, icon: string): void {
	element.setAttribute("data-icon", icon);
}

export class MenuItem {
	title: string | DocumentFragment = "";
	icon: string | null = null;
	disabled = false;
	isLabel = false;
	onClickHandler: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;

	setTitle(title: string | DocumentFragment): this {
		this.title = title;
		return this;
	}

	setIcon(icon: string | null): this {
		this.icon = icon;
		return this;
	}

	setChecked(): this {
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}

	setIsLabel(isLabel: boolean): this {
		this.isLabel = isLabel;
		return this;
	}

	onClick(callback: (evt: MouseEvent | KeyboardEvent) => unknown): this {
		this.onClickHandler = callback;
		return this;
	}

	setSection(): this {
		return this;
	}
}

export class Menu {
	static instances: Menu[] = [];
	items: MenuItem[] = [];
	separators = 0;

	constructor() {
		Menu.instances.push(this);
	}

	addItem(callback: (item: MenuItem) => void): this {
		const item = new MenuItem();
		this.items.push(item);
		callback(item);
		return this;
	}

	addSeparator(): this {
		this.separators += 1;
		return this;
	}

	showAtMouseEvent(): void {}
	showAtPosition(): void {}
}

export let normalizePath = (path: string): string => {
	if (!path) {
		return "";
	}
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
};

export function parseYaml(yaml: string): unknown {
	return yamlPackage.load(yaml);
}

export const moment = momentPackage;

export function stringifyYaml(obj: unknown): string {
	return yamlPackage.dump(obj);
}

export class SubscriptionSettingsTab {
	containerEl: EnhancedElement<"div">;
	plugin: Plugin;

	constructor(containerEl: HTMLElement, plugin: Plugin) {
		this.containerEl = enhanceElement(document.createElement("div"));
		this.plugin = plugin;
		this.containerEl.empty = function empty() {
			this.innerHTML = "";
		};
		containerEl.appendChild(this.containerEl);
	}
}

class MockTextComponent {
	inputEl: HTMLInputElement;

	constructor(inputEl: HTMLInputElement) {
		this.inputEl = inputEl;
	}

	setPlaceholder(value: string): this {
		this.inputEl.placeholder = value;
		return this;
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	onChange(callback: (value: string) => void): this {
		this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
		return this;
	}
}

class MockToggleComponent {
	private inputEl: HTMLInputElement;

	constructor(inputEl: HTMLInputElement) {
		this.inputEl = inputEl;
	}

	setValue(value: boolean): this {
		this.inputEl.checked = value;
		return this;
	}

	onChange(callback: (value: boolean) => void): this {
		this.inputEl.addEventListener("change", () => callback(this.inputEl.checked));
		return this;
	}
}

class MockButtonComponent {
	private buttonEl: HTMLButtonElement;

	constructor(buttonEl: HTMLButtonElement) {
		this.buttonEl = buttonEl;
	}

	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}

	setCta(): this {
		return this;
	}

	onClick(callback: () => void): this {
		this.buttonEl.addEventListener("click", callback);
		return this;
	}
}

class MockExtraButtonComponent {
	private buttonEl: HTMLButtonElement;

	constructor(buttonEl: HTMLButtonElement) {
		this.buttonEl = buttonEl;
	}

	setIcon(): this {
		return this;
	}

	setTooltip(tooltip: string): this {
		this.buttonEl.setAttribute("aria-label", tooltip);
		return this;
	}

	onClick(callback: () => void): this {
		this.buttonEl.addEventListener("click", callback);
		return this;
	}
}

class MockSliderComponent {
	private inputEl: HTMLInputElement;

	constructor(inputEl: HTMLInputElement) {
		this.inputEl = inputEl;
	}

	setLimits(min: number, max: number, step = 1): this {
		this.inputEl.min = String(min);
		this.inputEl.max = String(max);
		this.inputEl.step = String(step);
		return this;
	}

	setValue(value: number): this {
		this.inputEl.value = String(value);
		return this;
	}

	setDynamicTooltip(): this {
		return this;
	}

	onChange(callback: (value: number) => void): this {
		this.inputEl.addEventListener("input", () => callback(Number(this.inputEl.value)));
		return this;
	}
}

class MockDropdownComponent {
	private selectEl: HTMLSelectElement;

	constructor(selectEl: HTMLSelectElement) {
		this.selectEl = selectEl;
	}

	addOption(value: string, label: string): this {
		const optionEl = document.createElement("option");
		optionEl.value = value;
		optionEl.textContent = label;
		this.selectEl.appendChild(optionEl);
		return this;
	}

	addOptions(options: Record<string, string>): this {
		Object.entries(options).forEach(([value, label]) => {
			this.addOption(value, label);
		});
		return this;
	}

	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}

	onChange(callback: (value: string) => void): this {
		this.selectEl.addEventListener("change", () => callback(this.selectEl.value));
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.selectEl.disabled = disabled;
		return this;
	}
}

export class Setting {
	private settingEl: EnhancedElement<"div">;
	private infoEl: EnhancedElement<"div">;
	private nameEl?: EnhancedElement<"div">;
	private descEl?: EnhancedElement<"div">;
	controlEl: EnhancedElement<"div">;

	constructor(containerEl: HTMLElement) {
		const enhancedContainer = enhanceElement(containerEl);
		this.settingEl = enhanceElement(document.createElement("div"));
		this.settingEl.classList.add("setting-item");
		this.infoEl = enhanceElement(document.createElement("div"));
		this.infoEl.classList.add("setting-item-info");
		this.controlEl = enhanceElement(document.createElement("div"));
		this.controlEl.classList.add("setting-item-control");
		this.settingEl.appendChild(this.infoEl);
		this.settingEl.appendChild(this.controlEl);
		enhancedContainer.appendChild(this.settingEl);
	}

	setName(name: string): this {
		if (!this.nameEl) {
			this.nameEl = enhanceElement(document.createElement("div"));
			this.nameEl.classList.add("setting-item-name");
			this.infoEl.appendChild(this.nameEl);
		}
		this.nameEl.textContent = name;
		return this;
	}

	setDesc(description: string | DocumentFragment): this {
		if (!this.descEl) {
			this.descEl = enhanceElement(document.createElement("div"));
			this.descEl.classList.add("setting-item-description");
			this.infoEl.appendChild(this.descEl);
		}
		this.descEl.empty?.();
		if (typeof description === "string") {
			this.descEl.textContent = description;
		} else {
			this.descEl.appendChild(description);
		}
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.classList.add(cls);
		return this;
	}

	setHeading(): this {
		this.settingEl.classList.add("setting-heading");
		return this;
	}

	setDisabled(disabled: boolean): this {
		if (disabled) {
			this.settingEl.classList.add("is-disabled");
		}
		return this;
	}

	addText(callback: (text: MockTextComponent) => void): this {
		const inputEl = document.createElement("input");
		inputEl.type = "text";
		this.controlEl.appendChild(inputEl);
		callback(new MockTextComponent(inputEl));
		return this;
	}

	addToggle(callback: (toggle: MockToggleComponent) => void): this {
		const inputEl = document.createElement("input");
		inputEl.type = "checkbox";
		this.controlEl.appendChild(inputEl);
		callback(new MockToggleComponent(inputEl));
		return this;
	}

	addButton(callback: (button: MockButtonComponent) => void): this {
		const buttonEl = document.createElement("button");
		this.controlEl.appendChild(buttonEl);
		callback(new MockButtonComponent(buttonEl));
		return this;
	}

	addExtraButton(callback: (button: MockExtraButtonComponent) => void): this {
		const buttonEl = document.createElement("button");
		this.controlEl.appendChild(buttonEl);
		callback(new MockExtraButtonComponent(buttonEl));
		return this;
	}

	addSlider(callback: (slider: MockSliderComponent) => void): this {
		const inputEl = document.createElement("input");
		inputEl.type = "range";
		this.controlEl.appendChild(inputEl);
		callback(new MockSliderComponent(inputEl));
		return this;
	}

	addDropdown(callback: (dropdown: MockDropdownComponent) => void): this {
		const selectEl = document.createElement("select");
		this.controlEl.appendChild(selectEl);
		callback(new MockDropdownComponent(selectEl));
		return this;
	}

	onChange(): this {
		return this;
	}

	setValue(): this {
		return this;
	}
}

/** Minimal runtime file identity for vault safety checks in tests. */
export class TFile {
	path = "";
	basename = "";
	extension = "";
	stat = { ctime: 0, mtime: 0, size: 0 };
}

export class Modal {
	app: App;
	titleEl: EnhancedElement<"div">;
	contentEl: EnhancedElement<"div">;
	modalEl: EnhancedElement<"div">;
	containerEl: EnhancedElement<"div">;

	constructor(app: App) {
		this.app = app;
		this.titleEl = enhanceElement(document.createElement("div"));
		this.contentEl = enhanceElement(document.createElement("div"));
		this.modalEl = enhanceElement(document.createElement("div"));
		this.containerEl = enhanceElement(document.createElement("div"));
		this.modalEl.appendChild(this.contentEl);
		this.containerEl.appendChild(this.modalEl);
	}

	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

export class ProgressBarComponent {
	private containerEl: HTMLElement;
	private barEl: HTMLElement;
	value = 0;

	constructor(containerEl: HTMLElement) {
		this.containerEl = containerEl;
		this.barEl = document.createElement("div");
		this.barEl.classList.add("progress-bar");
		this.containerEl.appendChild(this.barEl);
	}

	setValue(value: number): void {
		this.value = value;
	}
}

// Global Obsidian utility function
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).createFragment = function createFragment(
	callback?: (el: DocumentFragment) => void
): DocumentFragment {
	const fragment = document.createDocumentFragment();
	const enhancedFragment = fragment as DocumentFragment & EnhancableHTMLElement;

	// Add createEl, createDiv methods to the fragment
	if (!enhancedFragment.createEl) {
		enhancedFragment.createEl = function <K extends keyof HTMLElementTagNameMap>(
			tagName: K,
			options?: CreateElOptions
		): EnhancedElement<K> {
			const element = document.createElement(tagName);
			applyOptions(element, options);
			fragment.appendChild(element);
			return enhanceElement(element) as EnhancedElement<K>;
		};
	}

	if (!enhancedFragment.createDiv) {
		enhancedFragment.createDiv = function (options?: CreateElOptions): EnhancedElement<"div"> {
			return enhancedFragment.createEl("div", options);
		};
	}

	if (callback) {
		callback(enhancedFragment);
	}

	return enhancedFragment;
};
