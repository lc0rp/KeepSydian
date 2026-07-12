import { stripManagedImageEmbeds, withManagedImageEmbeds } from "../attachmentEmbeds";

describe("managed attachment embeds", () => {
	it("adds only unique image embeds without visible management markers", () => {
		const body = withManagedImageEmbeds("Body", ["photo.png", "audio.mp3", "photo.png"]);

		expect(body).toBe("Body\n\n![[media/photo.png]]");
	});

	it("replaces an existing managed block without duplicating embeds", () => {
		const first = withManagedImageEmbeds("Body", ["old.jpg"]);
		const second = withManagedImageEmbeds(first, ["new.png"]);

		expect(second).not.toContain("old.jpg");
		expect(second).toContain("![[media/new.png]]");
		expect(second.match(/!\[\[media\/new\.png\]\]/g)).toHaveLength(1);
	});

	it("removes legacy HTML-comment blocks from pre-release builds", () => {
		const legacy =
			"Body\n\n<!-- keepsidian-embedded-images:start -->\n![[media/old.png]]\n<!-- keepsidian-embedded-images:end -->";

		expect(stripManagedImageEmbeds(legacy)).toBe("Body");
	});
});
