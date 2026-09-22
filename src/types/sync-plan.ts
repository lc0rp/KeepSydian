import type { SyncMode } from "./keepsidian-plugin-settings";

export type SyncPlanStage = "import" | "upload";

export type MergeAction =
	| "merge-save-conflicts"
	| "merge-skip-conflicts"
	| "merge-overwrite-conflicts"
	| "overwrite-all";

export type SyncPlanAction =
	| "create"
	| "overwrite"
	| "merge"
	| "conflict-copy"
	| "upload"
	| "skipped-identical"
	| "skipped-up-to-date"
	| "skipped-conflict-copy"
	| "skipped-conflict";

export interface SyncPlanEntryMeta {
	relativePath?: string;
	attachmentCount?: number;
	missingAttachmentCount?: number;
	missingAttachmentNames?: string[];
	detail?: string;
}

export interface SyncPlanEntry {
	id: string;
	mode: SyncMode;
	stage: SyncPlanStage;
	title: string;
	path: string;
	action: SyncPlanAction;
	label: string;
	selectable: boolean;
	selected: boolean;
	selectionLocked: boolean;
	selectionLockedReason?: string;
	meta?: SyncPlanEntryMeta;
}

export interface SyncPlanCounts {
	[action: string]: number;
}

export interface SyncPlan {
	id: string;
	mode: SyncMode;
	stage: SyncPlanStage;
	generatedAt: number;
	title: string;
	entries: SyncPlanEntry[];
	counts: SyncPlanCounts;
	selectedCount: number;
	actionableCount: number;
	/** Applies to this reviewed run only; an omitted value preserves the safe default. */
	mergeAction?: MergeAction;
}
