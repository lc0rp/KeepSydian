import { t } from "../../lang/ui";
import { Notice, Setting } from "obsidian";
import KeepSidianPlugin from "main";
import { KEEPSIDIAN_SERVER_URL } from "../../config";
import { formatKeepColorSummary } from "../../lang/display";
import { KeepColorPickerModal } from "../modals/KeepColorPickerModal";
import {
	clearSupporterKeyFromSecretStorage,
	isSecretStorageAvailable,
	storeSupporterKeyInSecretStorage,
} from "@app/main-secret-storage";
import { createSupporterKeyIdentity, formatSupporterKeyInput, normalizeSupporterKey } from "@services/supporter-key";
import { NetworkError } from "@services/errors";
import type { SubscriptionInfo } from "@types";

export class SubscriptionSettingsTab {
	private containerEl: HTMLElement;
	private sectionEl: HTMLDivElement;
	private plugin: KeepSidianPlugin;
	private onSupporterIdentityChanged?: () => Promise<void>;

	constructor(containerEl: HTMLElement, plugin: KeepSidianPlugin, onSupporterIdentityChanged?: () => Promise<void>) {
		this.containerEl = containerEl;
		this.sectionEl = containerEl.createDiv({ cls: "keepsidian-subscription-settings" });
		this.plugin = plugin;
		this.onSupporterIdentityChanged = onSupporterIdentityChanged;
	}

	async display(forceRefresh = false): Promise<void> {
		const { sectionEl: containerEl } = this;
		containerEl.replaceChildren();

		new Setting(containerEl).setName(t("supporter.heading")).setHeading();

		const isActive = await this.plugin.subscriptionService.isSubscriptionActive(forceRefresh);

		if (!isActive) {
			await this.displayInactiveSubscriber();
		} else {
			await this.displayActiveSubscriber();
		}

		SubscriptionSettingsTab.displayPremiumFeatures(containerEl, this.plugin, isActive);
	}

