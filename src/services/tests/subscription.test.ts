import { SubscriptionService } from "../subscription";
import { SubscriptionInfo, SubscriptionCache } from "../../types/subscription";
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { httpGetJson } from "../http";
import { NetworkError } from "../errors";

// Service tests isolate the HTTP boundary; accessV1Wiring exercises the real credential conversion.
jest.mock("obsidian", () => ({ Notice: jest.fn() }));
jest.mock("../http", () => ({ httpGetJson: jest.fn() }));
jest.mock("@integrations/google/accessV1Auth", () => ({ ACCESS_V1_ENABLED: true }));
const requestJsonMock = httpGetJson as jest.MockedFunction<
	(url: string, headers?: Record<string, string>) => Promise<SubscriptionInfo>
>;
const buildResponse = (json: unknown): SubscriptionInfo => json as SubscriptionInfo;

global.console.error = jest.fn();

describe("SubscriptionService", () => {
	let service: SubscriptionService;
	let mockGetEmail: jest.MockedFunction<() => string>;
	let mockGetCache: jest.MockedFunction<() => SubscriptionCache | undefined>;
	let mockSetCache: jest.MockedFunction<(cache: SubscriptionCache) => Promise<void>>;
	let mockGetSupporterKey: jest.MockedFunction<() => string | null>;
	let mockGetSupporterKeyIdentity: jest.MockedFunction<() => string | undefined>;
	let mockGetToken: jest.MockedFunction<() => string>;
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

		mockGetToken = jest.fn<() => string>().mockReturnValue("synthetic-master");

		// Create service instance
		service = new SubscriptionService(
			mockGetEmail,
			mockGetCache,
			mockSetCache,
			mockGetSupporterKey,
			mockGetSupporterKeyIdentity,
			mockClearCache,
			mockGetToken
		);

		// Reset requestUrl mock
		requestJsonMock.mockReset();
	});

	describe("checkSubscription", () => {
		it("should return null if no email is provided", async () => {
			mockGetEmail.mockReturnValue("");
			const result = await service.checkSubscription();
			expect(result).toBeNull();
			expect(requestJsonMock).not.toHaveBeenCalled();
		});

		it("should use cached data if available and not expired", async () => {
			const cachedInfo: SubscriptionCache = {
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 1000, // 1 second ago
				email: mockEmail,
				identity: `verified-email-v1:${mockEmail}`,
			};
			mockGetCache.mockReturnValue(cachedInfo);

			const result = await service.checkSubscription();
			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestJsonMock).not.toHaveBeenCalled();
		});

		it("should fetch new data if cache is expired", async () => {
			const cachedInfo: SubscriptionCache = {
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
				email: mockEmail,
				identity: `verified-email-v1:${mockEmail}`,
			};
			mockGetCache.mockReturnValue(cachedInfo);

			const mockResponse = buildResponse(mockSubscriptionInfo);
			requestJsonMock.mockResolvedValueOnce(mockResponse);

			const result = await service.checkSubscription();
			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestJsonMock).toHaveBeenCalledTimes(1);
			expect(mockSetCache).toHaveBeenCalled();
		});

		it("authenticates the email-based request when no supporter key is configured", async () => {
			requestJsonMock.mockResolvedValueOnce(buildResponse(mockSubscriptionInfo));

			await service.checkSubscription();

			expect(requestJsonMock).toHaveBeenCalledWith(expect.stringContaining("/subscriber/info"), {
				"X-User-Email": mockEmail,
				Authorization: "Bearer synthetic-master",
			});
			expect(mockSetCache).toHaveBeenCalledWith(
				expect.objectContaining({
					email: mockEmail,
					identity: `verified-email-v1:${mockEmail}`,
				})
			);
		});

		it("uses a supporter key without falling back to email and caches by opaque identity", async () => {
			mockGetEmail.mockReturnValue("");
			mockGetSupporterKey.mockReturnValue("ABCD-EFGH-IJKL-MN12");
			mockGetSupporterKeyIdentity.mockReturnValue("opaque-key-id");
			requestJsonMock.mockResolvedValueOnce(buildResponse(mockSubscriptionInfo));

			const result = await service.checkSubscription();

			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestJsonMock).toHaveBeenCalledWith(expect.stringContaining("/subscriber/info"), {
				"X-Supporter-Key": "ABCD-EFGH-IJKL-MN12",
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
				identity: `verified-email-v1:${mockEmail}`,
			});
			requestJsonMock.mockResolvedValueOnce(buildResponse(mockSubscriptionInfo));

			await service.checkSubscription();

			expect(requestJsonMock).toHaveBeenCalledTimes(1);
			expect(requestJsonMock.mock.calls[0]?.[1]).toEqual({
				"X-Supporter-Key": "ABCD-EFGH-IJKL-MN12",
			});
		});

		it("fails closed when a configured supporter key cannot be read", async () => {
			mockGetSupporterKey.mockReturnValue("");
			mockGetSupporterKeyIdentity.mockReturnValue("unreadable-key-id");

			const result = await service.checkSubscription();

			expect(result).toBeNull();
			expect(requestJsonMock).not.toHaveBeenCalled();
			expect(mockSetCache).not.toHaveBeenCalled();
		});

		it("discards an in-flight result after the supporter identity changes", async () => {
			let currentKey: string | null = "ABCD-EFGH-IJKL-MN12";
			let currentIdentity = "first-key-id";
			mockGetSupporterKey.mockImplementation(() => currentKey);
			mockGetSupporterKeyIdentity.mockImplementation(() => currentIdentity);
			let resolveResponse: ((response: SubscriptionInfo) => void) | undefined;
			requestJsonMock.mockImplementationOnce(
				() =>
					new Promise<SubscriptionInfo>((resolve) => {
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
			requestJsonMock.mockRejectedValueOnce(new NetworkError("Invalid supporter key", 403));

			const result = await service.checkSubscription(true);

			expect(result).toBeNull();
			expect(mockClearCache).toHaveBeenCalledTimes(1);
			expect(mockSetCache).not.toHaveBeenCalled();
		});

		it("forces both plugin and server cache refresh", async () => {
			requestJsonMock.mockResolvedValueOnce(buildResponse(mockSubscriptionInfo));

			await service.checkSubscription(true);

			expect(requestJsonMock).toHaveBeenCalledWith(
				expect.stringContaining("/keep/subscriber/info?refresh=true"),
				expect.objectContaining({ Authorization: "Bearer synthetic-master" })
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
			requestJsonMock.mockResolvedValueOnce(mockResponse);

			const result = await service.checkSubscription();
			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestJsonMock).toHaveBeenCalledTimes(1);
			expect(mockSetCache).toHaveBeenCalled();
		});

		it("should force refresh when forceRefresh is true", async () => {
			const cachedInfo: SubscriptionCache = {
				info: mockSubscriptionInfo,
				timestamp: Date.now() - 1000, // 1 second ago
				email: mockEmail,
				identity: `verified-email-v1:${mockEmail}`,
			};
			mockGetCache.mockReturnValue(cachedInfo);

			// Create a proper Response mock
			const mockResponse = buildResponse(mockSubscriptionInfo);
			requestJsonMock.mockResolvedValueOnce(mockResponse);

			const result = await service.checkSubscription(true);
			expect(result).toEqual(mockSubscriptionInfo);
			expect(requestJsonMock).toHaveBeenCalledTimes(1);
			expect(mockSetCache).toHaveBeenCalled();
		});

		it("should handle API errors gracefully", async () => {
			// Create a proper error Response mock
			requestJsonMock.mockRejectedValueOnce(new NetworkError("API error", 400));

			const result = await service.checkSubscription();
			expect(result).toBeNull();
			expect(console.error).toHaveBeenCalled();
			expect(mockSetCache).not.toHaveBeenCalled();
		});

		it("should handle network errors gracefully", async () => {
			requestJsonMock.mockRejectedValueOnce(new Error("Network error"));

			const result = await service.checkSubscription();
			expect(result).toBeNull();
			expect(console.error).toHaveBeenCalled();
			expect(mockSetCache).not.toHaveBeenCalled();
		});
	});

	describe("verified identity boundary", () => {
		it.each([undefined, "email:test@example.com"])("refreshes pre-fix email cache %s", async (identity) => {
			mockGetCache.mockReturnValue({ info: mockSubscriptionInfo, timestamp: Date.now(), email: mockEmail, identity });
			requestJsonMock.mockResolvedValueOnce(mockSubscriptionInfo);
			await service.checkSubscription();
			expect(requestJsonMock).toHaveBeenCalledTimes(1);
		});
		it("does not make a request or reuse cache without a Google credential", async () => {
			mockGetToken.mockReturnValue("");
			mockGetCache.mockReturnValue({
				info: mockSubscriptionInfo,
				timestamp: Date.now(),
				identity: `verified-email-v1:${mockEmail}`,
			});
			expect(await service.checkSubscription()).toBeNull();
			expect(requestJsonMock).not.toHaveBeenCalled();
			expect(mockClearCache).toHaveBeenCalled();
		});
		it.each([-1000, NaN])("refreshes invalid cache age %s", async (age) => {
			mockGetCache.mockReturnValue({
				info: mockSubscriptionInfo,
				timestamp: Date.now() - age,
				identity: `verified-email-v1:${mockEmail}`,
			});
			requestJsonMock.mockResolvedValueOnce(mockSubscriptionInfo);
			await service.checkSubscription();
			expect(requestJsonMock).toHaveBeenCalledTimes(1);
		});
		it.each([401, 403, 500])("clears email cache after failed refresh %s", async (status) => {
			requestJsonMock.mockRejectedValueOnce(new NetworkError("synthetic failure", status));
			expect(await service.checkSubscription(true)).toBeNull();
			expect(mockClearCache).toHaveBeenCalled();
			expect(mockSetCache).not.toHaveBeenCalled();
		});
		it.each(["email", "token"])("discards in-flight status when %s changes", async (field) => {
			let finish!: (value: SubscriptionInfo) => void;
			requestJsonMock.mockReturnValueOnce(
				new Promise((resolve) => {
					finish = resolve;
				})
			);
			const pending = service.checkSubscription();
			if (field === "email") mockGetEmail.mockReturnValue("other@example.invalid");
			else mockGetToken.mockReturnValue("replacement-master");
			finish(mockSubscriptionInfo);
			expect(await pending).toBeNull();
			expect(mockSetCache).not.toHaveBeenCalled();
		});
		it("does not prime verified-email cache from an arbitrary caller result", async () => {
			await service.primeCurrentCache(mockSubscriptionInfo);
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
