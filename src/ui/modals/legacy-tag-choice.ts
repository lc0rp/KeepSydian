import { t } from "../../lang/ui";
import { Setting } from "obsidian";

export function renderLegacyTagChoice(
	container: HTMLElement,
	value: boolean,
	onChange: (value: boolean) => void
): void {
	new Setting(container)
		.setName(t("legacy.title"))
		.setDesc(
			t("legacy.description")
		)
		.addToggle((toggle) => toggle.setValue(value).onChange(onChange));
}
