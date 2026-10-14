import { t } from "../../lang/ui";
import { App, Modal, Setting } from "obsidian";
import { SubscriptionSettingsTab } from "../settings/SubscriptionSettingsTab";
import KeepSidianPlugin from "main";
import type { KeepArchivedStatus, KeepPinnedStatus } from "../../types/subscription";
import { chooseLegacyTags, type LegacyTagConsent } from "@features/keep/enrichment/consent";
import { renderLegacyTagChoice } from "./legacy-tag-choice";

export interface NoteImportOptions {
	includeNotesTerms?: string[];
	excludeNotesTerms?: string[];
	includeColors?: string[];
	pinnedStatus?: KeepPinnedStatus;
	archivedStatus?: KeepArchivedStatus;
	updateTitle?: boolean;
	suggestTags?: boolean;
	maxTags?: number;
	tagPrefix?: string;
	limitToExistingTags?: boolean;
	/** Explicit for this download; never part of persisted premium settings. */
	legacyTagConsent?: LegacyTagConsent;
}

export class NoteImportOptionsModal extends Modal {
	private onSubmit: (options: NoteImportOptions) => void;
	private plugin: KeepSidianPlugin;
	constructor(app: App, plugin: KeepSidianPlugin, onSubmit: (options: NoteImportOptions) => void) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("sync.downloadOptions") });
		contentEl.createEl("p", {
			text: t("sync.supporterThanks"),
		});
		SubscriptionSettingsTab.displayPremiumFeatures(contentEl, this.plugin, true);
		let legacyTags = false;
		renderLegacyTagChoice(contentEl, false, (value) => {
			legacyTags = value;
		});

		// Submit Button
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("common.import"))
					.setCta()
					.onClick(() => {
						this.onSubmit({
							...this.plugin.settings.premiumFeatures,
							legacyTagConsent: legacyTags ? chooseLegacyTags() : undefined,
						});
						this.close();
					})
			)
			.addButton((btn) =>
				btn.setButtonText(t("common.cancel")).onClick(() => {
					this.close();
				})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
