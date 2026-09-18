import { Notice } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import type { DownloadScope, SyncMode } from "@types";
import type { LastSyncAttempt, SyncAttemptOutcome, SyncAttemptPhase } from "../types/sync-attempt";
import type { NoteImportOptions } from "@ui/modals/NoteImportOptionsModal";
import { flushLogSync, logSync } from "@app/logging";
import { isSyncCancellationError } from "@app/sync-cancel";

type AttemptEvent = "start" | "phase" | "page-start" | "page-fetched" | "retry" | "review-ready" | "outcome";
interface PageMetadata {
	pageOrdinal?: number;
	paginationMode?: "offset" | "cursor";
	offset?: number;
	requestedLimit?: number;
	fetchedCount?: number;
	total?: number;
	retryCount?: number;
}

let sequence = 0;
const latestAttempts = new WeakMap<KeepSidianPlugin, string>();
function newAttemptId(): string {
	// The counter keeps IDs unique even with deterministic clocks/randomness in tests.
	sequence += 1;
	const random =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: Math.random().toString(36).slice(2);
	return `${Date.now().toString(36)}-${sequence.toString(36)}-${random}`;
}

/** Classify only allowlisted primitives. Do not stringify messages, stacks, causes or response bodies. */
export function safeSyncError(error: unknown): { errorKind: string; httpStatus?: number } {
	const result: { errorKind: string; httpStatus?: number } = { errorKind: "unknown" };
	const visited = new Set<unknown>();
	for (let depth = 0; depth < 5 && error && typeof error === "object" && !visited.has(error); depth += 1) {
		visited.add(error);
		try {
			const candidate = error as { status?: unknown; kind?: unknown; cause?: unknown };
			if (
				typeof candidate.status === "number" &&
				Number.isInteger(candidate.status) &&
				candidate.status >= 100 &&
				candidate.status <= 599
			) {
				result.httpStatus ??= candidate.status;
			}
			if (candidate.kind === "network" || candidate.kind === "parse" || candidate.kind === "io")
				result.errorKind = candidate.kind;
			error = candidate.cause;
		} catch {
			break;
		}
	}
	return result;
}

