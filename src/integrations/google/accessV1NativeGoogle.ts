/** Android host capability observed in Obsidian 1.12.7/build303; not a stable Obsidian API guarantee. */
const GOOGLE_URL = "https://android.clients.google.com/auth";
const FAILURE = "Google authentication failed; it was not retried.";

interface NativeHost {
	isLoggingEnabled: boolean;
	getPlatform(): string;
	isPluginAvailable(name: string): boolean;
	Plugins: { CapacitorHttp: { request(options: Record<string, unknown>): Promise<unknown> } };
}

function nativeHost(): NativeHost {
	const value = (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
	const host = value as NativeHost;
	if (
		!Object.prototype.hasOwnProperty.call(host, "isLoggingEnabled") ||
		host.isLoggingEnabled !== false ||
		typeof host.getPlatform !== "function" ||
		host.getPlatform() !== "android" ||
		typeof host.isPluginAvailable !== "function" ||
		host.isPluginAvailable("CapacitorHttp") !== true ||
		typeof host.Plugins?.CapacitorHttp?.request !== "function"
	)
		throw new Error();
	return host;
}

/** Google-only native request. No browser/requestUrl/backend fallback and no automatic retry. */
export async function nativeGoogleAuthRequest(body: string): Promise<string> {
	try {
		if (
			typeof body !== "string" ||
			body.length === 0 ||
			body.length > 32768 ||
			!/^[A-Za-z0-9*_.%+=&-]+$/.test(body) ||
			/%(?![a-fA-F0-9]{2})/.test(body)
		)
			throw new Error();
		const host = nativeHost();
		const helper = host.Plugins.CapacitorHttp;
		// This known-state check is not a lock on host logging during native execution.
		// Do not mutate the app's global logging, cookies, Fetch or certificate settings.
		const response = await helper.request({
			url: GOOGLE_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "GoogleAuth/1.4" },
			data: body,
			responseType: "text",
			disableRedirects: true,
			connectTimeout: 30000,
			readTimeout: 30000,
		});
		if (nativeHost() !== host) throw new Error();
		if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error();
		const result = response as Record<string, unknown>;
		for (const key of ["status", "url", "data"])
			if (!Object.prototype.hasOwnProperty.call(result, key)) throw new Error();
		if (
			typeof result.status !== "number" ||
			!Number.isInteger(result.status) ||
			result.status < 200 ||
			result.status >= 300 ||
			result.url !== GOOGLE_URL ||
			typeof result.data !== "string" ||
			result.data.length === 0 ||
			result.data.length > 16384 ||
			/[^\x20-\x7e\r\n]/.test(result.data)
		)
			throw new Error();
		if (result.headers !== undefined) {
			if (!result.headers || typeof result.headers !== "object" || Array.isArray(result.headers)) throw new Error();
			let size = 0;
			for (const [name, value] of Object.entries(result.headers)) {
				if (typeof value !== "string" || /[^\x20-\x7e]/.test(name + value)) throw new Error();
				size += name.length + value.length;
				if (size > 8192) throw new Error();
			}
		}
		// Native buffers before returning; these are post-response checks, not native memory caps.
		// Native cookies may be reused. Read timeout is inactivity-based, not a total deadline/cancellation promise.
		return result.data;
	} catch {
		throw new Error(FAILURE);
	}
}
