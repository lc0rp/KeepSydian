import BaseKeepSidianPlugin from "./app/main";
import {
	buildPersistedSettings,
	persistSensitiveSettingsToSecretStorage,
} from "./app/main-secret-storage";
import { FeedbackSurveyModal } from "./ui/modals/FeedbackSurveyModal";

interface FeedbackPromptData {
	feedbackPromptLastShownVersion?: string;
}

export default class KeepSydianPlugin extends BaseKeepSidianPlugin {
	private feedbackPromptLastShownVersion?: string;

	async onload(): Promise<void> {
		await super.onload();
		const saved = (await this.loadData()) as FeedbackPromptData | null;
		this.feedbackPromptLastShownVersion = saved?.feedbackPromptLastShownVersion;
		await this.maybeShowFeedbackSurvey();
	}

	async saveSettings(): Promise<void> {
		this.settings.lastSyncSummary = this.lastSyncSummary;
		this.settings.lastSyncLogPath = this.lastSyncLogPath ?? null;
		persistSensitiveSettingsToSecretStorage(this);
		const persistedSettings = buildPersistedSettings(this);
		await this.saveData({
			...persistedSettings,
			...(this.feedbackPromptLastShownVersion
				? { feedbackPromptLastShownVersion: this.feedbackPromptLastShownVersion }
				: {}),
		});
	}

	private async maybeShowFeedbackSurvey(): Promise<void> {
		const currentVersion = this.manifest.version?.trim();
		if (!currentVersion || this.feedbackPromptLastShownVersion === currentVersion) {
			return;
		}

		this.feedbackPromptLastShownVersion = currentVersion;
		await this.saveSettings();
		new FeedbackSurveyModal(this.app, currentVersion).open();
	}
}
