// Actual bundled Google/auth/backend modules; synthetic native bridge only, no sockets or app operations.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { builtinModules } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const code = buildSync({
	stdin: {
		contents: `export * from './integrations/google/accessV1Transport';
export * from './integrations/google/accessV1Auth';
export * from './integrations/google/keepTokenExchange';
export * from './services/http';`,
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
		"process.env.KEEPSIDIAN_ACCESS_V1": "undefined",
		"process.env.KEEPSIDIAN_SERVER_URL": '"https://backend.example.invalid"',
	},
}).outputFiles[0].text;
const GOOGLE = "https://android.clients.google.com/auth";
const BODY = "Token=synthetic-browser&service=ac2dm&Email=synthetic%40example.invalid&encoded=one%2Btwo+three%25";
const reply = (data = "Token=synthetic-master") => ({
	status: 200,
	url: GOOGLE,
	data,
	headers: { "content-type": "text/plain" },
});
function fixture({ mutate = () => {}, nativeReply = () => reply() } = {}) {
	const calls = [],
		fetches = [],
		legacy = [],
		modules = [],
		logs = [],
		timers = [];
	const helper = {
		async request(options) {
			assert.equal(this, helper);
			calls.push(options);
			return nativeReply(options, cap, context);
		},
	};
	const cap = {
		isLoggingEnabled: false,
		getPlatform: () => "android",
		isPluginAvailable: (name) => name === "CapacitorHttp",
		Plugins: { CapacitorHttp: helper },
	};
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
		Capacitor: cap,
		setTimeout(...args) {
			timers.push(args[1]);
			return setTimeout(...args);
		},
		clearTimeout,
		console: Object.fromEntries(
			["log", "warn", "error", "debug", "info"].map((name) => [name, (...args) => logs.push(args)])
		),
		require(id) {
			if (id === "obsidian")
				return {
					Platform: { isMobileApp: true, isAndroidApp: true, isDesktopApp: false },
					Notice: class {},
					requestUrl(...args) {
						legacy.push(args);
						throw Error("native legacy denied");
					},
				};
			modules.push(id);
			throw Error("Node denied");
		},
		async fetch(req) {
			fetches.push(req.clone());
			assert.equal(new URL(req.url).origin, "https://backend.example.invalid", "Google must not use browser Fetch");
			const data = req.url.endsWith("/capabilities") ? { auth_protocol: "access-v1", enabled: true } : { notes: [] };
			const response = new Response(JSON.stringify(data));
			Object.defineProperties(response, { url: { value: req.url }, type: { value: "cors" } });
			return response;
		},
	};
	mutate(cap, context);
	runInNewContext(code, context);
	return { api: context.module.exports, calls, fetches, legacy, modules, logs, timers, cap };
}
async function safeFailure(r, input = BODY) {
	await assert.rejects(r.api.googleAuthRequest(input), (error) => {
		assert.equal(error.message, "Google authentication failed; it was not retried.");
		assert.equal(error.cause, undefined);
		assert.doesNotMatch(JSON.stringify(error), /synthetic-secret/);
		return true;
	});
	assert.deepEqual(r.fetches, []);
	assert.deepEqual(r.legacy, []);
	assert.deepEqual(r.modules, []);
	assert.deepEqual(r.logs, []);
}
test("Android auth fixes endpoint, form/text, headers, redirect flag and native inactivity timeouts", async () => {
	const r = fixture();
	assert.equal(await r.api.googleAuthRequest(BODY), "Token=synthetic-master");
	assert.deepEqual(JSON.parse(JSON.stringify(r.calls)), [
		{
			url: GOOGLE,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "GoogleAuth/1.4" },
			data: BODY,
			responseType: "text",
			disableRedirects: true,
			connectTimeout: 30000,
			readTimeout: 30000,
		},
	]);
	assert.deepEqual(r.fetches, []);
	assert.deepEqual(r.legacy, []);
	assert.deepEqual(r.modules, []);
	assert.deepEqual(r.logs, []);
	assert.deepEqual(r.timers, []); // No invented total cancellation wrapper.
});
const hostCases = {
	absent: (_cap, c) => {
		c.Capacitor = undefined;
	},
	"logging true": (cap) => {
		cap.isLoggingEnabled = true;
	},
	"logging missing": (cap) => {
		delete cap.isLoggingEnabled;
	},
	"logging string": (cap) => {
		cap.isLoggingEnabled = "false";
	},
	"logging inherited": (cap) => {
		delete cap.isLoggingEnabled;
		Object.setPrototypeOf(cap, { isLoggingEnabled: false });
	},
	"wrong platform": (cap) => {
		cap.getPlatform = () => "ios";
	},
	"missing platform API": (cap) => {
		delete cap.getPlatform;
	},
	"unavailable plugin": (cap) => {
		cap.isPluginAvailable = () => false;
	},
	"truthy nonboolean availability": (cap) => {
		cap.isPluginAvailable = () => "true";
	},
	"missing availability API": (cap) => {
		delete cap.isPluginAvailable;
	},
	"missing helper": (cap) => {
		delete cap.Plugins.CapacitorHttp;
	},
	"missing request": (cap) => {
		delete cap.Plugins.CapacitorHttp.request;
	},
	"throwing host getter": (cap) => {
		cap.getPlatform = () => {
			throw Error("synthetic-secret");
		};
	},
};
for (const [name, mutate] of Object.entries(hostCases))
	test(`${name} rejects before native credential transmission`, async () => {
		const r = fixture({ mutate });
		await safeFailure(r);
		assert.equal(r.calls.length, 0);
	});
