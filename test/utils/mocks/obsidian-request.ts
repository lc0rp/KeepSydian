// Helpers to stub Obsidian's requestUrl in tests
import * as obsidian from "obsidian";
import type { RequestUrlResponse } from "obsidian";

type Headers = Record<string, string>;

const baseResponse = (
	status: number,
	headers: Headers = {}
): RequestUrlResponse => ({
	status,
	headers,
	arrayBuffer: new ArrayBuffer(0),
	json: undefined,
	text: "",
});

export function mockRequestUrlJsonOnce(
	json: unknown,
	status = 200,
	headers: Headers = {}
) {
	return jest.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
		...baseResponse(status, headers),
		json: async () => json,
		text: JSON.stringify(json),
	});
}

export function mockRequestUrlTextOnce(
	text: string,
	status = 200,
	headers: Headers = {}
) {
	return jest.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
		...baseResponse(status, headers),
		text,
	});
}

export function mockRequestUrlStatusOnce(
	status: number,
	body?: unknown,
	headers: Headers = {}
) {
	const responseText = body ? JSON.stringify(body) : "";
	return jest.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
		...baseResponse(status, headers),
		text: responseText,
	});
}

export function restoreRequestUrlMock() {
	jest.restoreAllMocks();
}
