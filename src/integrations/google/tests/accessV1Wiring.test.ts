jest.mock("obsidian", () => ({
	...jest.requireActual("obsidian"),
	requestUrl: jest.fn(),
	Platform: { isDesktopApp: true },
}));
jest.mock("../accessV1Transport", () => ({
	...jest.requireActual("../accessV1Transport"),
	googleAuthRequest: jest.fn(),
	accessBackendRequest: jest.fn(),
}));
import type KeepSidianPlugin from "main";
import { webcrypto } from "crypto";
import type { KeepSidianSettingsTab } from "@ui/settings/KeepSidianSettingsTab";

const EMAIL = "synthetic@example.invalid",
	MASTER = "synthetic-master-secret",
	ACCESS = "synthetic-access-secret",
	BROWSER = "oauth2_4synthetic-browser";
const NOW = 1800000000000;
let transport: typeof import("../accessV1Transport");
let native: typeof import("obsidian");
let api: typeof import("../../server/keepApi");
let http: typeof import("@services/http");
const reply = (value: unknown) => ({ status: 200, bytes: new Uint8Array([1, 2]), text: JSON.stringify(value) });
const headers = () => ({ Authorization: `Bearer ${MASTER}`, "X-User-Email": EMAIL });
const googleResponse = () => `Auth=${ACCESS}\r\nExpiry=${NOW / 1000 + 10139}\r\n`;

beforeEach(() => {
	jest.resetModules();
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	delete process.env.KEEPSIDIAN_ACCESS_V1;
	process.env.KEEPSIDIAN_SERVER_URL = "https://backend.example.invalid";
	jest.spyOn(Date, "now").mockReturnValue(NOW);
	transport = require("../accessV1Transport") as typeof transport;
	native = require("obsidian") as typeof native;
	api = require("../../server/keepApi") as typeof api;
	http = require("@services/http") as typeof http;
	jest.mocked(transport.googleAuthRequest).mockResolvedValue(googleResponse());
	jest.mocked(transport.accessBackendRequest).mockImplementation(async (url) => {
		if (url.endsWith("/access-v1/capabilities")) return reply({ auth_protocol: "access-v1", enabled: true });
		if (url.endsWith("/enrich/local/capabilities"))
			return reply({ version: 1, epoch: "a".repeat(32), issued_at_ms: NOW });
		if (url.endsWith("/sync/capabilities"))
			return reply({ auth_protocol: "access-v1", replay_version: 1, replay_epoch: "e" });
		if (url.includes("/sync/")) return reply({ notes: [] });
		return reply({ results: [] });
	});
});
afterEach(() => {
	jest.restoreAllMocks();
	delete process.env.KEEPSIDIAN_ACCESS_V1;
	delete process.env.KEEPSIDIAN_SERVER_URL;
});

it("registers on Google locally with the existing ac2dm fields; stores only the local master", async () => {
	jest
		.mocked(transport.googleAuthRequest)
		.mockResolvedValue(`Auth=unused\r\nToken=${MASTER}\r\nEmail=${EMAIL}\r\nRopText= \r\n`);
	const plugin = { settings: { email: EMAIL, token: "" }, saveSettings: jest.fn() };
	const tab = { display: jest.fn() };
	const { exchangeOauthToken } = require("../keepTokenExchange") as typeof import("../keepTokenExchange");
	await exchangeOauthToken(tab as unknown as KeepSidianSettingsTab, plugin as unknown as KeepSidianPlugin, BROWSER);
	const fields = Object.fromEntries(new URLSearchParams(jest.mocked(transport.googleAuthRequest).mock.calls[0][0]));
	expect(fields).toEqual({
		accountType: "HOSTED_OR_GOOGLE",
		Email: EMAIL,
		has_permission: "1",
		source: "android",
		androidId: "Keep-To-Obsidian Android Id",
		device_country: "us",
		operatorCountry: "us",
		lang: "en",
		sdk_version: "17",
		google_play_services_version: "240913000",
		client_sig: "38918a453d07199354f8b19af05ec6562ced5788",
		add_account: "1",
		ACCESS_TOKEN: "1",
		Token: BROWSER,
		service: "ac2dm",
		callerSig: "38918a453d07199354f8b19af05ec6562ced5788",
		droidguard_results: "dummy123",
	});
	expect(plugin.settings.token).toBe(MASTER);
	expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	expect(native.requestUrl).not.toHaveBeenCalled();
	expect(transport.accessBackendRequest).toHaveBeenCalledTimes(1);
	expect(jest.mocked(transport.accessBackendRequest).mock.calls[0][2]).toEqual({});
});

