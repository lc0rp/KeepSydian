import type { SyncPlan } from "@types";
import type { PreparedDeletions } from "./deletions";
import { normalizePathSafe } from "@services/paths";

/** Include the reviewed path and the current path of a renamed retained file. */
export function getDeletionUploadPaths(deletions?: PreparedDeletions): string[] {
	return [...new Set((deletions?.candidates ?? []).flatMap((candidate) => [
		normalizePathSafe(candidate.path),
		normalizePathSafe(candidate.file.path),
	]))];
}

/** A kept local copy must not silently resurrect a trashed Keep note in this run. */
export function excludeDeletionUploads(plan: SyncPlan, deletions?: PreparedDeletions): SyncPlan {
	if (plan.stage !== "upload" || !deletions?.candidates.length) return plan;
	const excludedPaths = new Set(getDeletionUploadPaths(deletions));
	const entries = plan.entries.filter((entry) => !excludedPaths.has(normalizePathSafe(entry.path)));
	return {
		...plan,
		entries,
		counts: entries.reduce<Record<string, number>>((counts, entry) => {
			counts[entry.label] = (counts[entry.label] ?? 0) + 1;
			return counts;
		}, {}),
		selectedCount: entries.filter((entry) => entry.selectable && entry.selected).length,
		actionableCount: entries.filter((entry) => entry.selectable).length,
	};
}
