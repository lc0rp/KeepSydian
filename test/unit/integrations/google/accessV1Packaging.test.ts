import { execFileSync } from "child_process";
import { builtinModules } from "module";
import { runInNewContext } from "vm";
import { EventEmitter } from "events";
import { TextDecoder } from "util";

type Api = typeof import("../../../../src/integrations/google/accessV1Transport") & typeof import("../../../../src/integrations/google/accessV1Auth");

function renderer(
	enabled: boolean | undefined = undefined,
	desktop = true,
	loader: "present" | "missing" | "throws" = "present"
) {
	// Match production CJS/es2018/external builtins; do not lower dynamic imports.
	const options = {
		stdin: {
			contents: 'export * from "./accessV1Transport"; export * from "./accessV1Auth";',
			resolveDir: process.cwd() + "/src/integrations/google",
			loader: "ts",
		},
		bundle: true,
		write: false,
		format: "cjs",
		target: "es2018",
		external: ["obsidian", ...builtinModules.flatMap((name) => [name, `node:${name}`])],
		define: {
			"process.env.KEEPSIDIAN_ACCESS_V1":
				enabled === undefined ? "undefined" : JSON.stringify(enabled ? "true" : "false"),
			"process.env.KEEPSIDIAN_SERVER_URL": JSON.stringify("https://backend.example.invalid"),
		},
	};
	// Build in Node because Jest's shared jsdom setup substitutes Uint8Array.
	const code = execFileSync(
		process.execPath,
		[
			"-e",
			'process.stdout.write(require("esbuild").buildSync(JSON.parse(process.argv[1])).outputFiles[0].text)',
			JSON.stringify(options),
		],
		{ encoding: "utf8" }
	);
	const loads: string[] = [];
	let requests = 0;
	const request = Object.assign(new EventEmitter(), { destroy: jest.fn(), end: jest.fn() });
	const response = Object.assign(new EventEmitter(), {
		statusCode: 200,
		complete: true,
		headers: {},
		destroy: jest.fn(),
	});
	let respond: (value: typeof response) => void = () => {
		throw new Error("No synthetic request");
	};
	const context: Record<string, unknown> = {
		module: { exports: {} },
		URL,
		Uint8Array,
		setTimeout,
		clearTimeout,
		require: (id: string) => {
			if (id === "obsidian") return { Platform: { isDesktopApp: desktop } };
			loads.push(id);
			if (loader === "throws") throw new Error("synthetic-secret-loader-detail");
			if (id === "https")
				return {
					Agent: class {
						destroy() {}
					},
					request: (_options: unknown, cb: typeof respond) => {
						requests++;
						respond = cb;
						return request;
					},
				};
			if (id === "tls") return { checkServerIdentity: () => undefined };
			if (id === "util") return { TextDecoder };
			if (id === "buffer") return { Buffer };
			throw new Error("Unexpected module");
		},
	};
	// No importModuleDynamically hook: reproduces the renderer packaging boundary.
	runInNewContext(code, context);
	if (loader === "missing") context.require = undefined;
	return {
		api: (context.module as { exports: Api }).exports,
		loads,
		request,
		requests: () => requests,
		complete: () => {
			const socket = Object.assign(new EventEmitter(), {
				encrypted: true,
				authorized: true,
				getPeerCertificate: () => ({}),
			});
			request.emit("socket", socket);
			socket.emit("secureConnect");
			respond(response);
			response.emit("data", Buffer.from("Auth=synthetic\nExpiry=1800010000"));
			response.emit("end");
		},
	};
}

it("loads Node lazily through renderer require and completes exactly one synthetic request", async () => {
	const runtime = renderer();
	expect(runtime.api.ACCESS_V1_ENABLED).toBe(true);
	expect(runtime.loads).toEqual([]);
	const pending = runtime.api.googleAuthRequest("Token=synthetic");
	const result = pending.catch(() => "failed");
	await Promise.resolve();
	expect(runtime.loads).toEqual(["https", "tls", "util", "buffer"]);
	expect(runtime.request.end).not.toHaveBeenCalled();
	runtime.complete();
	await expect(result).resolves.toContain("Auth=synthetic");
	expect(runtime.requests()).toBe(1);
});

it.each([
	[false, true],
	[true, false],
])("gate=%s desktop=%s stays inert", async (enabled, desktop) => {
	const runtime = renderer(enabled, desktop);
	await expect(runtime.api.exchangeBrowserLocally("synthetic@example.invalid", "synthetic-browser")).rejects.toThrow();
	expect(runtime.loads).toEqual([]);
	expect(runtime.requests()).toBe(0);
});

it.each(["missing", "throws"] as const)("sanitizes %s loader with no request or fallback", async (loader) => {
	const runtime = renderer(true, true, loader);
	const error = await runtime.api.googleAuthRequest("Token=synthetic").catch((value: unknown) => value);
	expect(error).toMatchObject({ message: "Google authentication failed; it was not retried." });
	expect(Object.keys(error as object)).toEqual([]);
	expect(String(error)).not.toContain("synthetic-secret");
	expect(runtime.requests()).toBe(0);
});
