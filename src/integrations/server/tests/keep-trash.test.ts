import { httpPostJson } from "@services/http";
import { requestKeepTrash } from "../keepTrash";

jest.mock("@services/http", () => ({ httpPostJson: jest.fn() }));
const post = jest.mocked(httpPostJson);
const url = "https://keep.google.com/#NOTE/fixture-a";
const revision = "keep-v1:" + "a".repeat(64);
const note = { keep_url: url, expected_revision: revision };
const result = (status = "ready", keep_url = url) => ({ keep_url, status });

beforeEach(() => post.mockReset());

it("sends explicit identities and revision receipts using authenticated POST", async () => {
	post.mockResolvedValue({ version: 1, complete: true, results: [result()] });
	expect(await requestKeepTrash("fixture@example.com", "fixture-token", [note])).toEqual([result()]);
	expect(post).toHaveBeenCalledWith(expect.stringMatching(/\/keep\/trash\/preview\/v1$/),
		{ version: 1, notes: [note] }, { "Content-Type": "application/json", "X-User-Email": "fixture@example.com", Authorization: "Bearer fixture-token" });
});

it.each([
	[], [note, note], Array.from({ length: 21 }, (_, index) => ({ ...note, keep_url: url + index })),
	[{ ...note, keep_url: "https://keep.google.com/u/1/#NOTE/fixture-a" }],
	[{ ...note, keep_url: "https://keep.google.com/#NOTE/unsafe%2Fidentity" }],
	[{ ...note, expected_revision: "2026-09-01" }],
].map((notes) => ({ notes })))("rejects an unsafe or unbounded request before network I/O", async ({ notes }) => {
	await expect(requestKeepTrash("fixture@example.com", "fixture-token", notes)).rejects.toThrow();
	expect(post).not.toHaveBeenCalled();
});

it.each([
	{ version: 1, complete: true, results: [] },
	{ version: 1, complete: true, results: [result(), result()] },
	{ version: 1, complete: true, results: [result("ready", url + "-other")] },
	{ version: 1, complete: true, results: [{ ...result(), body: "not allowed" }] },
	{ version: 1, complete: true, results: [result()], token: "not allowed" },
	{ version: 1, complete: false, results: [result()] },
	{ version: 1, complete: true, results: [result("trashed")] },
])("rejects incomplete or overbroad preview evidence", async (response) => {
	post.mockResolvedValue(response);
	await expect(requestKeepTrash("fixture@example.com", "fixture-token", [note])).rejects.toThrow();
});

it.each([
	{ complete: true, status: "ready" },
	{ complete: true, status: "failed" },
	{ complete: true, status: "not_processed" },
	{ complete: false, status: "trashed" },
	{ complete: false, status: "already_trashed" },
])("rejects inconsistent application acknowledgement", async ({ complete, status }) => {
	post.mockResolvedValue({ version: 1, complete, results: [result(status)] });
	await expect(requestKeepTrash("fixture@example.com", "fixture-token", [note], true)).rejects.toThrow();
});

it("preserves explicit partial outcomes rather than inventing success", async () => {
	const second = { ...note, keep_url: url + "-b" };
	const results = [result("trashed"), result("failed", second.keep_url)];
	post.mockResolvedValue({ version: 1, complete: false, results });
	expect(await requestKeepTrash("fixture@example.com", "fixture-token", [note, second], true)).toEqual(results);
	expect(post.mock.calls[0][0]).toMatch(/\/keep\/trash\/v1$/);
});

it.each(["trashed", "already_trashed", "conflict", "missing", "unverifiable"])("returns the explicit %s outcome unchanged", async (status) => {
	post.mockResolvedValue({ version: 1, complete: true, results: [result(status)] });
	expect(await requestKeepTrash("fixture@example.com", "fixture-token", [note], true)).toEqual([result(status)]);
});

it("propagates failures without retrying or choosing a different delete endpoint", async () => {
	post.mockRejectedValue(new Error("fixture unavailable"));
	await expect(requestKeepTrash("fixture@example.com", "fixture-token", [note], true)).rejects.toThrow("fixture unavailable");
	expect(post).toHaveBeenCalledTimes(1);
});
