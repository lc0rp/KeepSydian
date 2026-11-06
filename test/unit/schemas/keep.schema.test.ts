import { GoogleKeepImportResponseSchema, PremiumFeatureFlagsSchema } from "../../../src/schemas/keep";
import {
  validResponsePage,
  validResponsePageWithCursor,
  validEmptyResponsePage,
  invalidResponseMissingNotes,
  invalidResponseWrongNoteShape,
  responseWithNullBlobUrl,
  validFlags,
  invalidFlagsMissingSuggestTagsFields,
  invalidFlagsWrongTermsType,
} from "../../utils/fixtures/keep-responses";

describe("GoogleKeepImportResponseSchema", () => {
  it("accepts a valid response page with total_notes", () => {
    const parsed = GoogleKeepImportResponseSchema.parse(validResponsePage);
    expect(parsed.notes.length).toBe(1);
    expect(parsed.total_notes).toBe(1);
    expect(parsed.notes[0]?.color).toBe("DEFAULT");
    expect(parsed.notes[0]?.pinned).toBe(false);
  });

  it("accepts a valid empty page without total_notes", () => {
    const parsed = GoogleKeepImportResponseSchema.parse(validEmptyResponsePage);
    expect(parsed.notes.length).toBe(0);
    expect(parsed.total_notes).toBeUndefined();
  });

  it("accepts next_cursor for cursor-based pagination", () => {
    const parsed = GoogleKeepImportResponseSchema.parse(validResponsePageWithCursor);
    expect(parsed.next_cursor).toBe("cursor-1");
  });

  it("rejects a response missing notes", () => {
    const res = GoogleKeepImportResponseSchema.safeParse(invalidResponseMissingNotes);
    expect(res.success).toBe(false);
  });

  it("rejects a response with wrong note shape", () => {
    const res = GoogleKeepImportResponseSchema.safeParse(invalidResponseWrongNoteShape);
    expect(res.success).toBe(false);
  });

  it("accepts blob_urls entries that are null", () => {
    const res = GoogleKeepImportResponseSchema.safeParse(responseWithNullBlobUrl);
    expect(res.success).toBe(true);
  });
});

describe("PremiumFeatureFlagsSchema", () => {
  it("accepts full valid flags including suggest_title {}", () => {
    const parsed = PremiumFeatureFlagsSchema.parse(validFlags);
    expect(parsed.suggest_title).toEqual({});
    expect(parsed.suggest_tags?.prefix).toBe("auto-");
    expect(parsed.keep_state_filter).toEqual({
      colors: ["DEFAULT", "YELLOW"],
      pinned: "pinned",
      archived: "all",
    });
  });

  it("rejects suggest_tags with missing fields", () => {
    const res = PremiumFeatureFlagsSchema.safeParse(invalidFlagsMissingSuggestTagsFields);
    expect(res.success).toBe(false);
  });

  it("rejects filter_notes with non-string terms", () => {
    const res = PremiumFeatureFlagsSchema.safeParse(invalidFlagsWrongTermsType);
    expect(res.success).toBe(false);
  });
});
