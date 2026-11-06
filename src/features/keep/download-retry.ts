import { NetworkError } from "@services/errors";

export const isTransientDownloadError = (error: unknown): error is NetworkError =>
	error instanceof NetworkError &&
	error.retryAllowed !== false &&
	([429, 502, 503, 504].includes(error.status ?? 0) || error.transportFailure);

/** One retry owner, bounded per uncommitted page. Hooks keep timing deterministic. */
export interface ReadRetryHooks {
	checkCancelled: () => void;
	onRetry: (attempt: number) => Promise<void>;
}
export async function retryDownload<T>(
	fetch: () => Promise<T>,
	options: {
		checkCancelled: () => void;
		onRetry: (attempt: number) => Promise<void>;
		enabled?: boolean;
		recover?: (error: unknown) => Promise<boolean>;
		now?: () => number;
		random?: () => number;
		sleep?: (ms: number) => Promise<void>;
	}
): Promise<T> {
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)));
	const started = now();
	for (let attempt = 1; ; attempt++) {
		options.checkCancelled();
		try {
			const value = await fetch();
			options.checkCancelled();
			return value;
		} catch (error) {
			options.checkCancelled();
			if (options.enabled === false || attempt >= 3 || now() - started >= 30_000) throw error;
			const recovered = await options.recover?.(error);
			if (!recovered && !isTransientDownloadError(error)) throw error;
			const delay = recovered
				? 0
				: Math.max((error as NetworkError).retryAfterMs ?? 0, 2000 * 2 ** (attempt - 1) * (0.75 + random() * 0.5));
			if (now() - started + delay >= 30_000) throw error;
			await options.onRetry(attempt);
			for (let remaining = delay; remaining > 0; remaining -= 100) {
				options.checkCancelled();
				await sleep(Math.min(100, remaining));
			}
		}
	}
}
