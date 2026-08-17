jest.mock("obsidian");

import { App } from "obsidian";
import {
	FEEDBACK_SURVEY_URL,
	FeedbackSurveyModal,
	WHATS_NEW_ITEMS,
} from "../FeedbackSurveyModal";

describe("FeedbackSurveyModal", () => {
	it("renders release highlights and the external survey link", () => {
		const modal = new FeedbackSurveyModal(new App(), "2.0.20");

		modal.onOpen();

		expect(modal.contentEl.querySelector("h2")?.textContent).toBe("KeepSydian 2.0.20");
		const headings = Array.from(modal.contentEl.querySelectorAll("h3")).map(
			(element) => element.textContent
		);
		expect(headings).toEqual(["What's new", "Help shape what we build next"]);
		expect(Array.from(modal.contentEl.querySelectorAll("li")).map((element) => element.textContent)).toEqual(
			WHATS_NEW_ITEMS
		);

		const surveyLink = modal.contentEl.querySelector<HTMLAnchorElement>(
			'a[data-keepsidian-link="feedback-survey"]'
		);
		expect(surveyLink?.getAttribute("href")).toBe(FEEDBACK_SURVEY_URL);
		expect(surveyLink?.getAttribute("target")).toBe("_blank");
		expect(surveyLink?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(surveyLink?.textContent).toBe("Give feedback");
		expect(modal.contentEl.textContent).toContain("Maybe later");
	});

	it("clears its content when closed", () => {
		const modal = new FeedbackSurveyModal(new App(), "2.0.20");
		modal.onOpen();

		modal.onClose();

		expect(modal.contentEl.childElementCount).toBe(0);
	});
});
