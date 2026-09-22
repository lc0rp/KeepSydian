import type { MergeAction, SyncPlan } from "@types";
import { mergeNoteText } from "./merge";

export const DEFAULT_MERGE_ACTION: MergeAction = "merge-save-conflicts";

export const MERGE_ACTION_OPTIONS: ReadonlyArray<{ value: MergeAction; label: string }> = [
	{ value: "merge-save-conflicts", label: "Merge & save conflicts" },
	{ value: "merge-skip-conflicts", label: "Merge & skip conflicts" },
	{ value: "merge-overwrite-conflicts", label: "Merge & overwrite conflicts" },
	{ value: "overwrite-all", label: "Overwrite all, no merge" },
];

export function normalizeMergeAction(value: unknown): MergeAction {
	return MERGE_ACTION_OPTIONS.find((option) => option.value === value)?.value ?? DEFAULT_MERGE_ACTION;
}

export function hasMergeCandidates(plan: SyncPlan): boolean {
	return plan.entries.some((entry) => entry.action === "merge" || entry.action === "conflict-copy");
}

export interface MergeDecision {
	action: "merge" | "overwrite" | "conflict-copy" | "skipped-conflict";
	text: string;
	hasConflict: boolean;
}

/**
 * Resolve a whole note, with destination/source interpreted for the current stage.
 * Download: destination is the vault; source is Keep. Upload reverses those roles.
 * A skip leaves the entire destination untouched. Conflict overwrite uses the
 * entire source note. Only a conflict copy is allowed to contain conflict markers.
 * Callers own I/O, metadata, attachments, progress, and checkpoint handling.
 */
export function resolveMergeAction(
	destinationText: string,
	sourceText: string,
	requestedAction: MergeAction = DEFAULT_MERGE_ACTION
): MergeDecision {
	const action = normalizeMergeAction(requestedAction);
	if (action === "overwrite-all") {
		return { action: "overwrite", text: sourceText, hasConflict: false };
	}

	const { mergedText, hasConflict } = mergeNoteText(destinationText, sourceText);
	if (!hasConflict) {
		return { action: "merge", text: mergedText, hasConflict: false };
	}
	if (action === "merge-skip-conflicts") {
		return { action: "skipped-conflict", text: destinationText, hasConflict: true };
	}
	if (action === "merge-overwrite-conflicts") {
		return { action: "overwrite", text: sourceText, hasConflict: true };
	}
	return { action: "conflict-copy", text: mergedText, hasConflict: true };
}
