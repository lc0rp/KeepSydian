import type { SyncMode } from "./keepsidian-plugin-settings";

export type SyncAttemptPhase =
	| "preflight"
	| "storage"
	| "subscription"
	| "fetch"
	| "plan"
	| "review"
	| "execution"
	| "upload-plan"
	| "upload";
export type SyncAttemptOutcome = "success" | "failed" | "canceled" | "abandoned";

/** Safe, persisted history pointer. Never contains request payloads or exception text. */
export interface LastSyncAttempt {
	id: string;
	mode: SyncMode;
	phase: SyncAttemptPhase;
	startedAt: number;
	updatedAt: number;
	outcome?: SyncAttemptOutcome;
	fetchedCount: number;
	elapsedMs: number;
	httpStatus?: number;
	logPath?: string;
	logUnavailable: boolean;
}
