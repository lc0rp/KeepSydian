/** No sockets: intercept the actual Node HTTPS boundary and drive its lifecycle. */
jest.mock("obsidian", () => ({ Platform: { isDesktopApp: true } }));
jest.mock("../../../../src/config/index", () => ({ KEEPSIDIAN_SERVER_URL: "https://backend.example.invalid" }));
jest.mock("https", () => ({ Agent: jest.fn(), request: jest.fn() }));
jest.mock("tls", () => ({ checkServerIdentity: jest.fn() }));
import { EventEmitter } from "events";
import * as https from "https";
import * as tls from "tls";
import { Platform } from "obsidian";
import { googleAuthRequest, accessBackendRequest } from "../../../../src/integrations/google/accessV1Transport";

class Request extends EventEmitter {
	end = jest.fn();
	destroy = jest.fn();
}
class Response extends EventEmitter {
	statusCode = 200;
	complete = true;
	headers: Record<string, string> = {};
	destroy = jest.fn();
}
let request: Request, response: Response, agent: { destroy: jest.Mock };
let callback: (res: Response) => void;
beforeEach(() => {
	jest.clearAllMocks();
	Object.defineProperty(Platform, "isDesktopApp", { value: true, configurable: true });
	request = new Request();
	response = new Response();
	agent = { destroy: jest.fn() };
	jest.mocked(https.Agent).mockImplementation(() => agent as unknown as https.Agent);
	jest.mocked(https.request).mockImplementation(((options: unknown, cb: (res: Response) => void) => {
		callback = cb;
		return request;
	}) as unknown as typeof https.request);
	jest.mocked(tls.checkServerIdentity).mockReturnValue(undefined);
});
async function started(): Promise<void> {
	// Dynamic Node imports resolve asynchronously without starting any real transport.
	for (let i = 0; i < 12; i++) await Promise.resolve();
}
function authenticate(authorized = true): void {
	const socket = Object.assign(new EventEmitter(), { encrypted: true, authorized, getPeerCertificate: () => ({}) });
	request.emit("socket", socket);
	socket.emit("secureConnect");
}
function respond(body: Buffer = Buffer.from("Auth=synthetic\nExpiry=1800010000")): void {
	callback(response);
	response.emit("data", body);
	response.emit("end");
}

it("fixes Google endpoint, UA, TLS, own agent and sends no body before secureConnect", async () => {
	const pending = googleAuthRequest("Token=synthetic&service=ac2dm");
	await started();
	expect(https.request).toHaveBeenCalledTimes(1);
	expect(request.end).not.toHaveBeenCalled();
	expect(jest.mocked(https.request).mock.calls[0][0]).toMatchObject({
		protocol: "https:",
		hostname: "android.clients.google.com",
		port: 443,
		path: "/auth",
		method: "POST",
		servername: "android.clients.google.com",
		rejectUnauthorized: true,
		minVersion: "TLSv1.2",
		maxHeaderSize: 8192,
		headers: {
			"User-Agent": "GoogleAuth/1.4",
			"Content-Type": "application/x-www-form-urlencoded",
			"Accept-Encoding": "identity",
		},
	});
	expect(https.Agent).toHaveBeenCalledWith({
		keepAlive: false,
		maxCachedSessions: 0,
		rejectUnauthorized: true,
		proxyEnv: {},
	});
	authenticate();
	expect(request.end).toHaveBeenCalledWith("Token=synthetic&service=ac2dm");
	respond();
	await expect(pending).resolves.toContain("Auth=synthetic");
	expect(agent.destroy).toHaveBeenCalledTimes(1);
	expect(request.destroy).toHaveBeenCalledTimes(1);
});

it.each(["untrusted", "hostname"])("rejects %s before body", async (mode) => {
	const pending = googleAuthRequest("Token=synthetic");
	await started();
	if (mode === "hostname") jest.mocked(tls.checkServerIdentity).mockReturnValue(new Error("synthetic-secret"));
	authenticate(mode !== "untrusted");
	await expect(pending).rejects.toThrow("Google authentication failed");
	expect(request.end).not.toHaveBeenCalled();
	expect(https.request).toHaveBeenCalledTimes(1);
});

it.each(["redirect", "oversize", "aborted", "invalid-utf8", "error"])(
	"fails %s once with sanitized diagnostics",
	async (mode) => {
		const pending = googleAuthRequest("Token=synthetic-secret");
		await started();
		authenticate();
		if (mode === "redirect") {
			response.statusCode = 302;
			respond();
		}
		if (mode === "oversize") respond(Buffer.alloc(16385, "x"));
		if (mode === "aborted") {
			callback(response);
			response.emit("aborted");
		}
		if (mode === "invalid-utf8") respond(Buffer.from([0xc3, 0x28]));
		if (mode === "error") request.emit("error", new Error("synthetic-secret"));
		await expect(pending).rejects.toEqual(new Error("Google authentication failed; it was not retried."));
		expect(https.request).toHaveBeenCalledTimes(1);
		expect(agent.destroy).toHaveBeenCalledTimes(1);
	}
);

