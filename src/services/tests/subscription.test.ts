import { SubscriptionService } from "../subscription";
import { SubscriptionInfo, SubscriptionCache } from "../../types/subscription";
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import * as obsidian from "obsidian";
import type { RequestUrlResponse } from "obsidian";

// Mock Obsidian requestUrl + Notice
jest.mock("obsidian", () => ({
	Notice: class {
		constructor(public message: string) {}
	},
	requestUrl: jest.fn(),
}));

type RequestUrlMock = jest.MockedFunction<(params: unknown) => Promise<RequestUrlResponse>>;
const requestUrlMock = obsidian.requestUrl as unknown as RequestUrlMock;

const buildResponse = (json: unknown, status = 200): RequestUrlResponse => ({
	status,
	headers: {},
	arrayBuffer: new ArrayBuffer(0),
	json,
	text: JSON.stringify(json),
});

global.console.error = jest.fn();

describe("SubscriptionService", () => {
	let service: SubscriptionService;
	let mockGetEmail: jest.MockedFunction<() => string>;
	let mockGetCache: jest.MockedFunction<() => SubscriptionCache | undefined>;
	let mockSetCache: jest.MockedFunction<(cache: SubscriptionCache) => Promise<void>>;
	let mockGetSupporterKey: jest.MockedFunction<() => string | null>;
	let mockGetSupporterKeyIdentity: jest.MockedFunction<() => string | undefined>;
	let mockClearCache: jest.MockedFunction<() => Promise<void>>;

	const mockEmail = "test@example.com";
	const mockSubscriptionInfo: SubscriptionInfo = {
		subscription_status: "active",
		plan_details: {
			plan_id: "premium",
			features: ["feature1", "feature2"],
		},
		metering_info: {
			usage: 50,
			limit: 100,
		},
		trial_or_promo: null,
	};

	beforeEach(() => {
		// Reset all mocks
		jest.clearAllMocks();
		// Start of Selection

		// Setup mock functions with proper types
		mockGetEmail = jest.fn<() => string>().mockReturnValue(mockEmail);
		mockGetCache = jest.fn<() => SubscriptionCache | undefined>().mockReturnValue(undefined);
		mockSetCache = jest.fn<(cache: SubscriptionCache) => Promise<void>>().mockResolvedValue();
		mockGetSupporterKey = jest.fn<() => string | null>().mockReturnValue(null);
		mockGetSupporterKeyIdentity = jest.fn<() => string | undefined>().mockReturnValue(undefined);
		mockClearCache = jest.fn<() => Promise<void>>().mockResolvedValue();

		// Create service instance
		service = new SubscriptionService(
			mockGetEmail,
			mockGetCache,
			mockSetCache,
			mockGetSupporterKey,
			mockGetSupporterKeyIdentity,
			mockClearCache
		);

		// Reset requestUrl mock
		requestUrlMock.mockReset();
	});

	describe("checkSubscription", () => {
		it("should return null if no email is provided", async () => {
			mockGetEmail.mockReturnValue("");
			const result = await service.checkSubscription();
			expect(result).toBeNull();
			expect(requestUrlMock).not.toHaveBeenCalled();
		});

		it("should use cached data if available and not expired", async () => {
			const cachedInfo: SubscriptionCache = {
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 1000, // 1 second ago
				email: mockEmail,
			};
			mockGetCache.mockReturnValue(cachedInfo);

			const result = await service.checkSubscription();
			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestUrlMock).not.toHaveBeenCalled();
		});

		it("should fetch new data if cache is expired", async () => {
			const cachedInfo: SubscriptionCache = {
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
				email: mockEmail,
			};
			mockGetCache.mockReturnValue(cachedInfo);

			const mockResponse = buildResponse(mockSubscriptionInfo);
			requestUrlMock.mockResolvedValueOnce(mockResponse);

			const result = await service.checkSubscription();
			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestUrlMock).toHaveBeenCalledTimes(1);
			expect(mockSetCache).toHaveBeenCalled();
		});

		it("keeps the existing email-based request when no supporter key is configured", async () => {
			requestUrlMock.mockResolvedValueOnce(buildResponse(mockSubscriptionInfo));

			await service.checkSubscription();

			expect(requestUrlMock).toHaveBeenCalledWith({
				url: expect.stringContaining("/subscriber/info"),
				method: "GET",
				headers: { "X-User-Email": mockEmail },
			});
			expect(mockSetCache).toHaveBeenCalledWith(
				expect.objectContaining({
					email: mockEmail,
					identity: `email:${mockEmail}`,
				})
			);
		});

		it("uses a supporter key without falling back to email and caches by opaque identity", async () => {
			mockGetEmail.mockReturnValue("");
			mockGetSupporterKey.mockReturnValue("ABCD-EFGH-IJKL-MN12");
			mockGetSupporterKeyIdentity.mockReturnValue("opaque-key-id");
			requestUrlMock.mockResolvedValueOnce(buildResponse(mockSubscriptionInfo));

			const result = await service.checkSubscription();

			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestUrlMock).toHaveBeenCalledWith({
				url: expect.stringContaining("/subscriber/info"),
				method: "GET",
				headers: { "X-Supporter-Key": "ABCD-EFGH-IJKL-MN12" },
				throw: false,
			});
			expect(mockSetCache).toHaveBeenCalledWith(
				expect.objectContaining({
					identity: "supporter-key:opaque-key-id",
				})
			);
			const cached = mockSetCache.mock.calls[0]?.[0];
			expect(JSON.stringify(cached)).not.toContain("ABCD-EFGH-IJKL-MN12");
			expect(cached).not.toHaveProperty("email");
		});

		it("does not reuse an email cache after a supporter key is configured", async () => {
			mockGetSupporterKey.mockReturnValue("ABCD-EFGH-IJKL-MN12");
			mockGetSupporterKeyIdentity.mockReturnValue("new-key-id");
			mockGetCache.mockReturnValue({
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 1000,
				email: mockEmail,
				identity: `email:${mockEmail}`,
			});
			requestUrlMock.mockResolvedValueOnce(buildResponse(mockSubscriptionInfo));

			await service.checkSubscription();

			expect(requestUrlMock).toHaveBeenCalledTimes(1);
			expect((requestUrlMock.mock.calls[0]?.[0] as { headers: Record<string, string> }).headers).toEqual({
				"X-Supporter-Key": "ABCD-EFGH-IJKL-MN12",
			});
		});

		it("fails closed when a configured supporter key cannot be read", async () => {
			mockGetSupporterKey.mockReturnValue("");
			mockGetSupporterKeyIdentity.mockReturnValue("unreadable-key-id");

			const result = await service.checkSubscription();

			expect(result).toBeNull();
			expect(requestUrlMock).not.toHaveBeenCalled();
			expect(mockSetCache).not.toHaveBeenCalled();
		});

		it("discards an in-flight result after the supporter identity changes", async () => {
			let currentKey: string | null = "ABCD-EFGH-IJKL-MN12";
			let currentIdentity = "first-key-id";
			mockGetSupporterKey.mockImplementation(() => currentKey);
			mockGetSupporterKeyIdentity.mockImplementation(() => currentIdentity);
			let resolveResponse: ((response: RequestUrlResponse) => void) | undefined;
			requestUrlMock.mockImplementationOnce(
				() =>
					new Promise<RequestUrlResponse>((resolve) => {
						resolveResponse = resolve;
					})
			);

			const pending = service.checkSubscription(true);
			currentKey = "WXYZ-9876-QRST-5432";
			currentIdentity = "second-key-id";
			resolveResponse?.(buildResponse(mockSubscriptionInfo));

			await expect(pending).resolves.toBeNull();
			expect(mockSetCache).not.toHaveBeenCalled();
		});

		it("clears cached supporter status when a forced key check is rejected", async () => {
			mockGetSupporterKey.mockReturnValue("ABCD-EFGH-IJKL-MN12");
			mockGetSupporterKeyIdentity.mockReturnValue("key-id");
			mockGetCache.mockReturnValue({
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 1000,
				identity: "supporter-key:key-id",
			});
			requestUrlMock.mockResolvedValueOnce(buildResponse({ error: "Invalid supporter key" }, 403));

			const result = await service.checkSubscription(true);

			expect(result).toBeNull();
			expect(mockClearCache).toHaveBeenCalledTimes(1);
			expect(mockSetCache).not.toHaveBeenCalled();
		});

		it("forces both plugin and server cache refresh", async () => {
			requestUrlMock.mockResolvedValueOnce(buildResponse(mockSubscriptionInfo));

			await service.checkSubscription(true);

			expect(requestUrlMock).toHaveBeenCalledWith(
				expect.objectContaining({
					url: expect.stringContaining("/subscriber/info?refresh=true"),
				})
			);
		});

		it("should fetch new data if email changed", async () => {
			const cachedInfo: SubscriptionCache = {
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 1000, // 1 second ago
				email: "old@example.com",
			};
			mockGetCache.mockReturnValue(cachedInfo);

			// Create a proper Response mock
			const mockResponse = buildResponse(mockSubscriptionInfo);
			requestUrlMock.mockResolvedValueOnce(mockResponse);

			const result = await service.checkSubscription();
			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestUrlMock).toHaveBeenCalledTimes(1);
			expect(mockSetCache).toHaveBeenCalled();
		});

		it("should force refresh when forceRefresh is true", async () => {
			const cachedInfo: SubscriptionCache = {
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 1000, // 1 second ago
				email: mockEmail,
			};
			mockGetCache.mockReturnValue(cachedInfo);

			// Create a proper Response mock
			const mockResponse = buildResponse(mockSubscriptionInfo);
			requestUrlMock.mockResolvedValueOnce(mockResponse);

			const result = await service.checkSubscription(true);
			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestUrlMock).toHaveBeenCalledTimes(1);
			expect(mockSetCache).toHaveBeenCalled();
		});

		it("should handle API errors gracefully", async () => {
			// Create a proper error Response mock
			const mockResponse = buildResponse({ error: "API Error" }, 400);
			requestUrlMock.mockResolvedValueOnce(mockResponse);

			const result = await service.checkSubscription();
			expect(result).toBeNull();
			expect(console.error).toHaveBeenCalled();
			expect(mockSetCache).not.toHaveBeenCalled();
		});

		it("should handle network errors gracefully", async () => {
			requestUrlMock.mockRejectedValueOnce(new Error("Network error"));

			const result = await service.checkSubscription();
			expect(result).toBeNull();
			expect(console.error).toHaveBeenCalled();
			expect(mockSetCache).not.toHaveBeenCalled();
		});
	});

	describe("isSubscriptionActive", () => {
		it("should return true for active subscription", async () => {
			// Mock checkSubscription to return active subscription
			jest.spyOn(service, "checkSubscription").mockResolvedValue(mockSubscriptionInfo);

			const result = await service.isSubscriptionActive();
			expect(result).toBe(true);
		});

		it("should return false for inactive subscription", async () => {
			const inactiveInfo: SubscriptionInfo = {
				...mockSubscriptionInfo,
				subscription_status: "inactive",
			};
			jest.spyOn(service, "checkSubscription").mockResolvedValue(inactiveInfo);

			const result = await service.isSubscriptionActive();
			expect(result).toBe(false);
		});

		it("should return false for expired subscription", async () => {
			const expiredInfo: SubscriptionInfo = {
				...mockSubscriptionInfo,
				subscription_status: "expired",
			};
			jest.spyOn(service, "checkSubscription").mockResolvedValue(expiredInfo);

			const result = await service.isSubscriptionActive();
			expect(result).toBe(false);
		});

		it("should return false for null subscription info", async () => {
			jest.spyOn(service, "checkSubscription").mockResolvedValue(null);

			const result = await service.isSubscriptionActive();
			expect(result).toBe(false);
		});

		it("should pass forceRefresh parameter to checkSubscription", async () => {
			const checkSubscriptionSpy = jest.spyOn(service, "checkSubscription").mockResolvedValue(mockSubscriptionInfo);

			await service.isSubscriptionActive(true);
			expect(checkSubscriptionSpy).toHaveBeenCalledWith(true);
		});
	});
});
