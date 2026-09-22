import { canonicalKeepUrl, fetchDeletedKeepUrls } from "../keepDeletions";
import { httpGetJson } from "@services/http";

jest.mock("@services/http");
const get = jest.mocked(httpGetJson);
const url = "https://keep.google.com/#NOTE/note-1";

beforeEach(() => jest.resetAllMocks());

it.each([
	[url, url],
	["https://keep.google.com/u/0/#NOTE/note-1", url],
	["https://keep.google.com/#NOTE/abc%3Adef", "https://keep.google.com/#NOTE/abc%3Adef"],
	["https://keep.google.com/#NOTE/abc:def", "https://keep.google.com/#NOTE/abc%3Adef"],
])("canonicalizes an exact Keep identity: %s", (input, expected) => {
	expect(canonicalKeepUrl(input)).toBe(expected);
});

it.each([
	undefined, null, 1, "", "note-1", "https://evil.example/#NOTE/note-1",
	"https://keep.google.com.evil.example/#NOTE/note-1", "http://keep.google.com/#NOTE/note-1",
	"https://keep.google.com/#NOTE/", "https://keep.google.com/#NOTE/a%2Fb",
	"https://user:pass@keep.google.com/#NOTE/note-1", "https://keep.google.com:8443/#NOTE/note-1",
	"https://keep.google.com/other/#NOTE/note-1", "https://keep.google.com/#NOTE/%broken",
])("does not accept a filename, malformed identity, or other origin: %s", (input) => {
	expect(canonicalKeepUrl(input)).toBeUndefined();
});

it("authenticates the separate feed without download filters or supporter gating", async () => {
	get.mockResolvedValue({ version: 1, complete: true, deleted_keep_urls: [url, url] });
	await expect(fetchDeletedKeepUrls("test@example.com", "test-token")).resolves.toEqual(new Set([url]));
	expect(get).toHaveBeenCalledWith(expect.stringMatching(/\/keep\/deletions\/v1$/), {
		"Content-Type": "application/json",
		"X-User-Email": "test@example.com",
		Authorization: "Bearer test-token",
	});
});

it.each([
	{}, { notes: [] }, { version: 1, deleted_keep_urls: [url] },
	{ version: 1, complete: false, deleted_keep_urls: [url] },
	{ version: 2, complete: true, deleted_keep_urls: [url] },
	{ version: 1, complete: true, deleted_keep_urls: [url, "bad"] },
	{ version: 1, complete: true, deleted_keep_urls: Array(20_001).fill(url) },
])("rejects unsupported, partial, malformed, or oversized snapshots", async (response) => {
	get.mockResolvedValue(response);
	await expect(fetchDeletedKeepUrls("test@example.com", "test-token")).rejects.toThrow();
});

it("preserves network failures instead of treating them as an empty trash", async () => {
	const error = new Error("unavailable");
	get.mockRejectedValue(error);
	await expect(fetchDeletedKeepUrls("test@example.com", "test-token")).rejects.toBe(error);
});

it("accepts a complete empty trash without inventing missing-note deletions", async () => {
	get.mockResolvedValue({ version: 1, complete: true, deleted_keep_urls: [] });
	await expect(fetchDeletedKeepUrls("test@example.com", "test-token")).resolves.toEqual(new Set());
});
