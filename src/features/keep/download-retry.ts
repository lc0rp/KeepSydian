import { NetworkError } from "@services/errors";

export const isTransientDownloadError = (error: unknown): error is NetworkError =>
	error instanceof NetworkError && ([429, 502, 503, 504].includes(error.status ?? 0) || error.transportFailure);

/** One retry owner, bounded per uncommitted page. Hooks keep timing deterministic. */
export async function retryDownload<T>(
	fetch: () => Promise<T>,
	options: {
		checkCancelled: () => void;
		onRetry: (attempt: number) => Promise<void>;
		enabled?: boolean;
		now?: () => number;
		random?: () => number;
		sleep?: (ms: number) => Promise<void>;
	}
): Promise<T> {
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
	const started = now();
	for (let attempt = 1; ; attempt++) {
		options.checkCancelled();
		try {
			const value = await fetch();
			options.checkCancelled();
			return value;
		} catch (error) {
			options.checkCancelled();
			if (options.enabled === false || !isTransientDownloadError(error) || attempt >= 3) throw error;
			const delay = Math.max(error.retryAfterMs ?? 0, 2000 * 2 ** (attempt - 1) * (0.75 + random() * 0.5));
			if (now() - started + delay >= 30_000) throw error;
			await options.onRetry(attempt);
			for (let remaining = delay; remaining > 0; remaining -= 100) {
				options.checkCancelled();
				await sleep(Math.min(100, remaining));
			}
		}
	}
}
