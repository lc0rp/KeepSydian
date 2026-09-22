import type { DownloadScope } from "@types";
import type { SyncFilters } from "@integrations/server/keepApi";

export interface DownloadDateWindow {
	filters: SyncFilters;
	checkpoint?: string;
}

function parseDate(value: string, field: "start" | "end", startedAt: number): Date {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) {
		throw new Error(`Choose a valid custom ${field} date before preparing the download review.`);
	}
	if (parsed.getTime() > startedAt) {
		throw new Error("Custom download dates must be in the past.");
	}
	return parsed;
}

/** Resolve once per preparation, before any asynchronous preflight or pagination. */
export function resolveDownloadDateWindow(
	downloadScope: DownloadScope | undefined,
	lastSuccessfulSyncDate: string | undefined,
	startedAt = Date.now()
): DownloadDateWindow {
	const scope = downloadScope ?? { kind: "last-sync" };
	if (!Number.isFinite(startedAt)) throw new Error("Invalid sync start time.");
	const until = scope.until?.trim()
		? parseDate(scope.until.trim(), "end", startedAt)
		: new Date(startedAt);
	let since: string | undefined;
	if (scope.kind === "custom-since") {
		if (!scope.since?.trim()) throw new Error("Choose a custom date.");
		since = parseDate(scope.since.trim(), "start", startedAt).toISOString();
		if (Date.parse(since) >= until.getTime()) {
			throw new Error("End date must be after the start date.");
		}
	} else if (scope.kind === "last-sync" && lastSuccessfulSyncDate) {
		const previous = new Date(lastSuccessfulSyncDate);
		if (!Number.isFinite(previous.getTime()) || previous.getTime() > until.getTime()) {
			throw new Error("The last sync date is outside this date range. Choose all dates or a custom range.");
		}
		since = previous.toISOString();
	}

	// The server already supports these upper bounds. Both creation and update
	// must precede the end, while changed_gt retains the existing start semantics.
	const filters: SyncFilters = {
		...(since ? { changed_gt: since } : {}),
		created_lt: until.toISOString(),
		updated_lt: until.toISOString(),
	};

	// Custom ranges can leave gaps, so they must not advance the automatic cursor.
	// Exclusive gt/lt bounds need a small overlap to avoid losing notes exactly
	// at the end boundary. Existing note reconciliation makes replay safe.
	const checkpointMs = until.getTime() - 1;
	const previousMs = lastSuccessfulSyncDate ? Date.parse(lastSuccessfulSyncDate) : Number.NaN;
	const checkpoint =
		scope.kind !== "custom-since" && (!Number.isFinite(previousMs) || checkpointMs > previousMs)
			? new Date(checkpointMs).toISOString()
			: undefined;
	return { filters, checkpoint };
}
