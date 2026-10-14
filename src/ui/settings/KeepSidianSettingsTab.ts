import { t } from "../../lang/ui";
import { normalizeLanguagePreference, refreshUiLanguage } from "../../lang/ui";
import KeepSidianPlugin from "main";
import { PluginSettingTab, App, Notice, Platform, Setting } from "obsidian";
import { exchangeOauthToken } from "../../integrations/google/keepToken";
import { getTokenHelperState, isTokenHelperInstalled, runTokenHelper } from "@integrations/google/tokenHelper";
import {
	endRetrievalWizardSession,
	logRetrievalWizardEvent,
	startRetrievalWizardSession,
} from "@integrations/google/retrievalSessionLogger";
import { TokenHelperInstallModal } from "@ui/modals/TokenHelperInstallModal";
import { addAutoSyncSettings as addAutoSyncSettingsSection } from "./KeepSidianSettingsTab/autoSyncSettings";
import {
	addEmailSetting as addEmailSettingSection,
	addGithubInstructionsLink as addGithubInstructionsLinkSection,
	addSaveLocationSetting as addSaveLocationSettingSection,
	addSubscriptionSettings as addSubscriptionSettingsSection,
	addSupportSection as addSupportSectionSection,
} from "./KeepSidianSettingsTab/commonSettings";
import {
	addAdvancedSettings as addAdvancedSettingsSection,
	addSyncTokenSetting as addSyncTokenSettingSection,
} from "./KeepSidianSettingsTab/tokenSettings";

export class KeepSidianSettingsTab extends PluginSettingTab {
	private plugin: KeepSidianPlugin;

