// Offline tests of bundled production paths. No socket/network implementation is exposed.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { builtinModules } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = (enabled) =>
	buildSync({
		stdin: {
			contents: `export * from './integrations/google/accessV1Transport';
export * from './integrations/google/accessV1MobileTransport';
export * from './integrations/google/keepTokenExchange';
export * from './services/http'; export * from './services/errors';`,
			resolveDir: root + "src",
			loader: "ts",
		},
		absWorkingDir: root,
		bundle: true,
		write: false,
		format: "cjs",
		target: "es2018",
		external: ["obsidian", ...builtinModules],
		define: {
			"process.env.KEEPSIDIAN_ACCESS_V1": enabled ? "undefined" : '"false"',
			"process.env.KEEPSIDIAN_SERVER_URL": '"https://backend.example.invalid"',
		},
	}).outputFiles[0].text;
const code = bundle(true);
const disabledCode = bundle(false);
const GOOGLE = "https://android.clients.google.com/auth";
const BACKEND = "https://backend.example.invalid/keep/access-v1/sync/v2";
function response(url, text = "ok", status = 200, headers = {}) {
	const result = new Response(text, { status, headers });
	Object.defineProperties(result, { url: { value: url }, type: { value: "cors" } });
	return result;
}
function runtime(handler, overrides = {}, { enabled = true, nativeReply } = {}) {
	const requests = [],
		loads = [],
		native = [];
	const context = {
		module: { exports: {} },
		URL,
		URLSearchParams,
		Uint8Array,
		Request,
		Response,
		AbortController,
		TextEncoder,
		TextDecoder,
		setTimeout,
		clearTimeout,
		fetch: async (request) => {
			requests.push(request.clone());
			return handler(request);
		},
		require: (id) => {
			if (id === "obsidian")
				return {
					Platform: { isDesktopApp: false, isMobileApp: true },
					Notice: class {},
					requestUrl: (request) => {
						native.push(request);
						if (nativeReply) return nativeReply(request);
						throw Error("denied");
					},
				};
			loads.push(id);
			throw Error("Node denied");
		},
		...overrides,
	};
	runInNewContext(enabled ? code : disabledCode, context);
	return { api: context.module.exports, requests, loads, native };
}
const body = "Token=synthetic-browser&service=ac2dm";
test("mobile uses browser UA and exact request policy; no Node/native path", async () => {
	const r = runtime((req) => response(req.url, "Token=synthetic-master"));
	assert.equal(await r.api.googleAuthRequest(body), "Token=synthetic-master");
	assert.equal(r.requests.length, 1);
	const req = r.requests[0];
	assert.equal(req.url, GOOGLE);
	assert.equal(await req.text(), body);
	for (const [key, value] of Object.entries({
		redirect: "error",
		mode: "cors",
		credentials: "omit",
		cache: "no-store",
		referrerPolicy: "no-referrer",
	}))
		assert.equal(req[key], value);
	assert.equal(req.headers.get("user-agent"), null);
	assert.equal(req.headers.get("content-type"), "application/x-www-form-urlencoded");
	assert.deepEqual(r.loads, []);
	assert.deepEqual(r.native, []);
});
test("default mobile registration and backend routing separate all credential lifecycles", async () => {
	const r = runtime(async (req) => {
		if (req.url.endsWith("/capabilities"))
			return response(req.url, JSON.stringify({ auth_protocol: "access-v1", enabled: true }));
		if (req.url === GOOGLE) {
			const form = new URLSearchParams(await req.text());
			return response(
				req.url,
				form.has("Token")
					? "Token=synthetic-master"
					: `Auth=synthetic-access\nExpiry=${Math.floor(Date.now() / 1000) + 3600}`
			);
		}
		return response(req.url, '{"notes":[]}');
	});
	const saved = [];
	const plugin = {
		settings: { email: "synthetic@example.invalid", token: "" },
		async saveSettings() {
			saved.push({ ...this.settings });
		},
	};
	await r.api.exchangeOauthToken({ display() {} }, plugin, "synthetic-browser");
	await r.api.httpGetJson("https://backend.example.invalid/keep/sync/v2", {
		"X-User-Email": plugin.settings.email,
		Authorization: "Bearer " + plugin.settings.token,
	});
	assert.equal(r.requests.length, 4);
	assert.equal(saved[0].token, "synthetic-master");
	assert.equal(r.requests[0].headers.get("authorization"), null);
	assert.equal(r.requests[3].url, BACKEND);
	assert.equal(r.requests[3].headers.get("authorization"), "Bearer synthetic-access");
	assert.equal(r.requests[3].headers.get("x-keep-auth-protocol"), "access-v1");
	const accessForm = new URLSearchParams(await r.requests[2].clone().text());
	assert.equal(accessForm.get("EncryptedPasswd"), "synthetic-master");
	assert.equal(
		accessForm.get("service"),
		"oauth2:https://www.googleapis.com/auth/memento https://www.googleapis.com/auth/reminders https://www.googleapis.com/auth/userinfo.email"
	);
	assert.deepEqual(r.loads, []);
	assert.deepEqual(r.native, []);
});
test("simple POST reached destination then CORS blocked: unknown outcome, never retry/fallback", async () => {
	let delivered = 0;
	const r = runtime(() => {
		delivered++;
		throw Error("synthetic-secret CORS");
	});
	await assert.rejects(r.api.googleAuthRequest(body), (e) => {
		assert.doesNotMatch(String(e), /synthetic-secret/);
		return true;
	});
	assert.equal(delivered, 1);
	assert.equal(r.requests.length, 1);
	assert.deepEqual(r.native, []);
});
for (const status of [301, 302, 303, 307, 308])
	test(`redirect ${status} rejected without second request`, async () => {
		const r = runtime((req) => response(req.url, "redirect", status, { location: "https://other.example.invalid" }));
		await assert.rejects(r.api.googleAuthRequest(body));
		assert.equal(r.requests.length, 1);
		assert.deepEqual(r.native, []);
	});
