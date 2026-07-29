import { Setting } from "obsidian";
import KeepSidianPlugin from "main";
import { KEEPSIDIAN_SERVER_URL } from "../../config";
import { formatKeepColorSummary } from "../../types/subscription";
import { KeepColorPickerModal } from "../modals/KeepColorPickerModal";

export class SubscriptionSettingsTab {
	private containerEl: HTMLElement;
	private sectionEl: HTMLDivElement;
	private plugin: KeepSidianPlugin;

	constructor(containerEl: HTMLElement, plugin: KeepSidianPlugin) {
		this.containerEl = containerEl;
		this.sectionEl = containerEl.ownerDocument.createElement("div");
		this.sectionEl.classList.add("keepsidian-subscription-settings");
		this.containerEl.appendChild(this.sectionEl);
		this.plugin = plugin;
	}

	async display(forceRefresh = false): Promise<void> {
		const { sectionEl: containerEl } = this;
		containerEl.replaceChildren();

		new Setting(containerEl).setName("Exclusive features for project supporters").setHeading();

		const isActive = await this.plugin.subscriptionService.isSubscriptionActive(forceRefresh);

		if (!isActive) {
			await this.displayInactiveSubscriber();
		} else {
			await this.displayActiveSubscriber();
		}

		SubscriptionSettingsTab.displayPremiumFeatures(containerEl, this.plugin, isActive);
	}

