import { extractFrontmatter, NormalizedNote, normalizeNote } from "../note";

describe("extractFrontmatter", () => {
	it.each(["---\n---\nBody", "---\r\n---\r\nBody", "---\n\n---\nBody"])(
		"accepts empty frontmatter during strict identity discovery: %j",
		(text) => {
			expect(extractFrontmatter(text, true)).toEqual(["", "Body", {}]);
		}
	);

	it("should extract frontmatter correctly", () => {
		const text = "---\nkey1: value1\nkey2: value2\n---\nThis is the body";
		const [frontmatter, body, frontmatterDict] = extractFrontmatter(text);

		expect(frontmatter).toBe("key1: value1\nkey2: value2");
		expect(body).toBe("This is the body");
		expect(frontmatterDict).toEqual({
			key1: "value1",
			Key1: "value1",
			key2: "value2",
			Key2: "value2",
		});
	});

	it("should handle text without frontmatter", () => {
		const text = "This is just body text";
		const [frontmatter, body, frontmatterDict] = extractFrontmatter(text);

		expect(frontmatter).toBe("");
		expect(body).toBe("This is just body text");
		expect(frontmatterDict).toEqual({});
	});

	it("should convert kebab-case to camelCase in frontmatter keys", () => {
		const text = "---\nkebab-key: value\n---\nBody";
		const [, , frontmatterDict] = extractFrontmatter(text);

		expect(frontmatterDict).toEqual({
			"kebab-key": "value",
			KebabKey: "value",
		});
	});

	it("should parse YAML values that include colons without truncating", () => {
		const text = "---\nsource-url: https://example.com/a:b?x=1\n---\nBody";
		const [, , frontmatterDict] = extractFrontmatter(text);

		expect(frontmatterDict).toEqual({
			"source-url": "https://example.com/a:b?x=1",
			SourceUrl: "https://example.com/a:b?x=1",
		});
	});

	it("should preserve nested YAML structures", () => {
		const text = "---\nmeta:\n  pinned: true\n  tags:\n    - work\n---\nBody";
		const [, , frontmatterDict] = extractFrontmatter(text);

		expect(frontmatterDict).toEqual({
			meta: { pinned: true, tags: ["work"] },
			Meta: { pinned: true, tags: ["work"] },
		});
	});

	it("should preserve body content after additional frontmatter delimiters", () => {
		const text = "---\nkey: value\n---\nLine 1\n---\nLine 2";
		const [frontmatter, body] = extractFrontmatter(text);

		expect(frontmatter).toBe("key: value");
		expect(body).toBe("Line 1\n---\nLine 2");
	});
});

describe("normalizeNote", () => {
	it("should normalize a note correctly", () => {
		const inputNote = {
			title: "  Test Note  ",
			text: "---\nkey: value\n---\nNote body",
			created: "2023-05-20T10:00:00Z",
			updated: "2023-05-21T11:00:00Z",
			archived: false,
			trashed: false,
			labels: ["label1", "label2"],
			blobs: ["blob1", "blob2"],
			blob_names: ["name1", "name2"],
			media: ["media1"],
			header: "header",
		};

		const normalizedNote: NormalizedNote = normalizeNote(inputNote);

		expect(normalizedNote.title).toBe("Test Note");
		expect(normalizedNote.text).toBe("---\nkey: value\n---\nNote body");
		expect(normalizedNote.created).toEqual(
			new Date("2023-05-20T10:00:00Z")
		);
		expect(normalizedNote.updated).toEqual(
			new Date("2023-05-21T11:00:00Z")
		);
		expect(normalizedNote.color).toBeNull();
		expect(normalizedNote.pinned).toBe(false);
		expect(normalizedNote.frontmatter).toBe("key: value");
		expect(normalizedNote.textWithoutFrontmatter).toBe("Note body");
		expect(normalizedNote.frontmatterDict).toEqual({
			key: "value",
			Key: "value",
		});
		expect(normalizedNote.archived).toBe(false);
		expect(normalizedNote.trashed).toBe(false);
		expect(normalizedNote.labels).toEqual(["label1", "label2"]);
		expect(normalizedNote.blobs).toEqual(["blob1", "blob2"]);
		expect(normalizedNote.blob_names).toEqual(["name1", "name2"]);
		expect(normalizedNote.media).toEqual(["media1"]);
		expect(normalizedNote.header).toBe("header");
	});

	it("should drop null blob_urls entries", () => {
		const inputNote = {
			title: "Note",
			blob_urls: ["https://a.test/file.png", null, "https://b.test/file.png"] as Array<
				string | null
			>,
		};

		const normalizedNote: NormalizedNote = normalizeNote(inputNote);

		expect(normalizedNote.blob_urls).toEqual([
			"https://a.test/file.png",
			"https://b.test/file.png",
		]);
	});

	it("should handle a note without frontmatter", () => {
		const inputNote = {
			title: "Simple Note",
			text: "Just a simple note body",
			created: "2023-05-22T12:00:00Z",
			updated: "2023-05-22T12:00:00Z",
		};

		const normalizedNote: NormalizedNote = normalizeNote(inputNote);

		expect(normalizedNote.title).toBe("Simple Note");
		expect(normalizedNote.text).toBe("Just a simple note body");
		expect(normalizedNote.frontmatter).toBe("");
		expect(normalizedNote.textWithoutFrontmatter).toBe(
			"Just a simple note body"
		);
		expect(normalizedNote.frontmatterDict).toEqual({});
	});

	it("normalizes keep color and pinned state when present", () => {
		const normalizedNote = normalizeNote({
			title: "Colored Note",
			text: "Body",
			color: "YELLOW",
			pinned: true,
		});

		expect(normalizedNote.color).toBe("YELLOW");
		expect(normalizedNote.pinned).toBe(true);
	});
});