it("routes actual fetch, upload review, push, enrichment and preparation with access-only headers", async () => {
	await api.fetchNotes(EMAIL, MASTER);
	await api.fetchNotesWithPremiumFeatures(
		EMAIL,
		MASTER,
		{},
		0,
		100,
		undefined,
		undefined,
		"supporter",
		undefined,
		true
	);
	await api.pushNotes(EMAIL, MASTER, []);
	await api.getReplayEpoch(EMAIL, MASTER);
	await api.prepareLocalEnrichment(EMAIL, MASTER);
	await expect(api.enrichLocalNotes(EMAIL, MASTER, [], undefined, "synthetic-operation")).resolves.toBeDefined();
	expect(transport.googleAuthRequest).toHaveBeenCalledTimes(1);
	const fields = new URLSearchParams(jest.mocked(transport.googleAuthRequest).mock.calls[0][0]);
	expect(fields.get("EncryptedPasswd")).toBe(MASTER);
	expect(fields.get("service")).toBe(
		"oauth2:https://www.googleapis.com/auth/memento https://www.googleapis.com/auth/reminders https://www.googleapis.com/auth/userinfo.email"
	);
	for (const [url, , outgoing, body] of jest.mocked(transport.accessBackendRequest).mock.calls.slice(1)) {
		expect(url).toContain("/keep/access-v1/");
		expect(outgoing).toMatchObject({
			Authorization: `Bearer ${ACCESS}`,
			"X-User-Email": EMAIL,
			"X-Keep-Auth-Protocol": "access-v1",
		});
		expect(JSON.stringify([outgoing, body])).not.toContain(MASTER);
		expect(JSON.stringify([outgoing, body])).not.toContain(BROWSER);
	}
	expect(native.requestUrl).not.toHaveBeenCalled();
});

it.each(["deletions/v1", "trash/preview/v1", "trash/v1", "media/note/blob"])(
	"covers central endpoint %s",
	async (suffix) => {
		const url = `https://backend.example.invalid/keep/${suffix}`;
		if (suffix.startsWith("media/")) await http.httpGetArrayBuffer(url, headers());
		else
			await http.httpRequest(url, {
				method: suffix.startsWith("trash") ? "POST" : "GET",
				headers: headers(),
				body: { notes: [] },
			});
		expect(jest.mocked(transport.accessBackendRequest).mock.calls[1][0]).toBe(
			url.replace("/keep/", "/keep/access-v1/")
		);
		expect(jest.mocked(transport.accessBackendRequest).mock.calls[1][2].Authorization).toBe(`Bearer ${ACCESS}`);
	}
);

it("accepts versioned server media URLs without a duplicate prefix", async () => {
	const url = "https://backend.example.invalid/keep/access-v1/media/note/blob";
	await http.httpGetArrayBuffer(url, headers());
	expect(jest.mocked(transport.accessBackendRequest).mock.calls[1][0]).toBe(url);
	expect(jest.mocked(transport.accessBackendRequest).mock.calls[1][2].Authorization).toBe(`Bearer ${ACCESS}`);
});

it.each(["", "secret\r\nInjected: value"])("rejects missing/invalid credentials before Google", async (master) => {
	await expect(api.fetchNotes(EMAIL, master)).rejects.toThrow();
	expect(transport.googleAuthRequest).not.toHaveBeenCalled();
	expect(native.requestUrl).not.toHaveBeenCalled();
});

it.each([
	"https://evil.invalid/keep/sync/v2",
	"https://backend.example.invalid.evil.invalid/keep/media/n/b",
	"https://backend.example.invalid/keep/unknown",
	"https://backend.example.invalid/register",
])("blocks unsupported destination %s without fallback", async (url) => {
	await expect(http.httpGetJson(url, headers())).rejects.toThrow();
	expect(transport.googleAuthRequest).not.toHaveBeenCalled();
	expect(transport.accessBackendRequest).not.toHaveBeenCalled();
	expect(native.requestUrl).not.toHaveBeenCalled();
});

