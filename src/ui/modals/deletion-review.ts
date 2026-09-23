import type { SyncPlan, SyncPlanEntry } from "@types";

export function deletionReviewSummary(plan: SyncPlan): string {
	const deletions = plan.entries.filter((entry) => entry.action === "delete");
	const selected = deletions.filter((entry) => entry.selectable && entry.selected).length;
	if (plan.stage !== "upload") {
		return `${selected} note${selected === 1 ? "" : "s"} will be deleted from Obsidian (moved to .trash). Uncheck any deletion to keep the local note. Attachments are retained.`;
	}
	const selection = deletions.some((entry) => entry.selectable && !entry.selectionLocked)
		? "Uncheck a deletion to leave its Google Keep note unchanged."
		: "Existing supporter selection locks apply; cancel this plan to leave all Google Keep notes unchanged.";
	return `${selected} of ${deletions.length} local deletion${deletions.length === 1 ? "" : "s"} selected. Selected notes will be moved to Google Keep Trash, never permanently deleted. ${selection} Unchecked local removals are not downloaded again in this run.`;
}

/** A refresh in the same reviewed run must not silently reselect a deletion. */
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