	constructor(app: App, plugin: KeepSidianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private isValidEmail(email: string): boolean {
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		return emailRegex.test(email);
	}

	private isLikelyLongLivedToken(token?: string | null): boolean {
		const trimmed = token?.trim();
		if (!trimmed) {
			return false;
		}

		const normalized = trimmed.toLowerCase();
		if (normalized.includes("oauth2_")) {
			return false;
		}

		return trimmed.length >= 20;
	}

	display(): void {
		void this.renderSettings();
	}

	private async renderSettings(): Promise<void> {
		this.containerEl.empty();
		// Each async render owns a child. A superseded render can only finish in its detached child.
		const containerEl = this.containerEl.createDiv();
		containerEl.classList.add("keepsidian-localized-settings");
		new Setting(containerEl).setName(t("language.heading")).setHeading();
		new Setting(containerEl)
			.setName(t("language.name"))
			.setDesc(t("language.description"))
			.addDropdown((dropdown) => {
				dropdown.selectEl.setAttribute("data-keepsidian-role", "language");
				dropdown.addOptions({ system: t("language.system"), en: "English", zh: "简体中文 (草稿)", ru: "Русский (черновик)", de: "Deutsch (Entwurf)" })
					.setValue(this.plugin.settings.language ?? "system")
					.onChange(async (value) => {
						this.plugin.settings.language = normalizeLanguagePreference(value);
						await this.plugin.saveSettings();
						refreshUiLanguage();
						this.display();
					});
			});
		new Setting(containerEl)
			.setName(t("language.drafts"))
			.setDesc(t("language.draftDescription"))
			.setClass("keepsidian-draft-translations")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.useDraftTranslations === true).onChange(async (value) => {
					this.plugin.settings.useDraftTranslations = value;
					await this.plugin.saveSettings();
					refreshUiLanguage();
					this.display();
				});
			});

		this.addSupportSection(containerEl);
		new Setting(containerEl).setName(t("settings.retrieve")).setHeading();
		this.addEmailSetting(containerEl);
		this.addSyncTokenSetting(containerEl);
		containerEl.createEl("hr", { cls: "keepsidian-settings-hr" });
		new Setting(containerEl).setName(t("common.notes")).setHeading();
		this.addSaveLocationSetting(containerEl);
		containerEl.createEl("hr", { cls: "keepsidian-settings-hr" });
		await this.addAutoSyncSettings(containerEl);
		containerEl.createEl("hr", { cls: "keepsidian-settings-hr" });
		await this.addSubscriptionSettings(containerEl);
		containerEl.createEl("hr", { cls: "keepsidian-settings-hr" });
		this.addSupportSection(containerEl);
	}

	private addSupportSection(containerEl: HTMLElement): void {
		addSupportSectionSection(this.plugin, containerEl);
	}

	private async addSubscriptionSettings(containerEl: HTMLElement): Promise<void> {
		await addSubscriptionSettingsSection(this.plugin, containerEl, async () => {
			const scrollTop = this.containerEl.scrollTop;
			await this.renderSettings();
			this.containerEl.scrollTop = scrollTop;
		});
	}

	private addEmailSetting(containerEl: HTMLElement): void {
		addEmailSettingSection(this.plugin, containerEl);
	}

	private addSyncTokenSetting(containerEl: HTMLElement): void {
		addSyncTokenSettingSection(containerEl, {
			plugin: this.plugin,
			helperInstalled: isTokenHelperInstalled(this.plugin),
			isLikelyLongLivedToken: (token) => this.isLikelyLongLivedToken(token),
			onTokenPaste: async (event) => {
				await this.handleTokenPaste(event);
			},
			onHelperLaunch: async () => {
				await this.handleTokenHelperLaunch();
			},
			onExchangeOauthToken: async (token) => {
				await exchangeOauthToken(this, this.plugin, token);
			},
			addGithubInstructionsLink: (setting) => {
				this.addGithubInstructionsLink(setting);
			},
		});
	}

	private addGithubInstructionsLink(setting: Setting): void {
		addGithubInstructionsLinkSection(setting);
	}

	private addAdvancedSettings(containerEl: HTMLElement): void {
		addAdvancedSettingsSection(this.plugin, containerEl);
	}

	private async handleTokenPaste(event: ClipboardEvent): Promise<void> {
		const pastedText = event.clipboardData?.getData("text");
		if (pastedText && pastedText.trim().startsWith("oauth2_4")) {
			event.preventDefault();
			await exchangeOauthToken(this, this.plugin, pastedText.trim());
			this.display();
		}
	}

	private async handleTokenHelperLaunch(): Promise<void> {
		if (!this.plugin.settings.email || !this.isValidEmail(this.plugin.settings.email)) {
			new Notice(t("notices.invalidEmail"));
			return;
		}
		if (!Platform.isDesktopApp) {
			new Notice(t("notices.helperDesktopOnly"));
			return;
		}
		const sessionMetadata = {
			email: this.plugin.settings.email,
			pluginVersion: this.plugin.manifest.version,
			flow: "token-helper",
		};
		await startRetrievalWizardSession(this.plugin, sessionMetadata);
		await logRetrievalWizardEvent("info", "Token helper button clicked", sessionMetadata);
		const notice = new Notice(t("helper.checking"), 0);
		try {
			const state = await getTokenHelperState(this.plugin);
			if (state.status === "ready") {
				notice.setMessage(t("onboarding.helper.launching"));
				await this.runInstalledTokenHelper(notice);
				return;
			}
			notice.hide();
			if (state.status === "missing" || state.status === "outdated" || state.status === "incompatible") {
				new TokenHelperInstallModal(this.app, {
					plugin: this.plugin,
					manifest: state.latest,
					mode: state.status === "outdated" ? "update" : state.status === "incompatible" ? "replace" : "install",
					onManual: () => {
						new Notice("Use the manual retrieval option below, then paste the token into the sync token field.");
					},
					onToken: async (oauthToken) => {
						await exchangeOauthToken(this, this.plugin, oauthToken);
						await endRetrievalWizardSession("success", { flow: "token-helper" });
						this.display();
					},
					onError: async (message) => {
						new Notice(message);
						await logRetrievalWizardEvent("error", "Token helper failed", { errorMessage: message });
					},
					onComplete: () => {
						this.display();
					},
				}).open();
				return;
			}
			new Notice(t("helper.manualNext"));
			await logRetrievalWizardEvent("error", "Token helper unavailable", { reason: state.reason });
			await endRetrievalWizardSession("error", { flow: "token-helper", reason: state.reason });
		} catch (error) {
			notice.hide();
			const message = error instanceof Error ? error.message : t("helper.failed");
			new Notice(message);
			await logRetrievalWizardEvent("error", "Token helper failed", { errorMessage: message });
			await endRetrievalWizardSession("error", {
				flow: "token-helper",
				reason: message,
			});
		}
	}

	private async runInstalledTokenHelper(notice: Notice): Promise<void> {
		await runTokenHelper(this.plugin, async (event) => {
			if (event.type === "progress") {
				notice.setMessage(event.message);
				return;
			}
			if (event.type === "token") {
				await exchangeOauthToken(this, this.plugin, event.oauthToken);
				notice.hide();
				await endRetrievalWizardSession("success", { flow: "token-helper" });
				this.display();
			}
			if (event.type === "error") {
				throw new Error(event.message);
			}
		});
	}

	private addSaveLocationSetting(containerEl: HTMLElement): void {
		addSaveLocationSettingSection(this.plugin, containerEl);
	}

	private async addAutoSyncSettings(containerEl: HTMLElement): Promise<void> {
		await addAutoSyncSettingsSection(this.plugin, containerEl);
	}
}