for (const kind of ["opaque", "opaqueredirect", "redirected", "wrong-url"])
	test(`reject ${kind}`, async () => {
		const r = runtime((req) => {
			const res = new Response("x");
			Object.defineProperties(res, {
				url: { value: kind === "wrong-url" ? "https://other.example.invalid" : req.url },
				type: { value: kind.startsWith("opaque") ? kind : "cors" },
				redirected: { value: kind === "redirected" },
			});
			return res;
		});
		await assert.rejects(r.api.googleAuthRequest(body));
		assert.equal(r.requests.length, 1);
	});
for (const kind of ["oversize", "bad-length", "invalid-utf8", "stream-error", "headers"])
	test(`bounded response ${kind}`, async () => {
		const r = runtime((req) => {
			if (kind === "stream-error")
				return response(
					req.url,
					new ReadableStream({
						start(c) {
							c.error(Error("synthetic-secret"));
						},
					})
				);
			return response(
				req.url,
				kind === "oversize" ? new Uint8Array(16385) : kind === "invalid-utf8" ? new Uint8Array([255]) : "x",
				200,
				kind === "bad-length"
					? { "content-length": "invalid" }
					: kind === "headers"
						? { "x-large": "x".repeat(8193) }
						: {}
			);
		});
		await assert.rejects(r.api.googleAuthRequest(body), (e) => {
			assert.doesNotMatch(String(e), /synthetic-secret/);
			return true;
		});
		assert.equal(r.requests.length, 1);
	});