	static displayPremiumFeatures(containerEl: HTMLElement, plugin: KeepSidianPlugin, isActive: boolean): void {
		const descSuffix = isActive ? "" : " (Available to project supporters)";
		const premiumFeatureValues = plugin.settings.premiumFeatures;
		const persistPremiumFeatureChange = async (applyChange: () => void): Promise<void> => {
			applyChange();
			await plugin.saveSettings();
		};
		const setSettingDisabledState = (setting: Setting, disabled: boolean): void => {
			setting.setDisabled(disabled);
			const actionableElements = setting.controlEl.querySelectorAll("input, button, select, textarea");
			for (const element of actionableElements) {
				(
					element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
				).disabled = disabled;
			}
		};
		const applySupporterLock = <T extends Setting>(setting: T): T => {
			if (!isActive) {
				setting.setClass("requires-subscription");
				setSettingDisabledState(setting, true);
			}
			return setting;
		};
		let maxTagsSetting: Setting | null = null;
		let tagPrefixSetting: Setting | null = null;
		let limitSetting: Setting | null = null;
		const refreshTagSettingsState = () => {
			const tagSuggestionsEnabled = premiumFeatureValues.suggestTags;
			const shouldDisableDependentTagSettings = !isActive || !tagSuggestionsEnabled;
			if (maxTagsSetting) {
				setSettingDisabledState(maxTagsSetting, shouldDisableDependentTagSettings);
			}
			if (tagPrefixSetting) {
				setSettingDisabledState(tagPrefixSetting, shouldDisableDependentTagSettings);
			}
			if (limitSetting) {
				setSettingDisabledState(limitSetting, shouldDisableDependentTagSettings);
			}
		};
		// 3.2 Filter Notes
		applySupporterLock(
			new Setting(containerEl)
				.setName("Only include notes containing")
				.setDesc("Terms to include (comma-separated)." + descSuffix)
				.addText((text) =>
					text
						.setPlaceholder("Term 1, term 2, ...")
						.setValue(premiumFeatureValues.includeNotesTerms.join(", "))
						.onChange(async (value) => {
							await persistPremiumFeatureChange(() => {
								premiumFeatureValues.includeNotesTerms = value
									.split(",")
									.map((k) => k.trim())
									.filter((k) => k);
							});
						})
				)
		);

		applySupporterLock(
			new Setting(containerEl)
				.setName("Exclude notes containing")
				.setDesc("Terms to skip (comma-separated)." + descSuffix)
				.addText((text) =>
					text
						.setPlaceholder("Term 1, term 2, ...")
						.setValue(premiumFeatureValues.excludeNotesTerms.join(", "))
						.onChange(async (value) => {
							await persistPremiumFeatureChange(() => {
								premiumFeatureValues.excludeNotesTerms = value
									.split(",")
									.map((k) => k.trim())
									.filter((k) => k);
							});
						})
				)
		);

		const colorFilterSetting = applySupporterLock(
			new Setting(containerEl)
				.setName("Note colors filter")
				.setDesc("Select one or more note colors to download." + descSuffix)
		);
		const colorSummaryEl = colorFilterSetting.controlEl.createEl("span", {
			text: formatKeepColorSummary(premiumFeatureValues.includeColors),
			cls: "keepsidian-color-filter-summary",
		});
		const openColorModalButton = colorFilterSetting.controlEl.createEl("button", {
			text: "Choose colors",
			cls: "keepsidian-color-filter-button",
			attr: { type: "button" },
		});
		const resetColorFilterButton = colorFilterSetting.controlEl.createEl("button", {
			text: "Reset",
			cls: "keepsidian-color-filter-button",
			attr: { type: "button" },
		});
		const refreshColorFilterSummary = () => {
			colorSummaryEl.textContent = formatKeepColorSummary(premiumFeatureValues.includeColors);
		};
		openColorModalButton.addEventListener("click", () => {
			new KeepColorPickerModal(plugin.app, {
				selectedColors: premiumFeatureValues.includeColors,
				onSave: (selectedColors) => {
					void persistPremiumFeatureChange(() => {
						premiumFeatureValues.includeColors = selectedColors;
						refreshColorFilterSummary();
					});
				},
			}).open();
		});
		resetColorFilterButton.addEventListener("click", () => {
			void persistPremiumFeatureChange(() => {
				premiumFeatureValues.includeColors = [];
				refreshColorFilterSummary();
			});
		});
		if (!isActive) {
			setSettingDisabledState(colorFilterSetting, true);
		}

		applySupporterLock(
			new Setting(containerEl)
				.setName("Pinned note filter")
				.setDesc("Download all notes, only pinned notes, or only unpinned notes." + descSuffix)
				.addDropdown((dropdown) => {
					dropdown
						.addOption("all", "All notes")
						.addOption("pinned", "Pinned only")
						.addOption("unpinned", "Unpinned only");
					dropdown.setValue(premiumFeatureValues.pinnedStatus);
					dropdown.onChange(async (value) => {
						await persistPremiumFeatureChange(() => {
							premiumFeatureValues.pinnedStatus = value as typeof premiumFeatureValues.pinnedStatus;
						});
					});
				})
		);

		applySupporterLock(
			new Setting(containerEl)
				.setName("Archived note filter")
				.setDesc("Default is active notes only. Archived-only and all-notes are supporter filters." + descSuffix)
				.addDropdown((dropdown) => {
					dropdown
						.addOption("active-only", "Active notes only")
						.addOption("archived-only", "Archived notes only")
						.addOption("all", "All notes");
					dropdown.setValue(premiumFeatureValues.archivedStatus);
					dropdown.onChange(async (value) => {
						await persistPremiumFeatureChange(() => {
							premiumFeatureValues.archivedStatus = value as typeof premiumFeatureValues.archivedStatus;
						});
					});
				})
		);

		// 3.3 Title Updates
		applySupporterLock(
			new Setting(containerEl)
				.setName("Smart titles")
				.setDesc("Suggest titles based on note content. Original title will be saved in note." + descSuffix)
				.addToggle((toggle) =>
					toggle.setValue(premiumFeatureValues.updateTitle).onChange(async (value) => {
						await persistPremiumFeatureChange(() => {
							premiumFeatureValues.updateTitle = value;
						});
					})
				)
		);

		// 3.4 Tag Suggestions
		applySupporterLock(
			new Setting(containerEl)
				.setName("Auto-tags")
				.setDesc("Generate tags based on note content." + descSuffix)
				.addToggle((toggle) =>
					toggle.setValue(premiumFeatureValues.suggestTags).onChange(async (value) => {
						await persistPremiumFeatureChange(() => {
							premiumFeatureValues.suggestTags = value;
							refreshTagSettingsState();
						});
					})
				)
		);

		maxTagsSetting = applySupporterLock(
			new Setting(containerEl)
				.setName("Maximum tags")
				.setDesc("Maximum number of tags to generate." + descSuffix)
				.addSlider((slider) =>
					slider
						.setLimits(1, 10, 1)
						.setValue(premiumFeatureValues.maxTags)
						.onChange(async (value) => {
							await persistPremiumFeatureChange(() => {
								premiumFeatureValues.maxTags = value;
							});
						})
				)
				.setDisabled(!isActive || !premiumFeatureValues.suggestTags)
		);

		tagPrefixSetting = applySupporterLock(
			new Setting(containerEl)
				.setName("Tag prefix")
				.setDesc("Prefix to identify generated tags (leave empty for none)." + descSuffix)
				.addText((text) =>
					text
						.setValue(premiumFeatureValues.tagPrefix)
						.setPlaceholder("Auto-")
						.onChange(async (value) => {
							await persistPremiumFeatureChange(() => {
								premiumFeatureValues.tagPrefix = value;
							});
						})
				)
				.setDisabled(!isActive || !premiumFeatureValues.suggestTags)
		);

		limitSetting = applySupporterLock(
			new Setting(containerEl)
				.setName("Limit to existing tags")
				.setDesc("Only generate tags that already exist in your vault." + descSuffix)
				.addToggle((toggle) =>
					toggle.setValue(premiumFeatureValues.limitToExistingTags).onChange(async (value) => {
						await persistPremiumFeatureChange(() => {
							premiumFeatureValues.limitToExistingTags = value;
						});
					})
				)
				.setDisabled(!isActive || !premiumFeatureValues.suggestTags)
		);

		refreshTagSettingsState();
	}

