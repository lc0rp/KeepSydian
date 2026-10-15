import { t } from "../../../lang/ui";
import type KeepSidianPlugin from "main";
import { Setting } from "obsidian";
import type { ToggleComponent } from "obsidian";

export async function addAutoSyncSettings(plugin: KeepSidianPlugin, containerEl: HTMLElement): Promise<void> {
	const setSettingDisabledState = (setting: Setting, disabled: boolean): void => {
		setting.setDisabled(disabled);
		const actionableElements = setting.controlEl.querySelectorAll("input, button, select, textarea");
		for (const element of actionableElements) {
			(
				element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
			).disabled = disabled;
		}
	};

	new Setting(containerEl).setName(t("settings.background.heading")).setHeading();

	let updateTwoWaySettingsState: () => void = () => {};

	new Setting(containerEl)
		.setName(t("settings.background.name"))
		.setDesc(t("settings.background.description"))
		.addToggle((toggle) =>
			toggle.setValue(plugin.settings.autoSyncEnabled).onChange(async (value) => {
				plugin.settings.autoSyncEnabled = value;
				plugin.refreshAutoSyncSafeguards();
				await plugin.saveSettings();
				updateTwoWaySettingsState?.();
				if (value) {
					plugin.startAutoSync();
				} else {
					plugin.stopAutoSync();
				}
			})
		);

	const isSubscribed = await plugin.subscriptionService.isSubscriptionActive();

	const intervalSetting = new Setting(containerEl)
		.setName(t("settings.interval.name"))
		.setDesc(t("settings.interval.description") + (isSubscribed ? "" : " (" + t("supporter.available") + ")"))
		.addText((text) =>
			text
				.setPlaceholder("24")
				.setValue(plugin.settings.autoSyncIntervalHours.toString())
				.onChange(async (value) => {
					const num = Number(value);
					if (!isNaN(num) && num > 0) {
						plugin.settings.autoSyncIntervalHours = num;
						await plugin.saveSettings();
						if (plugin.settings.autoSyncEnabled) {
							plugin.startAutoSync();
						}
					}
				})
		);

	if (!isSubscribed) {
		setSettingDisabledState(intervalSetting, true);
		intervalSetting.setClass("requires-subscription");
	}

	new Setting(containerEl).setName(t("settings.twoWay.heading")).setHeading();

	let suppressTwoWayUpdates = false;
	let backupToggle: ToggleComponent | undefined;
	let manualTwoWayToggle: ToggleComponent | undefined;
	let autoTwoWayToggle: ToggleComponent | undefined;
	let manualTwoWaySetting!: Setting;
	let autoTwoWaySetting!: Setting;

	const formatRequirementList = (items: string[]): string => {
		if (items.length === 1) {
			return items[0];
		}
		return items.join(" · ");
	};

	updateTwoWaySettingsState = () => {
		suppressTwoWayUpdates = true;
		const { settings } = plugin;
		const backupAcknowledged = settings.twoWaySyncBackupAcknowledged;
		const manualTwoWayEnabled = settings.twoWaySyncEnabled;
		const autoTwoWayEnabled = settings.twoWaySyncAutoSyncEnabled;
		const autoSyncActive = settings.autoSyncEnabled;

		backupToggle?.setValue(backupAcknowledged);
		manualTwoWayToggle?.setValue(manualTwoWayEnabled);
		autoTwoWayToggle?.setValue(autoTwoWayEnabled);

		const manualBaseDesc = t("settings.enableCommands");
		const manualRequirements: string[] = [];
		if (!isSubscribed) {
			manualRequirements.push(t("supporter.available"));
		}
		if (!backupAcknowledged) {
			manualRequirements.push(t("settings.optInFirst"));
		}
		const manualDesc = manualRequirements.length
			? `${manualBaseDesc} (${formatRequirementList(manualRequirements)})`
			: manualBaseDesc;
		manualTwoWaySetting.setDesc(manualDesc);
		setSettingDisabledState(manualTwoWaySetting, manualRequirements.length > 0);

		const requirements: string[] = [];
		if (!isSubscribed) {
			requirements.push(t("supporter.available"));
		}
		if (!backupAcknowledged) {
			requirements.push(t("settings.requiresOptIn"));
		}
		if (backupAcknowledged && !manualTwoWayEnabled) {
			requirements.push(t("settings.requiresTwoWay"));
		}

		if (backupAcknowledged && manualTwoWayEnabled && isSubscribed && !autoSyncActive) {
			requirements.push(t("settings.requiresBackground"));
		}

		const autoDesc = requirements.length
			? `${t("settings.backgroundBoth")} (${formatRequirementList(requirements)})`
			: t("settings.backgroundBoth");
		autoTwoWaySetting.setDesc(autoDesc);
		setSettingDisabledState(autoTwoWaySetting, requirements.length > 0);
		suppressTwoWayUpdates = false;
	};

	const backupGuideUrl = "https://help." + "obsidian.md/backup";

	const backupGuideSetting = new Setting(containerEl)
		.setName(t("settings.backup.name"))
		.setDesc(
			t("settings.backup.description")
		);

	const backupGuideLink = backupGuideSetting.controlEl.createEl("a", {
		text: t("settings.backupGuide"),
		attr: {
			href: backupGuideUrl,
			target: "_blank",
			rel: "noopener noreferrer",
			"data-keepsidian-link": "obsidian-backup-guide",
		},
	});
	backupGuideLink.classList.add("keepsidian-link-button");
	backupGuideLink.setAttribute("role", "button");

	new Setting(containerEl)
		.setName(t("settings.optIn.name"))
		.setDesc(t("settings.optIn.description"))
		.addToggle((toggle) => {
			backupToggle = toggle;
			toggle.setValue(plugin.settings.twoWaySyncBackupAcknowledged).onChange(async (value) => {
				if (suppressTwoWayUpdates) {
					return;
				}
				plugin.settings.twoWaySyncBackupAcknowledged = value;
				if (!value) {
					plugin.settings.twoWaySyncEnabled = false;
					plugin.settings.twoWaySyncAutoSyncEnabled = false;
				}
				plugin.refreshAutoSyncSafeguards();
				await plugin.saveSettings();
				updateTwoWaySettingsState();
			});
		});

	manualTwoWaySetting = new Setting(containerEl).setName(t("settings.twoWay.name")).addToggle((toggle) => {
		manualTwoWayToggle = toggle;
		toggle.setValue(plugin.settings.twoWaySyncEnabled).onChange(async (value) => {
			if (suppressTwoWayUpdates) {
				return;
			}
			if (!plugin.settings.twoWaySyncBackupAcknowledged) {
				updateTwoWaySettingsState();
				return;
			}
			plugin.settings.twoWaySyncEnabled = value;
			if (!value) {
				plugin.settings.twoWaySyncAutoSyncEnabled = false;
			}
			plugin.refreshAutoSyncSafeguards();
			await plugin.saveSettings();
			updateTwoWaySettingsState();
		});
	});

	autoTwoWaySetting = new Setting(containerEl).setName(t("settings.twoWay.background")).addToggle((toggle) => {
		autoTwoWayToggle = toggle;
		toggle.setValue(plugin.settings.twoWaySyncAutoSyncEnabled).onChange(async (value) => {
			if (suppressTwoWayUpdates) {
				return;
			}
			const prerequisitesMet =
				plugin.settings.twoWaySyncBackupAcknowledged &&
				plugin.settings.twoWaySyncEnabled &&
				isSubscribed &&
				plugin.settings.autoSyncEnabled;
			if (!prerequisitesMet) {
				updateTwoWaySettingsState();
				return;
			}
			plugin.settings.twoWaySyncAutoSyncEnabled = value;
			plugin.refreshAutoSyncSafeguards();
			await plugin.saveSettings();
			updateTwoWaySettingsState();
		});
	});

	if (!isSubscribed) {
		manualTwoWaySetting.setClass("requires-subscription");
		autoTwoWaySetting.setClass("requires-subscription");
	}

	updateTwoWaySettingsState();
}
