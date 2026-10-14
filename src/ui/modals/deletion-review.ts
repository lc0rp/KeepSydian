import { t } from "../../lang/ui";
import type { SyncPlan, SyncPlanEntry } from "@types";

export function deletionReviewSummary(plan: SyncPlan): string {
	const deletions = plan.entries.filter((entry) => entry.action === "delete");
	const selected = deletions.filter((entry) => entry.selectable && entry.selected).length;
	if (plan.stage !== "upload") {
		return t("deletion.download",{selected});
	}
	const selection = deletions.some((entry) => entry.selectable && !entry.selectionLocked)
		? t("deletion.selection")
		: t("deletion.locked");
	return t("deletion.upload",{selected,total:deletions.length,selection});
}

/** A refresh in the same reviewed run must not silently reselect a removal. */
export function retainUncheckedDeletions(previous: SyncPlan, refreshed: SyncPlan): SyncPlan {
	const unchecked = new Set(previous.entries.filter((entry) => entry.action === "delete" && !entry.selected).map((entry) => entry.id));
	const entries = refreshed.entries.map((entry) => entry.action === "delete" && unchecked.has(entry.id)
		? { ...entry, selected: false } : entry);
	return { ...refreshed, entries, selectedCount: entries.filter((entry) => entry.selectable && entry.selected).length };
}

/** Preserve the review identity while exposing a late remote revision conflict. */
export function markDeletionConflict(entry: SyncPlanEntry): void {
	entry.action = "skipped-conflict";
	entry.label = "Deletion conflict";
	entry.meta = { ...entry.meta, detail: "Google Keep changed since the last completed sync. This note was not trashed. Refresh the review and resolve the remote change before retrying." };
}
