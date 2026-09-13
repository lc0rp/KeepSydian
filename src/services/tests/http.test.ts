import { requestUrl } from "obsidian";
import { httpGetJson } from "../http";
import { NetworkError } from "../errors";

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
});
