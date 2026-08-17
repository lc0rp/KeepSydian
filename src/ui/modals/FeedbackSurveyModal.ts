import { Modal, Setting, type App } from "obsidian";

export const FEEDBACK_SURVEY_URL = "https://forms.gle/pVs8GtohFWmqs5F4A";

export const WHATS_NEW_ITEMS = [
	"Imported Google Keep images can now be displayed directly in your Obsidian notes.",
	"Google Keep token setup and status feedback are clearer and more reliable.",
	"Compatibility and reliability have been improved across supported Obsidian environments.",
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
			text: "Got 2 minutes? Tell us what's working, what's frustrating, and what you'd most like us to improve.",
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
		surveyLink.setAttribute("role", "button");

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