function safeCutoff(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function formatAttemptSummary(attempt: LastSyncAttempt): string {
	const outcome =
		attempt.outcome ?? (attempt.phase === "review" ? "ready for review" : "interrupted before a recorded outcome");
	return `Last attempt ${attempt.id}: ${outcome} (${attempt.phase}, ${attempt.fetchedCount} fetched).${attempt.logUnavailable ? " Sync log unavailable." : ""}`;
}

/** One owner spans preflight, review and both stages of an execution. */
export class SyncAttempt {
	readonly id = newAttemptId();
	readonly startedAt = Date.now();
	private currentPhase: SyncAttemptPhase = "preflight";
	private terminal?: SyncAttemptOutcome;
	private finalization?: Promise<void>;
	private writes: Promise<void> = Promise.resolve();
	private started = false;
	private unavailable = false;
	private page: PageMetadata = { fetchedCount: 0, retryCount: 0 };
	private cutoff?: string;
	private features: Record<string, boolean> = {};
	private status?: number;

	constructor(
		private readonly plugin: KeepSidianPlugin,
		readonly mode: SyncMode,
		private scope: DownloadScope = { kind: "last-sync" },
		readonly source: "manual" | "scheduled" | "legacy" = "manual"
	) {
		this.setScope(scope);
		this.setFeatures();
	}

	get finished(): boolean {
		return this.terminal !== undefined;
	}
	get outcome(): SyncAttemptOutcome | undefined {
		return this.terminal;
	}
	get phase(): SyncAttemptPhase {
		return this.currentPhase;
	}
	get logUnavailable(): boolean {
		return this.unavailable;
	}

	setScope(scope: DownloadScope = { kind: "last-sync" }): void {
		this.scope = scope.kind === "all" || scope.kind === "custom-since" ? scope : { kind: "last-sync" };
		this.cutoff = safeCutoff(
			this.scope.kind === "custom-since" ? this.scope.since : this.plugin.settings.keepSidianLastSuccessfulSyncDate
		);
		if (this.scope.kind === "all") this.cutoff = undefined;
	}

	setFeatures(options?: NoteImportOptions): void {
		this.features = {
			premium: options !== undefined,
			filterNotes: !!options?.includeNotesTerms?.length,
			skipNotes: !!options?.excludeNotesTerms?.length,
			keepStateFilter:
				!!options?.includeColors?.length ||
				(!!options?.pinnedStatus && options.pinnedStatus !== "all") ||
				(!!options?.archivedStatus && options.archivedStatus !== "active-only"),
			suggestTitle: options?.updateTitle === true,
			suggestTags: options?.suggestTags === true,
			embedImages: this.plugin.settings.embedImportedImages === true,
		};
	}

	setCutoff(value: unknown): void {
		this.cutoff = safeCutoff(value);
	}

	start(): Promise<void> {
		if (this.started) return this.writes;
		this.started = true;
		latestAttempts.set(this.plugin, this.id);
		return this.record("start", true);
	}

	transition(phase: SyncAttemptPhase): Promise<void> {
		if (this.finished) return this.writes;
		this.currentPhase = phase;
		return this.record(phase === "review" ? "review-ready" : "phase", phase === "review");
	}

	pageEvent(event: "page-start" | "page-fetched" | "retry", data: PageMetadata): Promise<void> {
		if (this.finished) return this.writes;
		for (const key of ["pageOrdinal", "offset", "requestedLimit", "fetchedCount", "total", "retryCount"] as const) {
			const value = data[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.page[key] = Math.floor(value);
		}
		if (data.paginationMode === "offset" || data.paginationMode === "cursor")
			this.page.paginationMode = data.paginationMode;
		if (this.page.paginationMode === "cursor") delete this.page.offset;
		return this.record(event);
	}

	finish(outcome: SyncAttemptOutcome, error?: unknown): Promise<void> {
		if (this.finalization) return this.finalization;
		this.terminal = outcome;
		this.status = safeSyncError(error).httpStatus;
		this.finalization = this.record("outcome", true, error);
		return this.finalization;
	}

	fail(error: unknown): Promise<void> {
		return this.finish(isSyncCancellationError(error) ? "canceled" : "failed", error);
	}

	errorMessage(error: unknown): string {
		const classified = safeSyncError(error);
		const httpStatus = classified.httpStatus ?? this.status;
		const errorKind = classified.errorKind;
		const reason = httpStatus
			? `HTTP ${httpStatus}.`
			: errorKind === "parse"
				? "Invalid server response."
				: "The operation could not be completed.";
		return `${reason} Attempt ${this.id}.${this.unavailable ? " Sync log unavailable; check vault storage permissions." : " See View log for details."}`;
	}

	private fallback(): void {
		if (this.unavailable) return;
		this.unavailable = true;
		try {
			new Notice(`KeepSidian: sync log or attempt history unavailable. Attempt ${this.id}.`);
		} catch {
			/* Presentation must not mask sync failures. */
		}
	}

	private record(event: AttemptEvent, persist = false, error?: unknown): Promise<void> {
		const updatedAt = Date.now();
		const elapsedMs = Math.max(0, updatedAt - this.startedAt);
		const phase = this.currentPhase;
		const outcome = this.terminal;
		const fetchedCount = this.page.fetchedCount ?? 0;
		const metadata = {
			attemptId: this.id,
			mode: this.mode,
			source: this.source,
			event,
			phase,
			label: `${this.source === "scheduled" ? "Auto sync" : this.mode === "two-way" ? "Two-way sync" : this.mode === "push" ? "Push sync" : "Manual sync"} ${event === "start" ? "started" : event === "outcome" ? "ended" : event}`,
			scopeKind: this.scope.kind,
			cutoff: this.cutoff,
			...this.page,
			features: { ...this.features },
			elapsedMs,
			outcome,
			...(error === undefined ? {} : safeSyncError(error)),
		};
		const payload = `Sync attempt ${JSON.stringify(metadata)}`;
		this.writes = this.writes.then(async () => {
			try {
				if (event === "outcome") await flushLogSync(this.plugin);
				await logSync(this.plugin, payload, { strict: true });
			} catch {
				this.fallback();
				// Only our allowlisted record is safe to print, even when the storage exception contains secrets.
				try {
					console.warn(payload);
				} catch {
					/* no-op */
				}
			}
			if (!persist) return;
			const previous = this.plugin.settings.lastSyncAttempt;
			// A late completion from an abandoned plan must not replace a newer attempt.
			if (
				latestAttempts.get(this.plugin) !== this.id ||
				(previous && previous.id !== this.id && previous.startedAt > this.startedAt)
			)
				return;
			const summary: LastSyncAttempt = {
				id: this.id,
				mode: this.mode,
				phase,
				startedAt: this.startedAt,
				updatedAt,
				outcome,
				fetchedCount,
				elapsedMs,
				httpStatus: this.status,
				logPath: this.plugin.lastSyncLogPath ?? undefined,
				logUnavailable: this.unavailable,
			};
			this.plugin.settings.lastSyncAttempt = summary;
			try {
				await this.plugin.saveSettings();
			} catch {
				this.fallback();
				summary.logUnavailable = true;
			}
			if (outcome && this.plugin.statusTextEl) this.plugin.statusTextEl.textContent = `Last attempt ${outcome}`;
		});
		return this.writes;
	}
}
