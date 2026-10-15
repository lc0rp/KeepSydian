import { t } from "../../../lang/ui";
import type KeepSidianPlugin from "main";
import { Platform, Setting, setIcon } from "obsidian";
import { TOKEN_HELPER_SOURCE_URL } from "@integrations/google/tokenHelper";

interface TokenSettingOptions {
	plugin: KeepSidianPlugin;
	helperInstalled: boolean;
	isLikelyLongLivedToken: (token?: string | null) => boolean;
	onTokenPaste: (event: ClipboardEvent) => Promise<void>;
	onHelperLaunch: () => Promise<void>;
	onExchangeOauthToken: (token: string) => Promise<void>;
	addGithubInstructionsLink: (setting: Setting) => void;
}

export function addSyncTokenSetting(containerEl: HTMLElement, options: TokenSettingOptions): void {
	const { plugin } = options;
	const tokenSetting = new Setting(containerEl)
		.setName(t("settings.token.name"))
		.setDesc(t(Platform.isMobileApp ? "settings.token.description.mobile" : "settings.token.description.desktop"));

	const tokenStatus = tokenSetting.nameEl.createDiv("keepsidian-token-status keepsidian-hidden");
	const statusIcon = tokenStatus.createEl("span", {
		cls: "keepsidian-token-status__icon",
	});
	setIcon(statusIcon, "check-circle");
	tokenStatus.createEl("span", {
		text: t("settings.token.retrieved"),
		cls: "keepsidian-token-status__text",
	});

	const updateTokenStatus = (tokenValue: string) => {
		const hasValidToken = options.isLikelyLongLivedToken(tokenValue);
		if (hasValidToken) {
			tokenStatus.classList.remove("keepsidian-hidden");
			tokenSetting.settingEl.classList.add("keepsidian-token-valid");
		} else {
			tokenStatus.classList.add("keepsidian-hidden");
			tokenSetting.settingEl.classList.remove("keepsidian-token-valid");
		}
	};

	tokenSetting.addText((text) => {
		text
			.setPlaceholder(t("settings.token.placeholder"))
			.setValue(plugin.settings.token)
			.onChange(async (value) => {
				const trimmedValue = value.trim();
				if (trimmedValue.startsWith("oauth2_4")) {
					await options.onExchangeOauthToken(trimmedValue);
					text.inputEl.value = plugin.settings.token;
					updateTokenStatus(plugin.settings.token);
					return;
				}
				plugin.settings.token = value;
				await plugin.saveSettings();
				updateTokenStatus(plugin.settings.token);
			});
		text.inputEl.type = "password";
		const onPaste = (event: ClipboardEvent) => {
			void options.onTokenPaste(event);
		};
		text.inputEl.addEventListener("paste", onPaste);
		const toggleButton = text.inputEl.parentElement?.createEl("button", {
			text: t("common.show"),
		});
		toggleButton?.addEventListener("click", (event) => {
			event.preventDefault();
			if (text.inputEl.type === "password") {
				text.inputEl.type = "text";
				toggleButton.textContent = t("common.hide");
			} else {
				text.inputEl.type = "password";
				toggleButton.textContent = t("common.show");
			}
		});

		updateTokenStatus(plugin.settings.token);
	});

	if (Platform.isDesktopApp) {
		const retrievalSetting = new Setting(containerEl)
			.setName(t("settings.token.guided"))
			.setDesc("");
		retrievalSetting.descEl.createEl("span", {
			cls: [
				"keepsidian-token-helper-availability",
				options.helperInstalled ? "is-installed" : "is-missing",
			],
			text: options.helperInstalled ? t("settings.token.wizardDownloaded") : t("settings.token.wizardNeeded"),
		});
		retrievalSetting.descEl.append(
			" " + t("settings.token.wizardDescription")
		);

		retrievalSetting.addButton((button) =>
			button.setButtonText(t("settings.token.launchWizard")).onClick(() => void options.onHelperLaunch())
		);
		const sourceLink = retrievalSetting.controlEl.createEl("a", {
			cls: ["keepsidian-link-button", "keepsidian-token-helper-source-button"],
			attr: {
				href: TOKEN_HELPER_SOURCE_URL,
				target: "_blank",
				rel: "noopener noreferrer",
				role: "button",
				"data-keepsidian-link": "token-helper-source",
				"aria-label": t("settings.token.viewSource"),
			},
		});
		const sourceIcon = sourceLink.createEl("span", { cls: "keepsidian-token-helper-source-button__icon" });
		setIcon(sourceIcon, "github");
		sourceLink.createEl("span", { text: t("settings.token.viewSource") });

		const githubSetting = new Setting(containerEl)
			.setName(t("settings.token.manual"))
			.setDesc(
				t("settings.token.manualDescription")
			);
		options.addGithubInstructionsLink(githubSetting);

		new Setting(containerEl)
			.setName(t("settings.debug.name"))
			.setDesc(t("settings.debug.description"))
			.addToggle((toggle) => {
				toggle.setValue(plugin.settings.oauthDebugMode ?? false).onChange(async (value) => {
					plugin.settings.oauthDebugMode = value;
					await plugin.saveSettings();
				});
			});
	} else {
		const retrievalSetting = new Setting(containerEl).setName(t("settings.token.mobileInstructions"));
		retrievalSetting.setDesc(t("settings.token.mobileDescription"));
		options.addGithubInstructionsLink(retrievalSetting);
	}
}

export function addAdvancedSettings(plugin: KeepSidianPlugin, containerEl: HTMLElement): void {
	new Setting(containerEl).setName("Advanced & debug").setHeading();

	const oauthFlowSetting = new Setting(containerEl)
		.setName(t("settings.oauth.name"))
		.setDesc(t("settings.oauth.description"))
		.addDropdown((dropdown) => {
			dropdown.addOption("desktop", t("settings.oauth.embedded")).addOption("webviewer", t("settings.oauth.webViewer"));
			dropdown.setValue(plugin.settings.oauthFlow ?? "desktop");
			dropdown.onChange(async (value) => {
				plugin.settings.oauthFlow = value as "desktop" | "webviewer";
				await plugin.saveSettings();
			});
			if (!Platform.isDesktopApp) {
				dropdown.setDisabled(true);
			}
		});

	if (!Platform.isDesktopApp) {
		oauthFlowSetting.setDesc(t("settings.oauth.mobileDescription"));
	}

	if (plugin.settings.oauthPlaywrightUseSystemBrowser !== true) {
		plugin.settings.oauthPlaywrightUseSystemBrowser = true;
		void plugin.saveSettings();
	}
}