it("refuses HTTP or a foreign backend before opening any connection", async () => {
	await expect(accessBackendRequest("http://localhost:8080/keep/access-v1/capabilities", "GET", {})).rejects.toThrow();
	await expect(accessBackendRequest("https://evil.invalid/keep/access-v1/capabilities", "GET", {})).rejects.toThrow();
	expect(https.request).not.toHaveBeenCalled();
});

it("mobile never calls the Node request primitive", async () => {
	Object.defineProperty(Platform, "isDesktopApp", { value: false, configurable: true });
	await expect(googleAuthRequest("Token=synthetic")).rejects.toThrow();
	expect(https.request).not.toHaveBeenCalled();
});

it("total deadline includes the wait before a socket and consumes only one attempt", async () => {
	jest.useFakeTimers();
	try {
		const pending = googleAuthRequest("Token=synthetic");
		await started();
		jest.advanceTimersByTime(30_000);
		await expect(pending).rejects.toThrow("not retried");
		expect(https.request).toHaveBeenCalledTimes(1);
		expect(request.end).not.toHaveBeenCalled();
		expect(agent.destroy).toHaveBeenCalledTimes(1);
	} finally {
		jest.useRealTimers();
	}
});

it("does not impose the Google 30-second deadline on a 31-second backend mutation", async () => {
	jest.useFakeTimers();
	try {
		const pending = accessBackendRequest("https://backend.example.invalid/keep/access-v1/push", "POST", {}, "{}");
		const observed = pending.then(
			(value) => ({ ok: true, value }),
			() => ({ ok: false })
		);
		await started();
		authenticate();
		setTimeout(() => respond(Buffer.from('{"results":[]}')), 31_000);
		jest.advanceTimersByTime(31_000);
		await expect(observed).resolves.toMatchObject({ ok: true });
		expect(https.request).toHaveBeenCalledTimes(1);
		expect(request.end).toHaveBeenCalledTimes(1);
	} finally {
		jest.useRealTimers();
	}
});

it.each([
	[410, "sync_session_expired"],
	[409, "sync_operation_conflict"],
	[409, "sync_operation_held"],
	[409, "enrichment_replay_held"],
	[413, "sync_snapshot_too_large"],
	[429, "sync_capacity"],
])("preserves sanitized backend status %s and allowlisted code without retry permission", async (status, code) => {
	const pending = accessBackendRequest("https://backend.example.invalid/keep/access-v1/push", "POST", {}, "{}");
	await started();
	authenticate();
	response.statusCode = Number(status);
	response.headers["retry-after"] = "7";
	respond(Buffer.from(JSON.stringify({ code, error: "synthetic-secret-response-body" })));
	await expect(pending).rejects.toMatchObject({ status, code, retryAfterMs: 7000, retryAllowed: false });
	try {
		await pending;
	} catch (error) {
		expect(JSON.stringify(error)).not.toContain("synthetic-secret-response-body");
		expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
	}
	expect(https.request).toHaveBeenCalledTimes(1);
});

it.each(["unknown-code", "malformed", "oversized"])("retains only HTTP status for %s error bodies", async (mode) => {
	const pending = accessBackendRequest("https://backend.example.invalid/keep/access-v1/push", "POST", {}, "{}");
	await started();
	authenticate();
	response.statusCode = 409;
	const body =
		mode === "unknown-code"
			? '{"code":"synthetic-secret","error":"synthetic-secret"}'
			: mode === "malformed"
				? "synthetic-secret"
				: "x".repeat(16385);
	respond(Buffer.from(body));
	await expect(pending).rejects.toMatchObject({ status: 409, retryAllowed: false });
	try {
		await pending;
	} catch (error) {
		expect((error as { code?: string }).code).toBeUndefined();
		expect(JSON.stringify(error)).not.toContain("synthetic-secret");
		expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
	}
});

it.each([200,403])("classifies a truncated HTTP %s response without retaining its body",async status=>{
 const pending=accessBackendRequest("https://backend.example.invalid/keep/access-v1/sync/v2","GET",{});
 await started();authenticate();response.statusCode=status;response.complete=false;
 callback(response);response.emit("data",Buffer.from('{"partial":"synthetic-secret'));response.emit("aborted");
 await expect(pending).rejects.toMatchObject({transportFailure:status===200,responseRejected:false,retryAllowed:false});
 expect(request.end).toHaveBeenCalledTimes(1);
});
