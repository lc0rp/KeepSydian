import KeepSidianPlugin from "./app/main";
import { FeedbackSurveyModal } from "./ui/modals/FeedbackSurveyModal";

export default class KeepSydianPlugin extends KeepSidianPlugin {
	async onload(): Promise<void> {
		await super.onload();
		await this.maybeShowFeedbackSurvey();
	}

	private async maybeShowFeedbackSurvey(): Promise<void> {
		const currentVersion = this.manifest.version?.trim();
		if (!currentVersion || this.settings.feedbackPromptLastShownVersion === currentVersion) {
			return;
		}

		this.settings.feedbackPromptLastShownVersion = currentVersion;
		await this.saveSettings();
		new FeedbackSurveyModal(this.app, currentVersion).open();
	}
}
