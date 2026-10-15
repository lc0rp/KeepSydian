import { t } from "../../../lang/ui";
import type KeepSidianPlugin from "main";
import { Setting, setIcon } from "obsidian";
import type { IconName } from "obsidian";
import { SubscriptionSettingsTab } from "../SubscriptionSettingsTab";
import {
	DEFAULT_NOTE_FILE_NAME_PATTERN,
	NEW_INSTALL_SAVE_LOCATION,
	normalizeRootedVaultPath,
} from "../../../types/keepsidian-plugin-settings";
import { resolveNotePath } from "@services/note-path-resolver";

const PREVIEW_NOTE_TITLE = "Note";

function renderNotePathPreview(plugin: KeepSidianPlugin, containerEl: HTMLElement): void {
	const previewPath = resolveNotePath(plugin.app, plugin.settings, {
		title: PREVIEW_NOTE_TITLE,
		created: new Date(),
	});
	containerEl.innerHTML = "";
	containerEl.createEl("div", {
		cls: "keepsidian-note-path-preview__label",
		text: t("settings.locationPreview"),
	});
	containerEl.createEl("code", {
		cls: "keepsidian-note-path-preview__path",
		text: `<vault>/${previewPath}`,
	});
}

export function addSupportSection(plugin: KeepSidianPlugin, containerEl: HTMLElement): void {
	const supportRow = containerEl.createEl("div", {
		cls: "keepsidian-support-row",
	});

	supportRow.createEl("span", {
		cls: "keepsidian-support-version",
		text: `KeepSidian v${plugin.manifest.version}`,
	});

	supportRow.createEl("span", {
		cls: "keepsidian-support-spacer",
	});

	supportRow.createEl("span", {
		cls: "keepsidian-support-label",
		text: t("settings.needHelp"),
	});

	const linksContainer = supportRow.createEl("div", {
		cls: "keepsidian-support-links",
	});

	createSupportLink(linksContainer, t("settings.issues"), "https://github.com/lc0rp/KeepSidian/issues", "github");
	createSupportLink(linksContainer, "Discord DM (@lc0rp)", "https://discord.com/users/lc0rp", "message-circle");
}

function createSupportLink(parentEl: HTMLElement, label: string, href: string, icon: IconName): void {
	const linkEl = parentEl.createEl("a", {
		cls: "keepsidian-support-link",
	});
	linkEl.setAttribute("href", href);
	linkEl.setAttribute("target", "_blank");
	linkEl.setAttribute("rel", "noopener noreferrer");
	linkEl.setAttribute("aria-label", label);
	linkEl.setAttribute("title", label);

	const iconEl = linkEl.createEl("span", {
		cls: "keepsidian-support-icon",
	});
	setIcon(iconEl, icon);

	linkEl.createEl("span", {
		cls: "keepsidian-support-text",
		text: label,
	});
}

export async function addSubscriptionSettings(
	plugin: KeepSidianPlugin,
	containerEl: HTMLElement,
	onSupporterIdentityChanged?: () => Promise<void>
): Promise<void> {
	const subscriptionTab = new SubscriptionSettingsTab(containerEl, plugin, onSupporterIdentityChanged);
	await subscriptionTab.display();
}

export function addEmailSetting(plugin: KeepSidianPlugin, containerEl: HTMLElement): void {
	new Setting(containerEl)
		.setName(t("settings.email.name"))
		.setDesc(t("settings.email.description"))
		.addText((text) =>
			text
				.setPlaceholder(t("settings.email.placeholder"))
				.setValue(plugin.settings.email)
				.onChange(async (value) => {
					plugin.settings.email = value;
					await plugin.saveSettings();
				})
		);
}

export function addSaveLocationSetting(plugin: KeepSidianPlugin, containerEl: HTMLElement): void {
	const sectionEl = containerEl.createDiv();

	const render = () => {
		sectionEl.innerHTML = "";
		let previewSectionEl: HTMLElement | null = null;

		const updatePreview = () => {
			if (previewSectionEl) {
				renderNotePathPreview(plugin, previewSectionEl);
			}
		};

		new Setting(sectionEl)
			.setName(t("settings.saveLocation.name"))
			.setDesc(
				t("settings.saveLocation.description")
			)
			.addText((text) =>
				text
					.setPlaceholder(NEW_INSTALL_SAVE_LOCATION)
					.setValue(plugin.settings.saveLocation)
					.onChange(async (value) => {
						const normalizedValue = normalizeRootedVaultPath(value);
						plugin.settings.saveLocation = normalizedValue;
						text.setValue(normalizedValue);
						updatePreview();
						await plugin.saveSettings();
					})
			);

		new Setting(sectionEl)
			.setName(t("settings.filename.name"))
			.setDesc(
				t("settings.filename.description")
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_NOTE_FILE_NAME_PATTERN)
					.setValue(plugin.settings.noteFileNamePattern)
					.onChange(async (value) => {
						plugin.settings.noteFileNamePattern = value || DEFAULT_NOTE_FILE_NAME_PATTERN;
						updatePreview();
						await plugin.saveSettings();
					})
			);

		new Setting(sectionEl)
			.setName(t("settings.images.name"))
			.setDesc(
				t("settings.images.description")
			)
			.addToggle((toggle) =>
				toggle.setValue(plugin.settings.embedImportedImages).onChange(async (value) => {
					plugin.settings.embedImportedImages = value;
					await plugin.saveSettings();
				})
			);

		previewSectionEl = sectionEl.createDiv({
			cls: "keepsidian-note-path-preview",
		});
		updatePreview();
	};

	render();
}

export function addGithubInstructionsLink(setting: Setting): void {
	const githubInstructionsUrl = "https://github.com/djsudduth/keep-it-markdown";
	const githubInstructionsLink = setting.controlEl.createEl("a", {
		text: t("settings.kim"),
		attr: {
			href: githubInstructionsUrl,
			target: "_blank",
			rel: "noopener noreferrer",
			"data-keepsidian-link": "github-instructions",
		},
	});
	githubInstructionsLink.classList.add("keepsidian-link-button");
	githubInstructionsLink.setAttribute("role", "button");
}