test("oversized streamed chunk cancels reader and aborts; no hard pre-delivery memory claim", async () => {
	let cancelled = 0;
	const r = runtime((req) =>
		response(
			req.url,
			new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(16385));
				},
				cancel() {
					cancelled++;
				},
			})
		)
	);
	await assert.rejects(r.api.googleAuthRequest(body));
	assert.equal(cancelled, 1);
	assert.equal(r.requests[0].signal.aborted, true);
});
test("deadline aborts one unknown-outcome request", async () => {
	const r = runtime(
		(req) =>
			new Promise((_resolve, reject) => req.signal.addEventListener("abort", () => reject(Error("synthetic-secret"))))
	);
	await assert.rejects(r.api.mobileAccessRequest(new URL(GOOGLE), "POST", {}, body, 16384, 32768, 5));
	assert.equal(r.requests.length, 1);
	assert.equal(r.requests[0].signal.aborted, true);
});
test("Google deadline aborts a stalled reader after headers and one chunk, with cancellation and no replay", async () => {
	let timeout,
		delay,
		reads = 0,
		cancelled = 0;
	let markStalled;
	const stalled = new Promise((resolve) => {
		markStalled = resolve;
	});
	const r = runtime(
		(req) => {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("Auth=partial"));
					req.signal.addEventListener("abort", () => controller.error(new Error("synthetic-secret abort")));
				},
			});
			const reader = stream.getReader();
			const res = response(req.url);
			Object.defineProperty(res, "body", {
				value: {
					getReader: () => ({
						read() {
							if (++reads === 2) markStalled();
							return reader.read();
						},
						cancel() {
							cancelled++;
							return reader.cancel();
						},
					}),
				},
			});
			return res;
		},
		{
			setTimeout(callback, ms) {
				timeout = callback;
				delay = ms;
				return 1;
			},
			clearTimeout() {},
		}
	);
	const pending = r.api.googleAuthRequest(body);
	const rejected = assert.rejects(pending, (error) => {
		assert.equal(error.message, "Google authentication failed; it was not retried.");
		assert.equal(error.cause, undefined);
		return true;
	});
	await stalled;
	assert.equal(delay, 30000);
	assert.equal(reads, 2);
	timeout();
	await rejected;
	assert.equal(cancelled, 1);
	assert.equal(r.requests.length, 1);
	assert.equal(r.requests[0].signal.aborted, true);
	assert.deepEqual(r.native, []);
	assert.deepEqual(r.loads, []);
});
test("explicit false on mobile selects legacy native routing without Google Fetch", async () => {
	const r = runtime(
		() => {
			throw new Error("Fetch must not run");
		},
		{},
		{
			enabled: false,
			nativeReply: async () => ({ status: 200, json: { notes: [] }, text: '{"notes":[]}', headers: {} }),
		}
	);
	await r.api.httpGetJson("https://backend.example.invalid/keep/sync/v2", {
		Authorization: "Bearer synthetic-legacy-master",
		"X-User-Email": "synthetic@example.invalid",
	});
	assert.equal(r.native.length, 1);
	assert.equal(r.native[0].url, "https://backend.example.invalid/keep/sync/v2");
	assert.equal(r.native[0].headers.Authorization, "Bearer synthetic-legacy-master");
	assert.equal(r.requests.length, 0);
	assert.deepEqual(r.loads, []);
});
for (const key of ["fetch", "Request", "Response", "AbortController", "TextEncoder", "TextDecoder"])
	test(`missing ${key} refuses before transmission`, async () => {
		const r = runtime(
			() => {
				throw Error("must not send");
			},
			{ [key]: undefined }
		);
		await assert.rejects(r.api.googleAuthRequest(body));
		assert.equal(r.requests.length, 0);
		assert.deepEqual(r.loads, []);
	});
test("runtime ignoring redirect mode refuses before transmission", async () => {
	class BrokenRequest extends Request {
		constructor(...args) {
			super(...args);
			Object.defineProperty(this, "redirect", { value: "follow" });
		}
	}
	const r = runtime(() => {}, { Request: BrokenRequest });
	await assert.rejects(r.api.googleAuthRequest(body));
	assert.equal(r.requests.length, 0);
});
for (const url of [
	"http://backend.example.invalid/keep/access-v1/sync/v2",
	"https://other.example.invalid/keep/access-v1/sync/v2",
	"https://android.clients.google.com/other",
])
	test(`refuses destination ${url}`, async () => {
		const r = runtime(() => {});
		await assert.rejects(r.api.mobileAccessRequest(new URL(url), "POST", {}, body, 16384, 32768));
		assert.equal(r.requests.length, 0);
	});
test("rejects oversized request and control headers before send", async () => {
	const r = runtime(() => {});
	await assert.rejects(r.api.googleAuthRequest("Token=" + "x".repeat(32768)));
	await assert.rejects(r.api.accessBackendRequest(BACKEND, "POST", { "X-Bad": "secret\r\nX: secret" }, "{}"));
	assert.equal(r.requests.length, 0);
});
for (const status of [409, 410, 413, 429])
	test(`typed ${status} with safe code and no retry`, async () => {
		const r = runtime((req) =>
			response(req.url, '{"code":"sync_operation_held","error":"synthetic-secret"}', status, { "retry-after": "120" })
		);
		await assert.rejects(r.api.accessBackendRequest(BACKEND, "GET", {}), (e) => {
			assert.ok(e instanceof r.api.AccessV1RequestError);
			assert.equal(e.status, status);
			assert.equal(e.code, "sync_operation_held");
			assert.equal(e.retryAllowed, false);
			assert.equal(e.retryAfterMs, 60000);
			assert.doesNotMatch(JSON.stringify(e), /synthetic-secret/);
			return true;
		});
		assert.equal(r.requests.length, 1);
		assert.deepEqual(r.native, []);
	});
test("binary success remains bytes, text is strict UTF8", async () => {
	const r = runtime((req) => response(req.url, new Uint8Array([255])));
	const result = await r.api.accessBackendRequest(BACKEND, "GET", {});
	assert.equal(result.bytes[0], 255);
	assert.throws(() => result.text);
});
