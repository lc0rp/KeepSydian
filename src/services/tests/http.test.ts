import { requestUrl } from "obsidian";
import { httpGetJson } from "../http";
import { NetworkError } from "../errors";
import { getReplayEpoch } from "@integrations/server/keepApi";

jest.mock("obsidian", () => ({
	requestUrl: jest.fn(),
}));

describe("httpRequest supporter key handling", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("requests response status handling and redacts key-bearing transport errors", async () => {
		const rawError = new Error("Request failed with headers X-Supporter-Key: ABCD-EFGH-IJKL-MN12");
		(requestUrl as jest.Mock).mockRejectedValueOnce(rawError);

		let caught: unknown;
		try {
			await httpGetJson("https://keepsidian.com/subscriber/info", {
				"X-Supporter-Key": "ABCD-EFGH-IJKL-MN12",
			});
		} catch (error) {
			caught = error;
		}

		expect(requestUrl).toHaveBeenCalledWith({
			url: "https://keepsidian.com/subscriber/info",
			method: "GET",
			headers: { "X-Supporter-Key": "ABCD-EFGH-IJKL-MN12" },
			throw: false,
		});
		expect(caught).toBeInstanceOf(NetworkError);
		expect(caught).toMatchObject({
			message: "Unable to reach the KeepSidian server",
			cause: undefined,
		});
		expect(JSON.stringify(caught)).not.toContain("ABCD-EFGH-IJKL-MN12");
	});
	it("retains HTTP status for ordinary sync requests without a supporter key", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			status: 504,
			json: { error: "Upstream timeout" },
			headers: {},
		});
		await expect(httpGetJson("https://example.invalid/keep/sync/v2")).rejects.toMatchObject({
			status: 504,
			kind: "network",
		});
		expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({ throw: false }));
	});
	it("uses a dedicated cheap capability URL and disables premium replay on an old server", async () => {
		(requestUrl as jest.Mock).mockResolvedValueOnce({ status: 404, text: "Not Found", headers: {} });
		await expect(getReplayEpoch("fixture@example.invalid", "fixture-token")).resolves.toBeUndefined();
		expect(requestUrl).toHaveBeenCalledTimes(1);
		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: expect.stringMatching(/\/keep\/sync\/capabilities$/),
				method: "GET",
			})
		);
	});
});
