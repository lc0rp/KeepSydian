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

		contentEl.createEl("h3", { text: "What's new" });
		const whatsNewList = contentEl.createEl("ul");
		for (const item of WHATS_NEW_ITEMS) {
			whatsNewList.createEl("li", { text: item });
		}

		contentEl.createEl("h3", { text: "Help shape what we build next" });
		contentEl.createEl("p", {
			text: "Take about 2–3 minutes to tell us what's working, what's frustrating, and what you'd most like us to improve; the survey opens on an external Google form in your browser.",
		});

		const actions = new Setting(contentEl);
		const surveyLink = actions.controlEl.createEl("a", {
			text: "Give feedback",
			attr: {
				href: FEEDBACK_SURVEY_URL,
				target: "_blank",
				rel: "noopener noreferrer",
				"data-keepsidian-link": "feedback-survey",
			},
		});
		surveyLink.classList.add("keepsidian-link-button");

		actions.addButton((button) =>
			button.setButtonText("Maybe later").onClick(() => {
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