	private static buildManageSubscriptionUrl(email: string): string {
		const portalUrl = `${KEEPSIDIAN_SERVER_URL}/subscriber/portal`;
		if (!email) {
			return portalUrl;
		}

		return `${portalUrl}?${new URLSearchParams({ prefilled_email: email }).toString()}`;
	}

	private async displayInactiveSubscriber(): Promise<void> {
		const { sectionEl: containerEl } = this;

		containerEl.createEl("em", { text: "Support development and unlock advanced features" });

		const benefitsList = containerEl.createEl("ul", {
			attr: { style: "font-size: 0.9em" },
		});
		[
			"Smart titles: Auto-suggestions from note content.",
			"Auto-tags: Instant tag generation & management.",
			"Advanced filters: Sync only what you need.",
			"Priority support: Your questions answered first.",
			"Two-way background sync: Keep notes updated everywhere, quietly.",
			"Early access: First to get new features.",
			"And more!",
		].forEach((benefit) => {
			const li = benefitsList.createEl("li");
			const [title, description] = benefit.split(":");
			if (description) {
				li.createSpan({
					text: title,
					attr: { style: "font-weight: bold" },
				});
				li.createSpan({ text: ":" + description });
			} else {
				li.createSpan({ text: benefit });
			}
		});

		const subscribeSetting = new Setting(containerEl)
			.setName("Support KeepSidian monthly or annually")
			.setDesc(
				"Support the development of KeepSidian and get access to the features below, priority support and early access to new features."
			);

		const subscribeUrl = `${KEEPSIDIAN_SERVER_URL}/subscribe`;
		const subscribeLink = subscribeSetting.controlEl.createEl("a", {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- Keep the public project name intact.
			text: "🌎 Support this project",
			attr: {
				href: subscribeUrl,
				target: "_blank",
				rel: "noopener noreferrer",
				"data-keepsidian-link": "subscribe",
			},
		});
		subscribeLink.classList.add("keepsidian-link-button");
		subscribeLink.setAttribute("role", "button");

		new Setting(containerEl)
			.setName("Already supporting?")
			.setDesc("Recheck your status and unlock supporter settings if billing is active.")
			.addButton((button) =>
				button.setButtonText("I am a supporter").onClick(async () => {
					await this.display(true);
				})
			);
	}

	private async displayActiveSubscriber(): Promise<void> {
		const { sectionEl: containerEl } = this;
		const subscriptionInfo = await this.plugin.subscriptionService.checkSubscription();
		const planId = subscriptionInfo?.plan_details?.plan_id;
		const supporterSetting = new Setting(containerEl)
			.setName(planId ? `✅ Active supporter (Plan: ${planId})` : "✅ Active supporter")
			.setDesc("Thank you for your support! Access supporter-exclusive settings below.")
			// .setClass("subscription-active")
			.addExtraButton((button) =>
				button
					.setIcon("refresh-cw")
					.setTooltip("Check supporter status")
					.onClick(async () => {
						await this.display(true);
					})
			);

		const manageLink = supporterSetting.controlEl.createEl("a", {
			text: "Open billing portal",
			attr: {
				href: SubscriptionSettingsTab.buildManageSubscriptionUrl(this.plugin.settings.email),
				target: "_blank",
				rel: "noopener noreferrer",
				"data-keepsidian-link": "manage-subscription",
			},
		});
		manageLink.classList.add("keepsidian-link-button");
		manageLink.setAttribute("role", "button");

		if (subscriptionInfo?.metering_info) {
			new Setting(containerEl)
				.setName("Usage")
				.setDesc(`${subscriptionInfo.metering_info.usage} / ${subscriptionInfo.metering_info.limit} notes synced`);
		}
	}
}