	static displayPremiumFeatures(containerEl: HTMLElement, plugin: KeepSidianPlugin, isActive: boolean): void {
		const descSuffix = isActive ? "" : " (" + t("supporter.available") + ")";
		const premiumFeatureValues = plugin.settings.premiumFeatures;
		const persistPremiumFeatureChange = async (applyChange: () => void): Promise<void> => {
			applyChange();
			await plugin.saveSettings();
		};
		const setSettingDisabledState = (setting: Setting, disabled: boolean): void => {
			setting.setDisabled(disabled);
			const actionableElements = setting.controlEl.querySelectorAll("input, button, select, textarea");
			for (const element of actionableElements) {
				(element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement).disabled = disabled;
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
				.setName(t("supporter.include.name"))
				.setDesc(t("supporter.include.description") + descSuffix)
				.addText((text) =>
					text
						.setPlaceholder(t("supporter.terms.placeholder"))
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
				.setName(t("supporter.exclude.name"))
				.setDesc(t("supporter.exclude.description") + descSuffix)
				.addText((text) =>
					text
						.setPlaceholder(t("supporter.terms.placeholder"))
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
				.setName(t("supporter.colors.name"))
				.setDesc(t("supporter.colors.description") + descSuffix)
		);
		const colorSummaryEl = colorFilterSetting.controlEl.createEl("span", {
			text: formatKeepColorSummary(premiumFeatureValues.includeColors),
			cls: "keepsidian-color-filter-summary",
		});
		const openColorModalButton = colorFilterSetting.controlEl.createEl("button", {
			text: t("colors.choose"),
			cls: "keepsidian-color-filter-button",
			attr: { type: "button" },
		});
		const resetColorFilterButton = colorFilterSetting.controlEl.createEl("button", {
			text: t("common.reset"),
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
				.setName(t("supporter.pinned.name"))
				.setDesc(t("supporter.pinned.description") + descSuffix)
				.addDropdown((dropdown) => {
					dropdown
						.addOption("all", t("filter.all"))
						.addOption("pinned", t("filter.pinned"))
						.addOption("unpinned", t("filter.unpinned"));
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
				.setName(t("supporter.archived.name"))
				.setDesc(t("supporter.archived.description") + descSuffix)
				.addDropdown((dropdown) => {
					dropdown
						.addOption("active-only", t("filter.active"))
						.addOption("archived-only", t("filter.archived"))
						.addOption("all", t("filter.all"));
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
				.setName(t("supporter.smartTitles.name"))
				.setDesc(t("supporter.smartTitles.description") + descSuffix)
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
				.setName(t("supporter.autoTags.name"))
				.setDesc(t("supporter.autoTags.description") + descSuffix)
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
				.setName(t("settings.maxTags"))
				.setDesc(t("settings.maxTagsDescription") + descSuffix)
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
				.setName(t("settings.tagPrefix"))
				.setDesc(t("settings.tagPrefixDescription") + descSuffix)
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
				.setName(t("settings.existingTags"))
				.setDesc(t("settings.existingTagsDescription") + descSuffix)
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

		containerEl.createEl("em", { text: t("supporter.pitch") });

		const benefitsList = containerEl.createEl("ul", {
			attr: { style: "font-size: 0.9em" },
		});
		[
			t("supporter.benefitTitles"),
			t("supporter.benefitTags"),
			t("supporter.benefitFilters"),
			t("supporter.benefitSupport"),
			t("supporter.benefitSync"),
			t("supporter.benefitAccess"),
			t("supporter.more"),
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
			.setName(t("supporter.subscribe"))
			.setDesc(
				t("supporter.subscribeDescription")
			);

		const subscribeUrl = `${KEEPSIDIAN_SERVER_URL}/subscribe`;
		const subscribeLink = subscribeSetting.controlEl.createEl("a", {
			text: t("supporter.support"),
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
			.setName(t("supporter.already"))
			.setDesc(t("supporter.recheckDescription"))
			.addButton((button) =>
				button.setButtonText(t("supporter.iSupport")).onClick(async () => {
					await this.display(true);
				})
			);

		this.displaySupporterKeySetting(containerEl);
	}

	private async displayActiveSubscriber(): Promise<void> {
		const { sectionEl: containerEl } = this;
		const subscriptionInfo = await this.plugin.subscriptionService.checkSubscription();
		const planId = subscriptionInfo?.plan_details?.plan_id;
		const supporterSetting = new Setting(containerEl)
			.setName(planId ? t("supporter.activePlan",{planId}) : t("supporter.active"))
			.setDesc(t("supporter.thanks"))
			// .setClass("subscription-active")
			.addExtraButton((button) =>
				button
					.setIcon("refresh-cw")
					.setTooltip(t("supporter.check"))
					.onClick(async () => {
						await this.display(true);
					})
			);

		const manageLink = supporterSetting.controlEl.createEl("a", {
			text: t("supporter.billing"),
			attr: {
				href: SubscriptionSettingsTab.buildManageSubscriptionUrl(
					this.plugin.settings.supporterKeyConfigured ? "" : this.plugin.settings.email
				),
				target: "_blank",
				rel: "noopener noreferrer",
				"data-keepsidian-link": "manage-subscription",
			},
		});
		manageLink.classList.add("keepsidian-link-button");
		manageLink.setAttribute("role", "button");

		if (subscriptionInfo?.metering_info) {
			new Setting(containerEl)
				.setName(t("supporter.usageLabel"))
				.setDesc(t("supporter.usage",{usage:subscriptionInfo.metering_info.usage,limit:subscriptionInfo.metering_info.limit}));
		}

		if (this.plugin.settings.supporterKeyConfigured) {
			this.displaySupporterKeySetting(containerEl);
		}
	}

	private displaySupporterKeySetting(containerEl: HTMLElement): void {
		const hasConfiguredKey = this.plugin.settings.supporterKeyConfigured;
		const keyIsReadable = Boolean(this.plugin.settings.supporterKey);
		const keySetting = new Setting(containerEl)
			.setName(t("supporter.useKey"))
			.setDesc(
				hasConfiguredKey
					? keyIsReadable
						? t("supporter.keySaved")
						: t("supporter.keyUnreadable")
					: t("supporter.keyExplanation")
			);

		const editorSetting = new Setting(containerEl)
			.setName(hasConfiguredKey ? t("supporter.replaceKeyLabel") : t("supporter.key.name"))
			.setDesc(t("supporter.key.description"));
		editorSetting.settingEl.hidden = true;
		editorSetting.settingEl.classList.add("keepsidian-supporter-key-editor");
		editorSetting.settingEl.dataset.keepsidianSupporterKeyEditor = "true";

		let keyDraft = "";
		editorSetting.addText((text) => {
			text
				.setPlaceholder(t("supporter.key.name"))
				.setValue("")
				.onChange((value) => {
					keyDraft = formatSupporterKeyInput(value);
					if (text.inputEl.value !== keyDraft) {
						text.inputEl.value = keyDraft;
					}
				});
			text.inputEl.type = "password";
			text.inputEl.autocomplete = "off";
			text.inputEl.spellcheck = false;
			text.inputEl.dataset.keepsidianSupporterKeyInput = "true";
			text.inputEl.classList.add("keepsidian-supporter-key-input");
		});

		editorSetting.addButton((button) =>
			button
				.setButtonText(t("supporter.applyKey"))
				.setCta()
				.onClick(async () => {
					await this.applySupporterKey(keyDraft);
				})
		);

		keySetting.addButton((button) =>
			button.setButtonText(hasConfiguredKey ? t("supporter.replaceKey") : t("supporter.useKeyButton")).onClick(() => {
				if (!isSecretStorageAvailable(this.plugin)) {
					new Notice(t("supporter.updateObsidian"));
					return;
				}
				editorSetting.settingEl.hidden = false;
				editorSetting.controlEl.querySelector<HTMLInputElement>("input")?.focus();
			})
		);

		if (hasConfiguredKey) {
			keySetting.addButton((button) =>
				button.setButtonText(t("supporter.removeKey")).onClick(async () => {
					await this.removeSupporterKey();
				})
			);
		}
	}

	private async applySupporterKey(value: string): Promise<void> {
		if (!isSecretStorageAvailable(this.plugin)) {
			new Notice(t("supporter.updateObsidian"));
			return;
		}

		const supporterKey = normalizeSupporterKey(value);
		if (!supporterKey) {
			new Notice(t("supporter.keyLength"));
			return;
		}

		let subscriptionInfo: SubscriptionInfo;
		try {
			subscriptionInfo = await this.plugin.subscriptionService.validateSupporterKey(supporterKey);
		} catch (error) {
			new Notice(this.getSupporterKeyErrorMessage(error));
			return;
		}
		if (subscriptionInfo.subscription_status !== "active") {
			new Notice(t("supporter.keyInactive"));
			return;
		}

		const storageResult = storeSupporterKeyInSecretStorage(this.plugin, supporterKey);
		if (!storageResult.success) {
			new Notice(t("supporter.saveFailed"));
			return;
		}

		this.plugin.settings.supporterKey = supporterKey;
		this.plugin.settings.supporterKeyConfigured = true;
		this.plugin.settings.supporterKeyIdentity = createSupporterKeyIdentity(supporterKey);
		this.plugin.invalidateSubscriptionIdentity();
		await this.plugin.saveSettings();
		await this.plugin.subscriptionService.primeCurrentCache(subscriptionInfo);
		new Notice(t("supporter.saved"));
		await this.refreshAfterSupporterIdentityChange();
	}

	private async removeSupporterKey(): Promise<void> {
		const storageResult = clearSupporterKeyFromSecretStorage(this.plugin);
		if (!storageResult.success) {
			new Notice(t("supporter.removeFailed"));
			return;
		}

		this.plugin.settings.supporterKey = undefined;
		this.plugin.settings.supporterKeyConfigured = false;
		this.plugin.settings.supporterKeyIdentity = undefined;
		this.plugin.invalidateSubscriptionIdentity();
		await this.plugin.saveSettings();
		new Notice(t("supporter.removed"));
		await this.refreshAfterSupporterIdentityChange(true);
	}

	private async refreshAfterSupporterIdentityChange(forceRefresh = false): Promise<void> {
		if (this.onSupporterIdentityChanged) {
			await this.onSupporterIdentityChanged();
			return;
		}
		await this.display(forceRefresh);
	}

	private getSupporterKeyErrorMessage(error: unknown): string {
		const status = error instanceof NetworkError ? error.status : undefined;
		if (status === 403) {
			return t("supporter.invalidKey");
		}
		if (status === 429) {
			return t("supporter.keyRateLimit");
		}
		if (status === 503) {
			return t("supporter.keyUnavailable");
		}
		return t("supporter.keyCheckFailed");
	}
}
