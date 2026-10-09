jest.mock("@services/http", () => ({ httpGetJson: jest.fn(), httpPostJson: jest.fn() }));
import { webcrypto } from "node:crypto";
import { httpGetJson, httpPostJson } from "@services/http";
import { prepareLocalEnrichment, enrichLocalNotes } from "../keepApi";

beforeEach(() => {
	jest.resetAllMocks();
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});

it("binds one POST to the server-issued process and time, without automatic retry", async () => {
	jest.mocked(httpGetJson).mockResolvedValue({ version: 1, epoch: "a".repeat(32), issued_at_ms: 1000 });
	const operation = await prepareLocalEnrichment("synthetic", "fake", "fake-supporter");
	expect(operation).toMatch(/^a{32}:1000:[a-f0-9-]{36}$/);
	jest.mocked(httpPostJson).mockRejectedValue(new Error("Lost response"));
	await expect(enrichLocalNotes("synthetic", "fake", [], "fake-supporter", operation)).rejects.toThrow("Lost response");
	expect(httpGetJson).toHaveBeenCalledTimes(1);
	expect(httpPostJson).toHaveBeenCalledTimes(1);
	expect(jest.mocked(httpPostJson).mock.calls[0][2]).toMatchObject({
		"X-Enrichment-Operation": operation,
		"X-Supporter-Key": "fake-supporter",
	});
});

it.each([
	null,
	{},
	{ version: 1, epoch: "wrong", issued_at_ms: 1000 },
	{ version: 1, epoch: "a".repeat(32), issued_at_ms: 0 },
])("refuses an invalid preflight without posting: %j", async (capability) => {
	jest.mocked(httpGetJson).mockResolvedValue(capability);
	await expect(prepareLocalEnrichment("synthetic", "fake")).rejects.toThrow();
	expect(httpPostJson).not.toHaveBeenCalled();
});

it("refuses an unprepared paid request", async () => {
	await expect(enrichLocalNotes("synthetic", "fake", [])).rejects.toThrow("must be prepared");
	expect(httpGetJson).not.toHaveBeenCalled();
	expect(httpPostJson).not.toHaveBeenCalled();
});
