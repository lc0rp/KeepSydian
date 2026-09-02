import "@testing-library/jest-dom";

class MockButtonComponent {
	constructor(private readonly buttonEl: HTMLButtonElement) {}

	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}

	onClick(handler: () => void): this {
		this.buttonEl.addEventListener("click", handler);
		return this;
	}
}

// Mock the Setting class from Obsidian
class MockSetting {
	containerEl: HTMLElement;
	controlEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		this.containerEl = containerEl;
		this.controlEl = containerEl.createDiv();
	}

	setName(_name: string) {
		return this;
	}
	setDesc(_desc: string) {
		return this;
	}

	addText(cb: (text: Record<string, unknown>) => void) {
		cb({});
		return this;
	}

	addButton(cb: (button: MockButtonComponent) => void) {
		const buttonEl = document.createElement("button");
		this.controlEl.appendChild(buttonEl);
		cb(new MockButtonComponent(buttonEl));
		return this;
	}

	addExtraButton(cb: (button: Record<string, unknown>) => void) {
		cb({});
		return this;
	}
}

// Define our mock WebviewTag element
class MockWebviewElement extends HTMLElement {
	src = "";
	setAttribute(name: string, value: string): void {}
	hide(): void {
		this.classList.add("hidden");
	}

	// Override addEventListener to return 'this' for method chaining
	addEventListener<K extends keyof HTMLElementEventMap>(
		type: K,
		listener: (this: HTMLElement, ev: HTMLElementEventMap[K]) => void,
		options?: boolean | AddEventListenerOptions
	): this;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	): this {
		super.addEventListener(type, listener, options);
		return this;
	}
}

// Register the custom elements used during tests
if (!customElements.get("mock-webview")) {
	customElements.define("mock-webview", MockWebviewElement);
}

type HideAugmentedPrototype = typeof HTMLElement.prototype & {
	hide?: () => void;
};

const htmlElementPrototype = HTMLElement.prototype as HideAugmentedPrototype;

if (typeof htmlElementPrototype.hide !== "function") {
	htmlElementPrototype.hide = function (this: HTMLElement) {
		this.classList.add("hidden");
	};
}

// Type declaration to extend HTMLElementTagNameMap
declare global {
	interface HTMLElementTagNameMap {
		webview: MockWebviewElement;
		"mock-webview": MockWebviewElement;
	}
}

jest.mock("obsidian", () => {
	const actual = jest.requireActual<typeof import("../../__mocks__/obsidian.ts")>(
		"../../__mocks__/obsidian.ts"
	);

	const mockModule: Record<string, unknown> = {
		__esModule: true,
		...actual,
		Setting: MockSetting,
	};

	Object.defineProperty(mockModule, "normalizePath", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: actual.normalizePath,
	});

	return mockModule;
});

// Mock electron WebviewTag
jest.mock("electron", () => ({
	WebviewTag: MockWebviewElement,
}));