test("known false logging state changing true rejects result, without claiming log prevention", async () => {
	const r = fixture({
		nativeReply(_options, cap) {
			cap.isLoggingEnabled = true;
			return reply();
		},
	});
	await safeFailure(r);
	assert.equal(r.calls.length, 1);
	assert.equal(r.cap.isLoggingEnabled, true);
});
test("capability check uses no invented host version property", async () => {
	const r = fixture();
	assert.equal("version" in r.cap, false);
	await r.api.googleAuthRequest(BODY);
	assert.equal(r.calls.length, 1);
});
test("replaced Capacitor object rejects even when the replacement passes capability checks", async () => {
	const r = fixture({
		nativeReply(_options, cap, context) {
			context.Capacitor = { ...cap };
			return reply();
		},
	});
	await safeFailure(r);
	assert.equal(r.calls.length, 1);
});
for (const status of [301, 302, 303, 307, 308, 400, 401, 429, 500])
	test(`native status ${status} is never retried or followed`, async () => {
		const r = fixture({
			nativeReply: () => ({ ...reply(), status, headers: { location: "https://other.example.invalid" } }),
		});
		await safeFailure(r);
		assert.equal(r.calls.length, 1);
	});
const badReplies = {
	"status below 200": () => ({ ...reply(), status: 199 }),
	"null response": () => null,
	"string response": () => "synthetic-secret",
	"array response": () => [reply()],
	"string status": () => ({ ...reply(), status: "200" }),
	"fractional status": () => ({ ...reply(), status: 200.5 }),
	"missing url": () => ({ status: 200, data: "Token=synthetic-secret" }),
	"other url": () => ({ ...reply(), url: "https://other.example.invalid/auth" }),
	"redirect query": () => ({ ...reply(), url: GOOGLE + "?next=1" }),
	"object data": () => ({ ...reply(), data: { Token: "synthetic-secret" } }),
	"oversized data": () => reply("x".repeat(16385)),
	"unicode data": () => reply("Token=\ufffd"),
	"control data": () => reply("Token=synthetic\0secret"),
	"empty data": () => reply(""),
	"oversized headers": () => ({ ...reply(), headers: { x: "x".repeat(8193) } }),
	"object header": () => ({ ...reply(), headers: { x: {} } }),
	"non-ASCII header name": () => ({ ...reply(), headers: { "x-\u00e9": "value" } }),
	"non-ASCII header value": () => ({ ...reply(), headers: { x: "\u00e9" } }),
	"null headers": () => ({ ...reply(), headers: null }),
	"string headers": () => ({ ...reply(), headers: "synthetic-secret" }),
	"array headers": () => ({ ...reply(), headers: [] }),
	"inherited response": () => Object.create(reply()),
};
for (const [name, nativeReply] of Object.entries(badReplies))
	test(`${name} fails post-response validation`, async () => {
		const r = fixture({ nativeReply });
		await safeFailure(r);
		assert.equal(r.calls.length, 1);
	});
