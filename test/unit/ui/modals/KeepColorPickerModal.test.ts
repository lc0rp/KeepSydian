/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { KeepColorPickerModal } from "../../../../src/ui/modals/KeepColorPickerModal";
import { KEEP_COLOR_OPTIONS } from "../../../../src/types/subscription";

describe("KeepColorPickerModal", () => {
	let app: App;

	beforeEach(() => {
		app = new App();
	});

	it("renders circular swatches with tooltip labels", () => {
		const modal = new KeepColorPickerModal(app, {
			selectedColors: [],
			onSave: jest.fn(),
		});

		modal.onOpen();

		const swatches = modal.contentEl.querySelectorAll(".keepsidian-color-picker-swatch");

		expect(swatches).toHaveLength(KEEP_COLOR_OPTIONS.length);
		expect(swatches[0]?.getAttribute("title")).toBe("White");
		expect(swatches[0]?.getAttribute("aria-label")).toBe("White");
	});

	it("disables Done when all colors are cleared", () => {
		const modal = new KeepColorPickerModal(app, {
			selectedColors: ["YELLOW", "BLUE"],
			onSave: jest.fn(),
		});

		modal.onOpen();

		const clearAllButton = Array.from(modal.contentEl.querySelectorAll("button")).find(
			(button) => button.textContent === "Clear all"
		) as HTMLButtonElement;
		const doneButton = Array.from(modal.contentEl.querySelectorAll("button")).find(
			(button) => button.textContent === "Done"
		) as HTMLButtonElement;

		clearAllButton.click();

		expect(doneButton.disabled).toBe(true);
		expect(modal.contentEl.textContent).toContain("Select at least one color");
	});

	it("saves a filtered selection when a subset is chosen", () => {
		const onSave = jest.fn();
		const modal = new KeepColorPickerModal(app, {
			selectedColors: ["YELLOW", "BLUE"],
			onSave,
		});
		const closeSpy = jest.spyOn(modal, "close");

		modal.onOpen();

		const clearAllButton = Array.from(modal.contentEl.querySelectorAll("button")).find(
			(button) => button.textContent === "Clear all"
		) as HTMLButtonElement;
		const yellowSwatch = modal.contentEl.querySelector(
			'[data-keep-color-value="YELLOW"]'
		) as HTMLButtonElement;
		const doneButton = Array.from(modal.contentEl.querySelectorAll("button")).find(
			(button) => button.textContent === "Done"
		) as HTMLButtonElement;

		clearAllButton.click();
		yellowSwatch.click();
		doneButton.click();

		expect(onSave).toHaveBeenCalledWith(["YELLOW"]);
		expect(closeSpy).toHaveBeenCalled();
	});

	it("stores all selected colors as an empty filter", () => {
		const onSave = jest.fn();
		const modal = new KeepColorPickerModal(app, {
			selectedColors: ["YELLOW"],
			onSave,
		});

		modal.onOpen();

		const selectAllButton = Array.from(modal.contentEl.querySelectorAll("button")).find(
			(button) => button.textContent === "Select all"
		) as HTMLButtonElement;
		const doneButton = Array.from(modal.contentEl.querySelectorAll("button")).find(
			(button) => button.textContent === "Done"
		) as HTMLButtonElement;

		selectAllButton.click();
		doneButton.click();

		expect(onSave).toHaveBeenCalledWith([]);
	});
});