it.each([
	`Token=${MASTER}\n`,
	`Auth=${ACCESS}\nAuth=other\nExpiry=1800001000`,
	`Auth=${ACCESS}\nExpiry=1800000000`,
	`Auth=${ACCESS}\nExpiry=1800100000`,
	`Auth=${ACCESS}\nExpiry=not-a-number`,
	`Auth=${MASTER}\nExpiry=1800001000`,
	`Auth=${ACCESS}\nExpiry=1800001000\nError=BadAuthentication`,
	"malformed",
	"x".repeat(16385),
])("fails malformed Google response without backend admission", async (body) => {
	jest.mocked(transport.googleAuthRequest).mockResolvedValue(body);
	await expect(api.fetchNotes(EMAIL, MASTER)).rejects.toThrow("Short-lived request failed");
	expect(transport.accessBackendRequest).toHaveBeenCalledTimes(1); // public capability only
	expect(native.requestUrl).not.toHaveBeenCalled();
});

it("capability rejection prevents any Google secret transmission", async () => {
	jest.mocked(transport.accessBackendRequest).mockResolvedValue(reply({ enabled: false }));
	await expect(api.fetchNotes(EMAIL, MASTER)).rejects.toThrow();
	expect(transport.googleAuthRequest).not.toHaveBeenCalled();
	expect(native.requestUrl).not.toHaveBeenCalled();
});

it("preserves sanitized public capability status without sending a Google credential", async () => {
	const { AccessV1RequestError } = require("@services/errors") as typeof import("@services/errors");
	const failure = new AccessV1RequestError(503, "access_configuration_unavailable");
	jest.mocked(transport.accessBackendRequest).mockRejectedValue(failure);
	await expect(api.fetchNotes(EMAIL, MASTER)).rejects.toBe(failure);
	expect(transport.googleAuthRequest).not.toHaveBeenCalled();
	expect(native.requestUrl).not.toHaveBeenCalled();
});

it.each([
	[410, "sync_session_expired"],
	[409, "sync_operation_held"],
	[409, "enrichment_replay_held"],
	[413, "sync_snapshot_too_large"],
	[429, "sync_capacity"],
	[503, "access_validation_unavailable"],
])(
	"preserves status %s through JSON and binary callers without retrying writes or attachments",
	async (status, code) => {
		await api.fetchNotes(EMAIL, MASTER); // complete capability/auth preparation
		const { AccessV1RequestError, NetworkError } = require("@services/errors") as typeof import("@services/errors");
		const failure = new AccessV1RequestError(Number(status), code, 7000);
		jest.mocked(transport.accessBackendRequest).mockRejectedValue(failure);
		const { retryDownload, isTransientDownloadError } =
			require("@features/keep/download-retry") as typeof import("@features/keep/download-retry");
		const before = jest.mocked(transport.accessBackendRequest).mock.calls.length;
		const onRetry = jest.fn();
		await expect(
			retryDownload(() => api.pushNotes(EMAIL, MASTER, []), { checkCancelled: () => {}, onRetry })
		).rejects.toBe(failure);
		expect(failure).toBeInstanceOf(NetworkError);
		expect(isTransientDownloadError(failure)).toBe(false);
		expect(onRetry).not.toHaveBeenCalled();
		expect(jest.mocked(transport.accessBackendRequest).mock.calls.length - before).toBe(1);
		await expect(
			http.httpGetArrayBuffer("https://backend.example.invalid/keep/access-v1/media/n/b", headers())
		).rejects.toBe(failure);
		const { processAttachments } =
			require("@features/keep/io/attachments") as typeof import("@features/keep/io/attachments");
		const adapter = { writeBinary: jest.fn(), exists: jest.fn().mockResolvedValue(false) };
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		jest.spyOn(console, "error").mockImplementation(() => {});
		const attachmentBefore = jest.mocked(transport.accessBackendRequest).mock.calls.length;
		const result = await processAttachments(
			{ vault: { adapter } },
			["https://backend.example.invalid/keep/access-v1/media/n/b"],
			"media-test",
			["image.jpg"],
			{ email: EMAIL, token: MASTER }
		);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].status).toBe(status);
		expect(adapter.writeBinary).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(jest.mocked(transport.accessBackendRequest).mock.calls.length - attachmentBefore).toBe(1);
		expect(transport.googleAuthRequest).toHaveBeenCalledTimes(1);
	}
);

