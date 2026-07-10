import type KeepSidianPlugin from "main";
import { Platform, Setting, setIcon } from "obsidian";

interface TokenSettingOptions {
	plugin: KeepSidianPlugin;
	isLikelyLongLivedToken: (token?: string | null) => boolean;
	onTokenPaste: (event: ClipboardEvent) => Promise<void>;
	onHelperLaunch: () => Promise<void>;
	onExchangeOauthToken: (token: string) => Promise<void>;
	addGithubInstructionsLink: (setting: Setting) => void;
}

export function addSyncTokenSetting(containerEl: HTMLElement, options: TokenSettingOptions): void {
	const { plugin } = options;
	new Setting(containerEl).setName("Retrieve sync token").setHeading();
	const tokenSetting = new Setting(containerEl)
		.setName("Sync token")
		.setDesc(
			"This token authorizes access to your Google Keep data. KeepSidian stores it securely via Obsidian secret storage when available." +
				(Platform.isMobileApp
					? " Paste a token retrieved on desktop, or follow the GitHub instructions further down below."
					: " Retrieve your token using the options below, or paste it directly here.")
		);

	const tokenStatus = tokenSetting.nameEl.createDiv("keepsidian-token-status keepsidian-hidden");
	const statusIcon = tokenStatus.createEl("span", {
		cls: "keepsidian-token-status__icon",
	});
	setIcon(statusIcon, "check-circle");
	tokenStatus.createEl("span", {
		text: "Retrieved successfully",
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
			.setPlaceholder("Google Keep sync token.")
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
			text: "Show",
		});
		toggleButton?.addEventListener("click", (event) => {
			event.preventDefault();
			if (text.inputEl.type === "password") {
				text.inputEl.type = "text";
				toggleButton.textContent = "Hide";
			} else {
				text.inputEl.type = "password";
				toggleButton.textContent = "Show";
			}
		});

		updateTokenStatus(plugin.settings.token);
	});

	if (Platform.isDesktopApp) {
		const retrievalSetting = new Setting(containerEl)
			.setName("Guided token retrieval")
			.setDesc(
				"Use the open-source KeepSidian token helper to open a real browser, guide sign-in, and return the token directly to KeepSidian. If the helper is not installed, KeepSidian will ask before downloading it."
			);

		retrievalSetting.addButton((button) =>
			button.setButtonText("Retrieve token with helper").onClick(() => void options.onHelperLaunch())
		);

		const githubSetting = new Setting(containerEl)
			.setName("Manual retrieval")
			.setDesc(
				'Prefer manual steps? Click the button to follow the GitHub KIM instructions, and paste the token into the "sync token" field above.'
			);
		options.addGithubInstructionsLink(githubSetting);

		new Setting(containerEl)
			.setName("Enable debug logging")
			.setDesc("Log retrieval steps to the console.")
			.addToggle((toggle) => {
				toggle.setValue(plugin.settings.oauthDebugMode ?? false).onChange(async (value) => {
					plugin.settings.oauthDebugMode = value;
					await plugin.saveSettings();
				});
			});
	} else {
		const retrievalSetting = new Setting(containerEl).setName("Retrieve your sync token");
		retrievalSetting.setDesc("Mobile: use a desktop-synced token or the GitHub KIM instructions below.");
		options.addGithubInstructionsLink(retrievalSetting);
	}
}

export function addAdvancedSettings(plugin: KeepSidianPlugin, containerEl: HTMLElement): void {
	new Setting(containerEl).setName("Advanced & debug").setHeading();

	const oauthFlowSetting = new Setting(containerEl)
		.setName("OAuth flow")
		.setDesc("Choose how KeepSidian opens the Google login flow on desktop. The web viewer opens a separate tab.")
		.addDropdown((dropdown) => {
			dropdown.addOption("desktop", "Embedded panel (default)").addOption("webviewer", "Web viewer tab");
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
		oauthFlowSetting.setDesc("Desktop only: OAuth flow selection is disabled on mobile.");
	}

	if (plugin.settings.oauthPlaywrightUseSystemBrowser !== true) {
		plugin.settings.oauthPlaywrightUseSystemBrowser = true;
		void plugin.saveSettings();
	}
}
