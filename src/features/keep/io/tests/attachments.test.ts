import { requestUrl } from "obsidian";
import { processAttachments } from "../attachments";
import KeepSidianPlugin from "main";
import { NetworkError } from "../../../../services/errors";

// Mock the plugin
const mockPlugin = {
	app: {
		vault: {
			adapter: {
				writeBinary: jest.fn(),
				exists: jest.fn(),
				readBinary: jest.fn(),
			},
		},
	},
} as unknown as KeepSidianPlugin;

// Mock requestUrl
jest.mock("obsidian", () => ({
	requestUrl: jest.fn(),
}));

const expectAttachmentMetrics = (
	result: Awaited<ReturnType<typeof processAttachments>>,
	overrides: Partial<Awaited<ReturnType<typeof processAttachments>>>
) => {
	expect(result).toEqual(
		expect.objectContaining({
			downloaded: 0,
			skippedIdentical: 0,
			totalDurationMs: expect.any(Number),
			fetchDurationMs: expect.any(Number),
			compareDurationMs: expect.any(Number),
			writeDurationMs: expect.any(Number),
			...overrides,
		})
	);
};

describe("processAttachments", () => {
	beforeEach(() => {
		// Clear all mocks before each test
		jest.clearAllMocks();
		// Add spy on console.error
		jest.spyOn(console, "error").mockImplementation(() => {});
		jest.spyOn(console, "warn").mockImplementation(() => {});
		(mockPlugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("should successfully process single attachment", async () => {
		// Mock successful blob response
		const mockArrayBuffer = new ArrayBuffer(8);
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			arrayBuffer: mockArrayBuffer,
		});

		const blobUrls = ["https://example.com/image1.jpg"];
		const saveLocation = "/test/location";

		const result = await processAttachments(mockPlugin.app, blobUrls, saveLocation);

		// Verify requestUrl was called correctly
		expect(requestUrl).toHaveBeenCalledWith({
			url: "https://example.com/image1.jpg",
			method: "GET",
		});

		// Verify writeBinary was called correctly
		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenCalledWith(
			"/test/location/media/image1.jpg",
			mockArrayBuffer
		);
		expectAttachmentMetrics(result, { downloaded: 1, skippedIdentical: 0 });
		expect(result.fileNames).toEqual(["image1.jpg"]);
	});

	it("adds an image extension inferred from the downloaded bytes", async () => {
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
		(requestUrl as jest.Mock).mockResolvedValueOnce({ arrayBuffer: pngBytes });

		const result = await processAttachments(
			mockPlugin.app,
			["https://example.com/keep/media/note/blob"],
			"/test/location",
			["Embedded_image0"]
		);

		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenCalledWith(
			"/test/location/media/Embedded_image0.png",
			pngBytes
		);
		expect(result.fileNames).toEqual(["Embedded_image0.png"]);
	});

	it("adds the inferred extension when an extension-like note title suffix is present", async () => {
		const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
		(requestUrl as jest.Mock).mockResolvedValueOnce({ arrayBuffer: jpegBytes });

		const result = await processAttachments(
			mockPlugin.app,
			["https://example.com/keep/media/note/blob"],
			"/test/location",
			["Release_v2.0_0"]
		);

		expect(result.fileNames).toEqual(["Release_v2.0_0.jpg"]);
	});

	it("should successfully process multiple attachments", async () => {
		// Mock successful blob responses
		const mockArrayBuffer1 = new ArrayBuffer(8);
		const mockArrayBuffer2 = new ArrayBuffer(8);

		(requestUrl as jest.Mock)
			.mockResolvedValueOnce({ arrayBuffer: mockArrayBuffer1 })
			.mockResolvedValueOnce({ arrayBuffer: mockArrayBuffer2 });

		const blobUrls = ["https://example.com/image1.jpg", "https://example.com/image2.png"];
		const saveLocation = "/test/location";

		const result = await processAttachments(mockPlugin.app, blobUrls, saveLocation);

		// Verify requestUrl was called correctly for both files
		expect(requestUrl).toHaveBeenCalledTimes(2);
		expect(requestUrl).toHaveBeenNthCalledWith(1, {
			url: "https://example.com/image1.jpg",
			method: "GET",
		});
		expect(requestUrl).toHaveBeenNthCalledWith(2, {
			url: "https://example.com/image2.png",
			method: "GET",
		});

		// Verify writeBinary was called correctly for both files
		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenCalledTimes(2);
		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenNthCalledWith(
			1,
			"/test/location/media/image1.jpg",
			mockArrayBuffer1
		);
		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenNthCalledWith(
			2,
			"/test/location/media/image2.png",
			mockArrayBuffer2
		);
		expectAttachmentMetrics(result, { downloaded: 2, skippedIdentical: 0 });
	});

	it("should handle empty blob URLs array", async () => {
		const result = await processAttachments(mockPlugin.app, [], "/test/location");

		// Verify no calls were made
		expect(requestUrl).not.toHaveBeenCalled();
		expect(mockPlugin.app.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expectAttachmentMetrics(result, { downloaded: 0, skippedIdentical: 0 });
	});

	it("should fail after exhausting retries for transient attachment fetch errors", async () => {
		jest.useFakeTimers();
		// Mock failed request
		(requestUrl as jest.Mock)
			.mockRejectedValueOnce(new Error("Network error"))
			.mockRejectedValueOnce(new Error("Network error"))
			.mockRejectedValueOnce(new Error("Network error"));

		const blobUrls = ["https://example.com/image1.jpg"];
		const saveLocation = "/test/location";

		const promise = processAttachments(mockPlugin.app, blobUrls, saveLocation);
		const rejectionExpectation = expect(promise).rejects.toThrow(
			"Failed to download blob from https://example.com/image1.jpg."
		);

		await jest.runOnlyPendingTimersAsync();
		await jest.runOnlyPendingTimersAsync();

		await rejectionExpectation;

		// Verify requestUrl was called but writeBinary wasn't
		expect(requestUrl).toHaveBeenCalledTimes(3);
		expect(mockPlugin.app.vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	it("should retry transient attachment fetch failures and eventually succeed", async () => {
		jest.useFakeTimers();
		const mockArrayBuffer = new ArrayBuffer(8);
		(requestUrl as jest.Mock)
			.mockRejectedValueOnce(new NetworkError("Temporary upstream failure", 503))
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce({
				arrayBuffer: mockArrayBuffer,
			});

		const promise = processAttachments(mockPlugin.app, ["https://example.com/image1.jpg"], "/test/location");

		await jest.runOnlyPendingTimersAsync();
		await jest.runOnlyPendingTimersAsync();

		const result = await promise;

		expect(requestUrl).toHaveBeenCalledTimes(3);
		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenCalledWith(
			"/test/location/media/image1.jpg",
			mockArrayBuffer
		);
		expectAttachmentMetrics(result, { downloaded: 1, skippedIdentical: 0 });
	});

	it("should fail fast for non-retryable attachment fetch errors", async () => {
		(requestUrl as jest.Mock).mockRejectedValueOnce(new NetworkError("Google Keep attachment not found", 404));

		await expect(
			processAttachments(mockPlugin.app, ["https://example.com/image1.jpg"], "/test/location")
		).rejects.toThrow("Failed to download blob from https://example.com/image1.jpg.");

		expect(requestUrl).toHaveBeenCalledTimes(1);
		expect(mockPlugin.app.vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	it("should handle file write failure", async () => {
		// Mock successful request but failed write
		const mockArrayBuffer = new ArrayBuffer(8);
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			arrayBuffer: mockArrayBuffer,
		});
		jest.spyOn(mockPlugin.app.vault.adapter, "writeBinary").mockRejectedValueOnce(new Error("Write error"));

		const blobUrls = ["https://example.com/image1.jpg"];
		const saveLocation = "/test/location";

		await expect(processAttachments(mockPlugin.app, blobUrls, saveLocation)).rejects.toThrow(
			"Failed to download blob from https://example.com/image1.jpg."
		);

		// Verify both functions were called
		expect(requestUrl).toHaveBeenCalledTimes(1);
		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
	});

	it("should handle invalid blob URLs", async () => {
		const blobUrls = ["invalid-url-no-filename"];
		const saveLocation = "/test/location";

		const result = await processAttachments(mockPlugin.app, blobUrls, saveLocation);

		// Verify requestUrl was never called since URL validation fails first
		expect(requestUrl).not.toHaveBeenCalled();
		expect(mockPlugin.app.vault.adapter.writeBinary).not.toHaveBeenCalled();

		// Verify that console.error was called with the invalid URL message
		expect(console.error).toHaveBeenCalledWith("Invalid URL format: invalid-url-no-filename");
		expectAttachmentMetrics(result, { downloaded: 0, skippedIdentical: 0 });
	});

	it("should skip writing when an identical attachment already exists", async () => {
		const mockArrayBuffer = new ArrayBuffer(8);
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			arrayBuffer: mockArrayBuffer,
		});
		(mockPlugin.app.vault.adapter.exists as jest.Mock).mockResolvedValueOnce(true);
		(mockPlugin.app.vault.adapter.readBinary as jest.Mock).mockResolvedValueOnce(mockArrayBuffer);

		const blobUrls = ["https://example.com/image1.jpg"];
		const saveLocation = "/test/location";

		const result = await processAttachments(mockPlugin.app, blobUrls, saveLocation);

		expect(mockPlugin.app.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expectAttachmentMetrics(result, { downloaded: 0, skippedIdentical: 1 });
	});

	it("should resolve relative blob URLs using the server base", async () => {
		const mockArrayBuffer = new ArrayBuffer(8);
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			arrayBuffer: mockArrayBuffer,
		});

		const blobUrls = ["/files/image1.jpg"];
		const saveLocation = "/test/location";

		const result = await processAttachments(mockPlugin.app, blobUrls, saveLocation);

		expect(requestUrl).toHaveBeenCalledWith({
			url: "http://localhost:8080/files/image1.jpg",
			method: "GET",
		});
		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenCalledWith(
			"/test/location/media/image1.jpg",
			mockArrayBuffer
		);
		expectAttachmentMetrics(result, { downloaded: 1, skippedIdentical: 0 });
	});

	it("should send Keep auth headers for local media proxy URLs", async () => {
		const mockArrayBuffer = new ArrayBuffer(8);
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			arrayBuffer: mockArrayBuffer,
		});

		await processAttachments(mockPlugin.app, ["/keep/media/note-1/blob-2"], "/test/location", undefined, {
			email: "test@example.com",
			token: "test-token",
		});

		expect(requestUrl).toHaveBeenCalledWith({
			url: "http://localhost:8080/keep/media/note-1/blob-2",
			method: "GET",
			headers: {
				"X-User-Email": "test@example.com",
				Authorization: "Bearer test-token",
			},
		});
	});

	it("should prefer blob_names when available", async () => {
		const mockArrayBuffer = new ArrayBuffer(8);
		(requestUrl as jest.Mock).mockResolvedValueOnce({
			arrayBuffer: mockArrayBuffer,
		});

		const blobUrls = ["https://example.com/download?id=123"];
		const blobNames = ["folder/image 1.png"];
		const saveLocation = "/test/location";

		await processAttachments(mockPlugin.app, blobUrls, saveLocation, blobNames);

		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenCalledWith(
			"/test/location/media/folder_image 1.png",
			mockArrayBuffer
		);
	});

	it("should overwrite when existing attachment differs", async () => {
		const mockArrayBuffer = new ArrayBuffer(8);
		const existingBuffer = new ArrayBuffer(8);
		const existingView = new Uint8Array(existingBuffer);
		existingView[0] = 1;

		(requestUrl as jest.Mock).mockResolvedValueOnce({
			arrayBuffer: mockArrayBuffer,
		});
		(mockPlugin.app.vault.adapter.exists as jest.Mock).mockResolvedValueOnce(true);
		(mockPlugin.app.vault.adapter.readBinary as jest.Mock).mockResolvedValueOnce(existingBuffer);

		const blobUrls = ["https://example.com/image1.jpg"];
		const saveLocation = "/test/location";

		const result = await processAttachments(mockPlugin.app, blobUrls, saveLocation);

		expect(mockPlugin.app.vault.adapter.writeBinary).toHaveBeenCalledWith(
			"/test/location/media/image1.jpg",
			mockArrayBuffer
		);
		expectAttachmentMetrics(result, { downloaded: 1, skippedIdentical: 0 });
	});
});
