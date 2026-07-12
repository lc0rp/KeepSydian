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
		const helperDescription = document.createDocumentFragment();
		const helperStatus = document.createElement("span");
		helperStatus.className = options.helperInstalled
			? "keepsidian-token-helper-availability is-installed"
			: "keepsidian-token-helper-availability is-missing";
		helperStatus.textContent = options.helperInstalled ? "Wizard downloaded." : "Wizard download needed.";
		helperDescription.appendChild(helperStatus);
		helperDescription.appendChild(
			document.createTextNode(
				" This option uses a Wizard to open a web browser, guide sign-in, and retrieve the token. It requires a small open-source download."
			)
		);

		const retrievalSetting = new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- Requested option title.
			.setName("Option 1: Guided token retrieval (desktop only)")
			.setDesc(helperDescription);

		retrievalSetting.addButton((button) =>
			button.setButtonText("Launch wizard").onClick(() => void options.onHelperLaunch())
		);
		const sourceLink = retrievalSetting.controlEl.createEl("a", {
			cls: ["keepsidian-link-button", "keepsidian-token-helper-source-button"],
			attr: {
				href: TOKEN_HELPER_SOURCE_URL,
				target: "_blank",
				rel: "noopener noreferrer",
				role: "button",
				"data-keepsidian-link": "token-helper-source",
				"aria-label": "View wizard source code",
			},
		});
		const sourceIcon = sourceLink.createEl("span", { cls: "keepsidian-token-helper-source-button__icon" });
		setIcon(sourceIcon, "github");
		sourceLink.createEl("span", { text: "View wizard source code" });

		const githubSetting = new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- Requested option title.
			.setName("Option 2: Manual retrieval instructions")
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
		const retrievalSetting = new Setting(containerEl).setName("Token retrieval instructions");
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