it("refreshes before a new outbound attempt; never retries paid/unknown outcomes", async () => {
	await api.fetchNotes(EMAIL, MASTER);
	jest.spyOn(Date, "now").mockReturnValue(NOW + 10100 * 1000);
	jest.mocked(transport.googleAuthRequest).mockResolvedValue(`Auth=synthetic-refreshed\nExpiry=${NOW / 1000 + 20000}`);
	jest.mocked(transport.accessBackendRequest).mockRejectedValue(new Error(`${MASTER} ${ACCESS}`));
	const { retryDownload, isTransientDownloadError } =
		require("@features/keep/download-retry") as typeof import("@features/keep/download-retry");
	const before = jest.mocked(transport.accessBackendRequest).mock.calls.length;
	const onRetry = jest.fn();
	await expect(
		retryDownload(() => api.pushNotes(EMAIL, MASTER, []), { checkCancelled: () => {}, onRetry })
	).rejects.toThrow("Short-lived request failed");
	expect(transport.googleAuthRequest).toHaveBeenCalledTimes(2);
	expect(jest.mocked(transport.accessBackendRequest).mock.calls.length - before).toBe(1);
	expect(onRetry).not.toHaveBeenCalled();
	try {
		await api.enrichLocalNotes(EMAIL, MASTER, [], undefined, "prepared");
	} catch (error) {
		expect(isTransientDownloadError(error)).toBe(false);
		expect(String(error)).not.toContain(MASTER);
		expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
	}
});

it("mobile without required Fetch primitives fails before any request", async () => {
	Object.defineProperty(native.Platform, "isDesktopApp", { value: false });
	Object.defineProperty(native.Platform, "isMobileApp", { value: true });
	await expect(api.fetchNotes(EMAIL, MASTER)).rejects.toThrow("requires supported mobile Fetch");
	expect(transport.googleAuthRequest).not.toHaveBeenCalled();
	expect(transport.accessBackendRequest).not.toHaveBeenCalled();
	expect(native.requestUrl).not.toHaveBeenCalled();
});

it("explicit false re-enables master-token backend authentication", async () => {
	jest.resetModules();
	process.env.KEEPSIDIAN_ACCESS_V1 = "false";
	const disabledTransport = require("../accessV1Transport") as typeof transport;
	const disabledNative = require("obsidian") as typeof native;
	const legacy = require("../../server/keepApi") as typeof api;
	expect(disabledTransport.googleAuthRequest).not.toHaveBeenCalled();
	jest
		.mocked(disabledNative.requestUrl)
		.mockResolvedValue({ status: 200, json: { notes: [] }, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) });
	await legacy.fetchNotes(EMAIL, MASTER);
	expect(disabledNative.requestUrl).toHaveBeenCalledWith(
		expect.objectContaining({
			url: expect.stringContaining("/keep/sync/v2"),
			headers: expect.objectContaining({ Authorization: `Bearer ${MASTER}` }),
		})
	);
	expect(disabledTransport.googleAuthRequest).not.toHaveBeenCalled();
	expect(disabledTransport.accessBackendRequest).not.toHaveBeenCalled();
});

it.each(["not-json", "null", "{}", '{"auth_protocol":"access-v1","enabled":"true"}'])(
	"malformed capability %s blocks Google and legacy transport",
	async (text) => {
		jest.mocked(transport.accessBackendRequest).mockResolvedValue({ ...reply({}), text });
		await expect(api.fetchNotes(EMAIL, MASTER)).rejects.toThrow();
		expect(transport.accessBackendRequest).toHaveBeenCalledTimes(1);
		expect(jest.mocked(transport.accessBackendRequest).mock.calls[0][2]).toEqual({});
		expect(transport.googleAuthRequest).not.toHaveBeenCalled();
		expect(native.requestUrl).not.toHaveBeenCalled();
	}
);

it("404 capability blocks registration without Google or legacy fallback", async () => {
	const { AccessV1RequestError } = require("@services/errors") as typeof import("@services/errors");
	jest.mocked(transport.accessBackendRequest).mockRejectedValue(new AccessV1RequestError(404));
	const { exchangeOauthToken } = require("../keepTokenExchange") as typeof import("../keepTokenExchange");
	const plugin = { settings: { email: EMAIL, token: "" }, saveSettings: jest.fn() };
	await expect(
		exchangeOauthToken(
			{ display: jest.fn() } as unknown as KeepSidianSettingsTab,
			plugin as unknown as KeepSidianPlugin,
			BROWSER
		)
	).rejects.toThrow("Local registration failed");
	expect(plugin.saveSettings).not.toHaveBeenCalled();
	expect(transport.googleAuthRequest).not.toHaveBeenCalled();
	expect(native.requestUrl).not.toHaveBeenCalled();
});
