import { Setting } from "obsidian";

export function renderLegacyTagChoice(
	container: HTMLElement,
	value: boolean,
	onChange: (value: boolean) => void
): void {
	new Setting(container)
		.setName("Generate tags for previously imported notes")
		.setDesc(
			"Allow new AI tag requests for selected notes. These notes then reuse results until relevant content changes. Existing titles and manual tags are kept. This choice starts off for each download."
		)
		.addToggle((toggle) => toggle.setValue(value).onChange(onChange));
}