for (const input of ["", "Token=x%", "Token=x\r\nsecret", "Token=" + "x".repeat(32768)])
	test("invalid request is rejected before helper", async () => {
		const r = fixture();
		await safeFailure(r, input);
		assert.equal(r.calls.length, 0);
	});
test("native rejection has unknown outcome, fixed error, exactly one attempt", async () => {
	const r = fixture({
		nativeReply: () => {
			throw Object.assign(Error("synthetic-secret"), { response: reply("synthetic-secret") });
		},
	});
	await safeFailure(r);
	assert.equal(r.calls.length, 1);
});
test("native registration/master exchange plus backend Fetch preserve credential separation", async () => {
	const r = fixture({
		nativeReply: (options) =>
			reply(
				new URLSearchParams(options.data).has("Token")
					? "Token=synthetic-master"
					: `Auth=synthetic-access\nExpiry=${Math.floor(Date.now() / 1000) + 3600}`
			),
	});
	const saves = [];
	const plugin = {
		settings: { email: "synthetic@example.invalid", token: "" },
		async saveSettings() {
			saves.push({ ...this.settings });
		},
	};
	await r.api.exchangeOauthToken({ display() {} }, plugin, "synthetic-browser");
	await r.api.httpGetJson("https://backend.example.invalid/keep/sync/v2", {
		Authorization: `Bearer ${plugin.settings.token}`,
		"X-User-Email": plugin.settings.email,
	});
	assert.equal(r.calls.length, 2);
	assert.equal(r.fetches.length, 2);
	assert.equal(saves[0].token, "synthetic-master");
	const registration = new URLSearchParams(r.calls[0].data),
		access = new URLSearchParams(r.calls[1].data);
	assert.equal(registration.get("Token"), "synthetic-browser");
	assert.equal(registration.get("service"), "ac2dm");
	assert.equal(access.get("EncryptedPasswd"), "synthetic-master");
	assert.equal(access.get("app"), "com.google.android.keep");
	assert.equal(access.get("client_sig"), "38918a453d07199354f8b19af05ec6562ced5788");
	assert.equal(access.get("androidId"), "Keep-To-Obsidian Android Id");
	assert.equal(
		access.get("service"),
		"oauth2:https://www.googleapis.com/auth/memento https://www.googleapis.com/auth/reminders https://www.googleapis.com/auth/userinfo.email"
	);
	assert.equal(r.fetches[0].headers.get("authorization"), null);
	assert.equal(r.fetches[1].headers.get("authorization"), "Bearer synthetic-access");
	assert.equal(r.fetches[1].url, "https://backend.example.invalid/keep/access-v1/sync/v2");
	assert.doesNotMatch(JSON.stringify(saves), /synthetic-access|synthetic-browser/);
	assert.deepEqual(r.logs, []);
	assert.deepEqual(r.legacy, []);
});
test("backend browser transport does not require native Google helper", async () => {
	const r = fixture({
		mutate: (_cap, c) => {
			c.Capacitor = undefined;
		},
	});
	await r.api.accessBackendRequest("https://backend.example.invalid/keep/access-v1/sync/v2", "GET", {});
	assert.equal(r.fetches.length, 1);
	assert.equal(r.calls.length, 0);
});
