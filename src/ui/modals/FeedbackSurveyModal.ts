import { t } from "../../lang/ui";
import { Modal, Setting, type App } from "obsidian";

export const FEEDBACK_SURVEY_URL = "https://forms.gle/pVs8GtohFWmqs5F4A";

export const WHATS_NEW_ITEMS = [
	"A failed image or attachment download no longer stops the rest of your notes from importing.",
	"KeepSydian preserves existing YAML comments and formatting when it refreshes imported-note metadata.",
] as const;

export class FeedbackSurveyModal extends Modal {
	constructor(app: App, private readonly version: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.classList.add("keepsidian-feedback-modal");
		contentEl.createEl("h2", { text: `KeepSydian ${this.version}` });

		contentEl.createEl("h3", { text: t("feedback.whatsNew") });
		const whatsNewList = contentEl.createEl("ul");
		for (const item of [t("feedback.attachments"),t("feedback.yaml")]) {
			whatsNewList.createEl("li", { text: item });
		}

		contentEl.createEl("h3", { text: t("feedback.heading") });
		contentEl.createEl("p", {
			text: t("feedback.description"),
		});

		const actions = new Setting(contentEl);
		const surveyLink = actions.controlEl.createEl("a", {
			text: t("feedback.open"),
			attr: {
				href: FEEDBACK_SURVEY_URL,
				target: "_blank",
				rel: "noopener noreferrer",
				"data-keepsidian-link": "feedback-survey",
			},
		});
		surveyLink.classList.add("keepsidian-link-button");

		actions.addButton((button) =>
			button.setButtonText(t("feedback.later")).onClick(() => {
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
