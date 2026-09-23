import type KeepSidianPlugin from "@app/main";
import { executeReviewedDeletions, type PreparedDeletions } from "../deletions";
import type { SyncCallbacks } from "../sync";
import { getDeletionLedger } from "./ledger";

/** Preserve the explicit GET Trash feed and the existing reviewed .trash executor. */
export async function executeTrackedInboundDeletions(
	plugin: KeepSidianPlugin,
	prepared: PreparedDeletions | undefined,
	selectedEntryIds: ReadonlySet<string>,
	callbacks?: SyncCallbacks
): Promise<number> {
	const ledger = getDeletionLedger(plugin);
	const confirmed = new Set<string>();
	let count = 0;
	try {
		await executeReviewedDeletions(plugin, prepared, new Set(selectedEntryIds), {
			...callbacks,
			onEntrySettled: (entryId, success, outcome) => {
				if (success) {
					const candidate = prepared?.candidates.find((item) => item.entryId === entryId);
					if (candidate) { confirmed.add(candidate.keepUrl); count += 1; }
				}
				if (outcome === undefined) callbacks?.onEntrySettled?.(entryId, success);
				else callbacks?.onEntrySettled?.(entryId, success, outcome);
			},
		});
	} finally {
		// A later inbound row may fail after earlier rows reached local .trash.
		// Retire only confirmed successes so they cannot echo into upload review.
		if (ledger && confirmed.size) await ledger.retireRemoteTrash(confirmed);
	}
	return count;
}
