import { retryDownload } from "../download-retry";
import { NetworkError, ParseError } from "@services/errors";

function clock() {
	let elapsed = 0;
	return {
		now: () => elapsed,
		random: () => 0.5,
		sleep: async (ms: number) => {
			elapsed += ms;
		},
		checkCancelled: jest.fn(),
		onRetry: jest.fn(async () => {}),
	};
}

describe("download retry policy", () => {
	it.each([429, 502, 503, 504])("replays an uncommitted page after HTTP %s", async (status) => {
		const fetch = jest.fn().mockRejectedValueOnce(new NetworkError("temporary", status)).mockResolvedValue("page");
		const options = clock();
		await expect(retryDownload(fetch, options)).resolves.toBe("page");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(options.now()).toBe(2000);
	});
	it("honors Retry-After and refuses delays beyond the elapsed budget", async () => {
		const error = new NetworkError("busy", 429);
		error.retryAfterMs = 20_000;
		const fetch = jest.fn().mockRejectedValue(error);
		const options = clock();
		await expect(retryDownload(fetch, options)).rejects.toBe(error);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(options.now()).toBe(20_000);
	});
	it.each([
		new NetworkError("auth", 401),
		new NetworkError("forbidden", 403),
		new ParseError("schema"),
		new Error("unknown"),
	])("does not retry permanent or unknown failures", async (error) => {
		const fetch = jest.fn().mockRejectedValue(error);
		await expect(retryDownload(fetch, clock())).rejects.toBe(error);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("stops backoff when canceled", async () => {
		const options = clock();
		const canceled = new Error("canceled");
		options.checkCancelled.mockImplementation(() => {
			if (options.now() >= 100) throw canceled;
		});
		const fetch = jest.fn().mockRejectedValue(new NetworkError("busy", 503));
		await expect(retryDownload(fetch, options)).rejects.toBe(canceled);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
