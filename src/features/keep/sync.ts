import { Notice } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { normalizeNote, PreNormalizedNote, extractFrontmatter } from "./domain/note";
import { handleDuplicateNotes } from "./domain/compare";
import { mergeNoteText } from "./domain/merge";
// Import via legacy google path so tests can spy on this module
import { processAttachments } from "../keep/io/attachments";
import type { NoteImportOptions } from "@ui/modals/NoteImportOptionsModal";
import { CONFLICT_FILE_SUFFIX } from "./constants";
import { buildFrontmatterWithSyncDate, wrapMarkdown } from "./frontmatter";
import { ensurePascalCaseFrontmatter } from "./migrations/fixFrontmatterCasing";
import {
	dirnameSafe,
	ensureFolder,
	ensureParentFolderForFile,
	mediaFolderPath,
	normalizePathSafe,
} from "@services/paths";
import { resolveNoteFolder, resolveNotePath } from "@services/note-path-resolver";
import { flushLogSync, logSync } from "@app/logging";
import type { GoogleKeepImportResponse, PremiumFeatureFlags, SyncFilters } from "@integrations/server/keepApi";
import type { DownloadScope, SyncPlan, SyncPlanEntry } from "@types";
import { NetworkError } from "@services/errors";
import { SyncCancellationError } from "@app/sync-cancel";
import {
	fetchNotes as apiFetchNotes,
	fetchNotesWithPremiumFeatures as apiFetchNotesWithPremium,
} from "@integrations/server/keepApi";
import { findExistingKeepNotePath } from "./domain/noteLookup";
import {
	buildExistingKeepNoteIndex,
	updateExistingKeepNoteIndex,
	type ExistingKeepNoteIndex,
} from "./domain/noteLookup";
import { appendPerfTrace } from "@app/perf-trace";
import { stripManagedImageEmbeds, withManagedImageEmbeds } from "./domain/attachmentEmbeds";

const LAST_SUCCESSFUL_SYNC_DATE_KEY = "KeepSidianLastSuccessfulSyncDate";
const NOTE_LOG_BATCH_KEY = "sync:notes";
const NOTE_LOG_BATCH_SIZE = 50;
const FETCH_NOTES_PAGE_LIMIT = 100;
const FETCH_NOTES_MAX_ATTEMPTS = 3;
const FETCH_NOTES_INITIAL_RETRY_DELAY_MS = 2_000;
const FETCH_NOTES_RETRYABLE_STATUSES = new Set([429, 503]);
const NOTE_SAVE_CONCURRENCY = 4;
const NOTE_PERF_LOG_INTERVAL = 25;
const NOTE_PERF_SLOW_THRESHOLD_MS = 1_500;
const NOTE_LOG_BATCH_OPTIONS = {
	batchKey: NOTE_LOG_BATCH_KEY,
	batchSize: NOTE_LOG_BATCH_SIZE,
} as const;

type NoteSaveAction = "skipped" | "created" | "merged" | "conflict" | "overwritten";

interface NoteSaveMetrics {
	action: NoteSaveAction;
	totalDurationMs: number;
	resolveExistingPathDurationMs: number;
	existsCheckDurationMs: number;
	duplicateDecisionDurationMs: number;
	readExistingDurationMs: number;
	ensureParentFolderDurationMs: number;
	writeNoteDurationMs: number;
	attachmentDurationMs: number;
	attachmentFetchDurationMs: number;
	attachmentCompareDurationMs: number;
	attachmentWriteDurationMs: number;
	logDurationMs: number;
}

interface SaveBatchMetrics {
	processed: number;
	totalDurationMs: number;
	ensureParentFolderDurationMs: number;
	writeNoteDurationMs: number;
	attachmentDurationMs: number;
	duplicateDecisionDurationMs: number;
	logDurationMs: number;
}

function throwIfSyncCancelled(plugin: KeepSidianPlugin): void {
	const cancelablePlugin = plugin as KeepSidianPlugin & {
		throwIfSyncCancelled?: () => void;
	};
	cancelablePlugin.throwIfSyncCancelled?.();
}

function getNowMs(): number {
	if (typeof performance !== "undefined" && typeof performance.now === "function") {
		return performance.now();
	}
	return Date.now();
}

function formatDurationMs(durationMs: number): string {
	return `${durationMs.toFixed(0)}ms`;
}

async function measureAsyncDuration(work: () => Promise<void>): Promise<number> {
	const startedAt = getNowMs();
	await work();
	return getNowMs() - startedAt;
}

function logPerformanceSummary(label: string, metrics: SaveBatchMetrics): void {
	if (metrics.processed === 0) {
		return;
	}

	const averageTotalMs = metrics.totalDurationMs / metrics.processed;
	const averageEnsureParentMs = metrics.ensureParentFolderDurationMs / metrics.processed;
	const averageWriteMs = metrics.writeNoteDurationMs / metrics.processed;
	const averageAttachmentMs = metrics.attachmentDurationMs / metrics.processed;
	const averageDuplicateMs = metrics.duplicateDecisionDurationMs / metrics.processed;
	const averageLogMs = metrics.logDurationMs / metrics.processed;
	logInfoIfNotTest(
		`[KeepSidian perf] ${label}: processed=${metrics.processed} avg_total=${formatDurationMs(averageTotalMs)} avg_duplicate=${formatDurationMs(averageDuplicateMs)} avg_ensure_parent=${formatDurationMs(averageEnsureParentMs)} avg_write=${formatDurationMs(averageWriteMs)} avg_attachments=${formatDurationMs(averageAttachmentMs)} avg_log=${formatDurationMs(averageLogMs)}`
	);
}

async function withKeyedLock<T>(locks: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chained = previous.then(() => current);
	locks.set(key, chained);
	await previous;
	try {
		return await work();
	} finally {
		release();
		if (locks.get(key) === chained) {
			locks.delete(key);
		}
	}
}

function getVaultConfig(plugin: KeepSidianPlugin, key: string): unknown {
	const vault = plugin.app?.vault as { getConfig?: (configKey: string) => unknown } | undefined;
	if (vault?.getConfig) {
		try {
			return vault.getConfig(key);
		} catch {
			/* empty */
		}
	}
	return undefined;
}

function setVaultConfig(plugin: KeepSidianPlugin, key: string, value: unknown): void {
	const vault = plugin.app?.vault as { setConfig?: (configKey: string, configValue: unknown) => void } | undefined;
	if (vault?.setConfig) {
		try {
			vault.setConfig(key, value);
		} catch {
			/* empty */
		}
	}
}

export function getLastSuccessfulSyncDate(plugin: KeepSidianPlugin): string | undefined {
	const fromSettings = plugin.settings.keepSidianLastSuccessfulSyncDate;
	if (typeof fromSettings === "string" && fromSettings.trim().length > 0) {
		return fromSettings;
	}

	const fromVault = getVaultConfig(plugin, LAST_SUCCESSFUL_SYNC_DATE_KEY);
	if (typeof fromVault === "string" && fromVault.trim().length > 0) {
		return fromVault;
	}

	return undefined;
}

function persistLastSuccessfulSyncDate(plugin: KeepSidianPlugin, isoString: string): void {
	plugin.settings.keepSidianLastSuccessfulSyncDate = isoString;
	setVaultConfig(plugin, LAST_SUCCESSFUL_SYNC_DATE_KEY, isoString);
}

function parseCustomSinceDate(isoString: string): Date {
	const parsed = new Date(isoString);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error("Choose a valid custom date before preparing the download review.");
	}
	if (parsed.getTime() > Date.now()) {
		throw new Error("Custom download dates must be in the past.");
	}
	return parsed;
}

export function buildDownloadSyncFilters(
	plugin: KeepSidianPlugin,
	downloadScope?: DownloadScope
): SyncFilters | undefined {
	const scope = downloadScope ?? { kind: "last-sync" };

	if (scope.kind === "all") {
		return undefined;
	}

	if (scope.kind === "custom-since") {
		const since = scope.since?.trim();
		if (!since) {
			throw new Error("Choose a custom date.");
		}
		return {
			changed_gt: parseCustomSinceDate(since).toISOString(),
		};
	}

	const lastSuccessfulSyncDate = getLastSuccessfulSyncDate(plugin);
	return lastSuccessfulSyncDate
		? {
				changed_gt: lastSuccessfulSyncDate,
			}
		: undefined;
}

export interface SyncCallbacks {
	setTotalNotes?: (total: number) => void;
	reportProgress?: () => void;
	reportPlanProgress?: (processed: number, total?: number) => void;
	onEntrySettled?: (entryId: string, success: boolean) => void;
}

interface FetchImportNotesResult {
	notes: PreNormalizedNote[];
	completionDate?: string;
}

export interface BuiltImportSyncPlan {
	plan: SyncPlan;
	notes: PreNormalizedNote[];
	noteEntryIds: string[];
	completionDate?: string;
}

function logErrorIfNotTest(...args: unknown[]) {
	try {
		const isTest =
			typeof process !== "undefined" && (process.env?.NODE_ENV === "test" || !!process.env?.JEST_WORKER_ID);
		if (!isTest) {
			console.error(...args);
		}
	} catch {
		// no-op
	}
}

function logInfoIfNotTest(...args: unknown[]) {
	try {
		const isTest =
			typeof process !== "undefined" && (process.env?.NODE_ENV === "test" || !!process.env?.JEST_WORKER_ID);
		if (!isTest) {
			console.debug(...args);
		}
	} catch {
		// no-op
	}
}

function isRetryableFetchError(error: unknown): error is NetworkError {
	return error instanceof NetworkError && FETCH_NOTES_RETRYABLE_STATUSES.has(error.status ?? -1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchImportPageWithRetry(
	fetchFunction: (
		offset: number,
		limit: number,
		filters?: SyncFilters,
		cursor?: string
	) => Promise<GoogleKeepImportResponse>,
	offset: number,
	limit: number,
	filters?: SyncFilters,
	cursor?: string
): Promise<GoogleKeepImportResponse> {
	let retryDelayMs = FETCH_NOTES_INITIAL_RETRY_DELAY_MS;

	for (let attempt = 1; attempt <= FETCH_NOTES_MAX_ATTEMPTS; attempt++) {
		try {
			return await fetchFunction(offset, limit, filters, cursor);
		} catch (error) {
			if (!isRetryableFetchError(error) || attempt === FETCH_NOTES_MAX_ATTEMPTS) {
				throw error;
			}
			logErrorIfNotTest(
				`Rate limited while fetching notes at offset ${offset}; retrying in ${retryDelayMs}ms (attempt ${attempt}/${FETCH_NOTES_MAX_ATTEMPTS})`
			);
			await sleep(retryDelayMs);
			retryDelayMs *= 2;
		}
	}

	throw new Error("Retry loop exited unexpectedly");
}

async function fetchImportNotesBase(
	plugin: KeepSidianPlugin,
	fetchFunction: (
		offset: number,
		limit: number,
		filters?: SyncFilters,
		cursor?: string
	) => Promise<GoogleKeepImportResponse>,
	callbacks?: Pick<SyncCallbacks, "setTotalNotes" | "reportPlanProgress">,
	downloadScope?: DownloadScope
): Promise<FetchImportNotesResult> {
	try {
		let offset = 0;
		const limit = FETCH_NOTES_PAGE_LIMIT;
		let cursor: string | undefined;
		let usingCursorPagination = false;
		let hasError = false;
		let foundError: Error | null = null;
		let hasReportedTotal = false;
		const fetchedNotes: PreNormalizedNote[] = [];

		const syncFilters = buildDownloadSyncFilters(plugin, downloadScope);

		let completionDate: string | undefined;

		while (!hasError) {
			try {
				const response = await fetchImportPageWithRetry(fetchFunction, offset, limit, syncFilters, cursor);
				completionDate = new Date().toISOString();
				if (typeof response.total_notes === "number" && callbacks?.setTotalNotes && !hasReportedTotal) {
					try {
						callbacks.setTotalNotes(response.total_notes);
						hasReportedTotal = true;
					} catch {
						/* empty */
					}
				}
				if (!response.notes || response.notes.length === 0) {
					break;
				}
				fetchedNotes.push(...response.notes);
				callbacks?.reportPlanProgress?.(
					fetchedNotes.length,
					typeof response.total_notes === "number" ? response.total_notes : undefined
				);
				if (response.next_cursor) {
					cursor = response.next_cursor;
					usingCursorPagination = true;
				} else if (usingCursorPagination) {
					break;
				} else {
					offset += limit;
				}
			} catch (error) {
				const normalizedError = error instanceof Error ? error : new Error(String(error));
				logErrorIfNotTest(`Error fetching notes at offset ${offset}:`, normalizedError);
				hasError = true;
				foundError = normalizedError;
			}
		}

		if (foundError) {
			throw foundError;
		}

		return {
			notes: fetchedNotes,
			completionDate,
		};
	} catch (error) {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		logErrorIfNotTest(normalizedError);
		throw normalizedError;
	}
}

function buildImportPlanEntry(
	plugin: KeepSidianPlugin,
	index: number,
	note: PreNormalizedNote,
	allowPerNoteSelection: boolean,
	selectionLockedReason?: string,
	existingKeepNoteIndex?: ExistingKeepNoteIndex
): Promise<SyncPlanEntry> {
	return (async () => {
		const normalizedNote = normalizeNote(note);
		const noteTitle = normalizedNote.title || `Untitled ${index + 1}`;
		const resolvedNotePath = resolveNotePath(plugin.app, plugin.settings, normalizedNote);
		const noteFilePath =
			(await findExistingKeepNotePath(
				plugin.app,
				normalizedNote,
				resolvedNotePath,
				existingKeepNoteIndex,
				plugin.settings.saveLocation
			)) ?? resolvedNotePath;
		const duplicateAction = noteTitle
			? await handleDuplicateNotes(
					plugin.settings.saveLocation,
					normalizedNote,
					plugin.app,
					noteFilePath,
					existingKeepNoteIndex
				)
			: "skip";

		let action: SyncPlanEntry["action"] = "skipped-identical";
		let label = "Skipped: identical";
		let selectable = false;
		let detail: string | undefined;

		switch (duplicateAction) {
			case "create":
				action = "create";
				label = "Create";
				selectable = true;
				break;
			case "overwrite":
				action = "overwrite";
				label = "Overwrite";
				selectable = true;
				break;
			case "merge": {
				const existingContent = await plugin.app.vault.adapter.read(noteFilePath).catch(() => "");
				const [, existingBody] = extractFrontmatter(existingContent);
				const { hasConflict } = mergeNoteText(existingBody, normalizedNote.textWithoutFrontmatter);
				action = hasConflict ? "conflict-copy" : "merge";
				label = hasConflict ? "Conflict copy" : "Merge";
				selectable = true;
				detail = hasConflict ? "Will create a conflict copy next to the existing note." : undefined;
				break;
			}
			case "skip":
			default:
				action = "skipped-identical";
				label = "Skipped: identical";
				selectable = false;
				break;
		}

		return {
			id: `import:${index}:${normalizePathSafe(noteFilePath)}`,
			mode: "import",
			stage: "import",
			title: noteTitle,
			path: normalizePathSafe(noteFilePath),
			action,
			label,
			selectable,
			selected: selectable,
			selectionLocked: selectable && !allowPerNoteSelection,
			selectionLockedReason: selectable && !allowPerNoteSelection ? selectionLockedReason : undefined,
			meta: detail ? { detail } : undefined,
		};
	})();
}

export async function buildImportSyncPlan(
	plugin: KeepSidianPlugin,
	options?: NoteImportOptions,
	allowPerNoteSelection = true,
	selectionLockedReason?: string,
	callbacks?: Pick<SyncCallbacks, "setTotalNotes" | "reportPlanProgress">,
	downloadScope?: DownloadScope
): Promise<BuiltImportSyncPlan> {
	const { email, token } = plugin.settings;
	const fetchFunction =
		options !== undefined
			? (offset: number, limit: number, filters?: SyncFilters, cursor?: string) =>
					apiFetchNotesWithPremium(email, token, convertOptionsToFeatureFlags(options), offset, limit, filters, cursor)
			: (offset: number, limit: number, filters?: SyncFilters, cursor?: string) =>
					apiFetchNotes(email, token, offset, limit, filters, cursor);
	const fetched = await fetchImportNotesBase(plugin, fetchFunction, callbacks, downloadScope);
	const existingKeepNoteIndex = await buildExistingKeepNoteIndex(plugin.app, plugin.settings.saveLocation);
	const entries = await Promise.all(
		fetched.notes.map((note, index) =>
			buildImportPlanEntry(plugin, index, note, allowPerNoteSelection, selectionLockedReason, existingKeepNoteIndex)
		)
	);
	const actionableEntries = entries.filter((entry) => entry.selectable);
	const counts = entries.reduce<Record<string, number>>((acc, entry) => {
		acc[entry.label] = (acc[entry.label] ?? 0) + 1;
		return acc;
	}, {});

	return {
		plan: {
			id: `import-plan:${Date.now()}`,
			mode: "import",
			stage: "import",
			generatedAt: Date.now(),
			title: "Review download changes",
			entries,
			counts,
			selectedCount: actionableEntries.length,
			actionableCount: actionableEntries.length,
		},
		notes: fetched.notes,
		noteEntryIds: entries.map((entry) => entry.id),
		completionDate: fetched.completionDate,
	};
}

export async function importSelectedGoogleKeepNotes(
	plugin: KeepSidianPlugin,
	notes: PreNormalizedNote[],
	callbacks?: SyncCallbacks,
	completionDate?: string,
	noteEntryIds?: string[]
): Promise<number> {
	await processAndSaveNotes(plugin, notes, callbacks, noteEntryIds);
	if (completionDate) {
		persistLastSuccessfulSyncDate(plugin, completionDate);
	}
	new Notice("Imported Google Keep notes.");
	return notes.length;
}

async function importGoogleKeepNotesBase(
	plugin: KeepSidianPlugin,
	fetchFunction: (
		offset: number,
		limit: number,
		filters?: SyncFilters,
		cursor?: string
	) => Promise<GoogleKeepImportResponse>,
	callbacks?: SyncCallbacks,
	downloadScope?: DownloadScope
): Promise<number> {
	try {
		const fetched = await fetchImportNotesBase(plugin, fetchFunction, callbacks, downloadScope);
		const imported = await importSelectedGoogleKeepNotes(plugin, fetched.notes, callbacks, fetched.completionDate);
		return imported;
	} catch (error) {
		new Notice("Failed to import notes.");
		throw error;
	}
}

export async function importGoogleKeepNotes(
	plugin: KeepSidianPlugin,
	callbacks?: SyncCallbacks,
	downloadScope?: DownloadScope
): Promise<number> {
	const { email, token } = plugin.settings;
	return await importGoogleKeepNotesBase(
		plugin,
		(offset, limit, filters, cursor) => apiFetchNotes(email, token, offset, limit, filters, cursor),
		callbacks,
		downloadScope
	);
}

export async function importGoogleKeepNotesWithOptions(
	plugin: KeepSidianPlugin,
	options: NoteImportOptions,
	callbacks?: SyncCallbacks,
	downloadScope?: DownloadScope
): Promise<number> {
	const featureFlags = convertOptionsToFeatureFlags(options);
	const { email, token } = plugin.settings;
	return await importGoogleKeepNotesBase(
		plugin,
		(offset, limit, filters, cursor) =>
			apiFetchNotesWithPremium(email, token, featureFlags, offset, limit, filters, cursor),
		callbacks,
		downloadScope
	);
}

export function convertOptionsToFeatureFlags(options: NoteImportOptions): PremiumFeatureFlags {
	const featureFlags: PremiumFeatureFlags = {};

	if (options.includeNotesTerms && options.includeNotesTerms.length > 0) {
		featureFlags.filter_notes = {
			terms: options.includeNotesTerms,
		};
	}

	if (options.excludeNotesTerms && options.excludeNotesTerms.length > 0) {
		featureFlags.skip_notes = {
			terms: options.excludeNotesTerms,
		};
	}

	const keepStateFilter: NonNullable<PremiumFeatureFlags["keep_state_filter"]> = {};
	if (options.includeColors && options.includeColors.length > 0) {
		keepStateFilter.colors = options.includeColors;
	}
	if (options.pinnedStatus && options.pinnedStatus !== "all") {
		keepStateFilter.pinned = options.pinnedStatus;
	}
	if (options.archivedStatus && options.archivedStatus !== "active-only") {
		keepStateFilter.archived = options.archivedStatus;
	}
	if (Object.keys(keepStateFilter).length > 0) {
		featureFlags.keep_state_filter = keepStateFilter;
	}

	if (options.updateTitle) {
		featureFlags.suggest_title = {};
	}

	if (options.suggestTags) {
		featureFlags.suggest_tags = {
			max_tags: options.maxTags || 5,
			restrict_tags: options.limitToExistingTags || false,
			prefix: options.tagPrefix || "auto-",
		};
	}

	return featureFlags;
}

export async function processAndSaveNotes(
	plugin: KeepSidianPlugin,
	notes: PreNormalizedNote[],
	callbacks?: SyncCallbacks,
	noteEntryIds?: string[]
) {
	throwIfSyncCancelled(plugin);
	const batchStartedAt = getNowMs();
	const frontmatterFixStartedAt = getNowMs();
	await ensurePascalCaseFrontmatter(plugin);
	await appendPerfTrace(plugin, "save-batch-frontmatter-fix-complete", {
		durationMs: getNowMs() - frontmatterFixStartedAt,
	});
	const existingIndexStartedAt = getNowMs();
	const existingKeepNoteIndex = await buildExistingKeepNoteIndex(plugin.app, plugin.settings.saveLocation);
	throwIfSyncCancelled(plugin);
	await appendPerfTrace(plugin, "save-batch-index-built", {
		durationMs: getNowMs() - existingIndexStartedAt,
		existingPaths: existingKeepNoteIndex.existingPaths.size,
		indexedKeepUrls: existingKeepNoteIndex.pathByKeepUrl.size,
	});
	const ensuredFolders = new Map<string, Promise<void>>();
	const noteLocks = new Map<string, Promise<void>>();
	const batchMetrics: SaveBatchMetrics = {
		processed: 0,
		totalDurationMs: 0,
		ensureParentFolderDurationMs: 0,
		writeNoteDurationMs: 0,
		attachmentDurationMs: 0,
		duplicateDecisionDurationMs: 0,
		logDurationMs: 0,
	};

	const ensureFolderCached = async (path: string): Promise<void> => {
		const existing = ensuredFolders.get(path);
		if (existing) {
			await existing;
			return;
		}

		const pending = ensureFolder(plugin.app, path).catch((error: unknown) => {
			ensuredFolders.delete(path);
			throw error;
		});
		ensuredFolders.set(path, pending);
		await pending;
	};

	try {
		let nextIndex = 0;
		let fatalError: unknown = null;
		const workerCount = Math.min(NOTE_SAVE_CONCURRENCY, Math.max(notes.length, 1));
		await appendPerfTrace(plugin, "save-batch-start", {
			noteCount: notes.length,
			workerCount,
		});

		const worker = async (): Promise<void> => {
			while (true) {
				if (fatalError) {
					return;
				}
				throwIfSyncCancelled(plugin);

				const index = nextIndex;
				nextIndex += 1;
				if (index >= notes.length) {
					return;
				}

				const note = notes[index];
				const normalizedNote = normalizeNote(note);
				const noteFolder = resolveNoteFolder(plugin.app, plugin.settings, normalizedNote);
				const folderEnsureStartedAt = getNowMs();
				await ensureFolderCached(noteFolder);
				await ensureFolderCached(mediaFolderPath(noteFolder));
				throwIfSyncCancelled(plugin);
				const folderEnsureDurationMs = getNowMs() - folderEnsureStartedAt;
				const entryId = noteEntryIds?.[index];
				const saveKey = normalizePathSafe(resolveNotePath(plugin.app, plugin.settings, normalizedNote));

				try {
					const metrics = await withKeyedLock(noteLocks, saveKey, async () =>
						processAndSaveNote(
							plugin,
							note,
							plugin.settings.saveLocation,
							normalizedNote,
							existingKeepNoteIndex,
							async (filePath: string) => {
								const parent = dirnameSafe(filePath);
								if (!parent) {
									return;
								}
								await ensureFolderCached(parent);
							},
							async (folderPath: string) => {
								await ensureFolderCached(folderPath);
							}
						)
					);
					batchMetrics.processed += 1;
					batchMetrics.totalDurationMs += metrics.totalDurationMs;
					batchMetrics.ensureParentFolderDurationMs += metrics.ensureParentFolderDurationMs;
					batchMetrics.writeNoteDurationMs += metrics.writeNoteDurationMs;
					batchMetrics.attachmentDurationMs += metrics.attachmentDurationMs;
					batchMetrics.duplicateDecisionDurationMs += metrics.duplicateDecisionDurationMs;
					batchMetrics.logDurationMs += metrics.logDurationMs;

					if (metrics.totalDurationMs >= NOTE_PERF_SLOW_THRESHOLD_MS) {
						logInfoIfNotTest(
							`[KeepSidian perf] "${normalizedNote.title}" action=${metrics.action} total=${formatDurationMs(metrics.totalDurationMs)} duplicate=${formatDurationMs(metrics.duplicateDecisionDurationMs)} ensure_parent=${formatDurationMs(metrics.ensureParentFolderDurationMs)} write=${formatDurationMs(metrics.writeNoteDurationMs)} attachments=${formatDurationMs(metrics.attachmentDurationMs)} log=${formatDurationMs(metrics.logDurationMs)}`
						);
					}
					await appendPerfTrace(plugin, "note-save-complete", {
						title: normalizedNote.title,
						action: metrics.action,
						totalDurationMs: metrics.totalDurationMs,
						folderEnsureDurationMs,
						resolveExistingPathDurationMs: metrics.resolveExistingPathDurationMs,
						existsCheckDurationMs: metrics.existsCheckDurationMs,
						duplicateDecisionDurationMs: metrics.duplicateDecisionDurationMs,
						readExistingDurationMs: metrics.readExistingDurationMs,
						ensureParentFolderDurationMs: metrics.ensureParentFolderDurationMs,
						writeNoteDurationMs: metrics.writeNoteDurationMs,
						attachmentDurationMs: metrics.attachmentDurationMs,
						attachmentFetchDurationMs: metrics.attachmentFetchDurationMs,
						attachmentCompareDurationMs: metrics.attachmentCompareDurationMs,
						attachmentWriteDurationMs: metrics.attachmentWriteDurationMs,
						logDurationMs: metrics.logDurationMs,
						unaccountedDurationMs:
							metrics.totalDurationMs -
							(folderEnsureDurationMs +
								metrics.resolveExistingPathDurationMs +
								metrics.existsCheckDurationMs +
								metrics.duplicateDecisionDurationMs +
								metrics.readExistingDurationMs +
								metrics.ensureParentFolderDurationMs +
								metrics.writeNoteDurationMs +
								metrics.attachmentDurationMs +
								metrics.logDurationMs),
					});
					if (batchMetrics.processed % NOTE_PERF_LOG_INTERVAL === 0) {
						logPerformanceSummary("import-progress", batchMetrics);
					}

					callbacks?.reportProgress?.();
					if (entryId) {
						callbacks?.onEntrySettled?.(entryId, true);
					}
				} catch (error: unknown) {
					await appendPerfTrace(plugin, "note-save-failed", {
						title: normalizedNote.title,
						error: error instanceof Error ? error.message : String(error),
					});
					if (!fatalError) {
						fatalError = error;
					}
					if (entryId) {
						callbacks?.onEntrySettled?.(entryId, false);
					}
					return;
				}
			}
		};

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		logPerformanceSummary("import-complete", batchMetrics);
		await appendPerfTrace(plugin, "save-batch-workers-complete", {
			processed: batchMetrics.processed,
			totalDurationMs: getNowMs() - batchStartedAt,
			averageTotalDurationMs: batchMetrics.processed > 0 ? batchMetrics.totalDurationMs / batchMetrics.processed : 0,
		});
		if (fatalError) {
			throw fatalError instanceof Error ? fatalError : new Error("KeepSidian sync failed");
		}
	} finally {
		const flushStartedAt = getNowMs();
		await flushLogSync(plugin, { batchKey: NOTE_LOG_BATCH_KEY });
		await appendPerfTrace(plugin, "save-batch-log-flush-complete", {
			durationMs: getNowMs() - flushStartedAt,
			totalDurationMs: getNowMs() - batchStartedAt,
		});
	}
}

export async function processAndSaveNote(
	plugin: KeepSidianPlugin,
	note: PreNormalizedNote,
	saveLocation: string,
	preNormalizedNote?: ReturnType<typeof normalizeNote>,
	existingKeepNoteIndex?: ExistingKeepNoteIndex,
	ensureParentFolderForPath: (filePath: string) => Promise<void> = async (filePath: string) =>
		await ensureParentFolderForFile(plugin.app, filePath),
	ensureFolderForPath: (folderPath: string) => Promise<void> = async (folderPath: string) =>
		await ensureFolder(plugin.app, folderPath)
): Promise<NoteSaveMetrics> {
	const metrics: NoteSaveMetrics = {
		action: "created",
		totalDurationMs: 0,
		resolveExistingPathDurationMs: 0,
		existsCheckDurationMs: 0,
		duplicateDecisionDurationMs: 0,
		readExistingDurationMs: 0,
		ensureParentFolderDurationMs: 0,
		writeNoteDurationMs: 0,
		attachmentDurationMs: 0,
		attachmentFetchDurationMs: 0,
		attachmentCompareDurationMs: 0,
		attachmentWriteDurationMs: 0,
		logDurationMs: 0,
	};
	const startedAt = getNowMs();
	const normalizedNote = preNormalizedNote ?? normalizeNote(note);
	const noteTitle = normalizedNote.title;
	if (!noteTitle) {
		await logSync(plugin, "Skipped note without a title", NOTE_LOG_BATCH_OPTIONS);
		metrics.action = "skipped";
		metrics.totalDurationMs = getNowMs() - startedAt;
		return metrics;
	}
	const resolvedNotePath = resolveNotePath(plugin.app, plugin.settings, normalizedNote);
	const resolveExistingPathStartedAt = getNowMs();
	let noteFilePath =
		(await findExistingKeepNotePath(
			plugin.app,
			normalizedNote,
			resolvedNotePath,
			existingKeepNoteIndex,
			saveLocation
		)) ?? resolvedNotePath;
	metrics.resolveExistingPathDurationMs = getNowMs() - resolveExistingPathStartedAt;
	const noteLink = `[${noteTitle}](${normalizePathSafe(noteFilePath)})`;
	const noteFolder = dirnameSafe(noteFilePath);

	const lastSyncedDate = new Date().toISOString();
	const ensureParentFolder = async (filePath: string): Promise<void> => {
		metrics.ensureParentFolderDurationMs += await measureAsyncDuration(async () => {
			await ensureParentFolderForPath(filePath);
		});
	};
	const ensureFolderPath = async (folderPath: string): Promise<void> => {
		metrics.ensureParentFolderDurationMs += await measureAsyncDuration(async () => {
			await ensureFolderForPath(folderPath);
		});
	};
	const logNote = async (message: string): Promise<void> => {
		metrics.logDurationMs += await measureAsyncDuration(async () => {
			await logSync(plugin, message, NOTE_LOG_BATCH_OPTIONS);
		});
	};

	try {
		throwIfSyncCancelled(plugin);
		const duplicateDecisionStartedAt = getNowMs();
		const duplicateNotesAction =
			existingKeepNoteIndex &&
			noteFilePath === resolvedNotePath &&
			!existingKeepNoteIndex.existingPaths.has(noteFilePath)
				? "create"
				: await handleDuplicateNotes(saveLocation, normalizedNote, plugin.app, noteFilePath, existingKeepNoteIndex);
		metrics.duplicateDecisionDurationMs = getNowMs() - duplicateDecisionStartedAt;
		const newFrontmatter = normalizedNote.frontmatter;
		const newTextWithoutFrontmatter = normalizedNote.textWithoutFrontmatter;

		if (duplicateNotesAction === "skip") {
			metrics.action = "skipped";
			await logNote(`${noteLink} - identical (skipped)`);
		} else if (duplicateNotesAction === "create") {
			metrics.action = "created";
			const mdFrontmatter = buildFrontmatterWithSyncDate(newFrontmatter, lastSyncedDate);
			const newMdContent = wrapMarkdown(mdFrontmatter, newTextWithoutFrontmatter);
			await ensureParentFolder(noteFilePath);
			const writeStartedAt = getNowMs();
			await plugin.app.vault.adapter.write(noteFilePath, newMdContent);
			metrics.writeNoteDurationMs += getNowMs() - writeStartedAt;
			if (existingKeepNoteIndex) {
				updateExistingKeepNoteIndex(existingKeepNoteIndex, noteFilePath, normalizedNote);
			}
			await logNote(`${noteLink} - new file created`);
		} else {
			const readStartedAt = getNowMs();
			const existingMarkdownFileContentRaw = await plugin.app.vault.adapter.read(noteFilePath);
			metrics.readExistingDurationMs += getNowMs() - readStartedAt;
			const existingMarkdownFileContent =
				typeof existingMarkdownFileContentRaw === "string" ? existingMarkdownFileContentRaw : "";
			const [existingFrontmatter, existingTextWithoutFrontmatterRaw] = extractFrontmatter(existingMarkdownFileContent);
			const existingTextWithoutFrontmatter = stripManagedImageEmbeds(existingTextWithoutFrontmatterRaw);

			const mdFrontmatter = buildFrontmatterWithSyncDate(existingFrontmatter, lastSyncedDate, newFrontmatter);

			if (duplicateNotesAction === "merge") {
				const { mergedText: mergedText, hasConflict } = mergeNoteText(
					existingTextWithoutFrontmatter,
					newTextWithoutFrontmatter
				);

				const mergedMdContent = wrapMarkdown(mdFrontmatter, mergedText);

				if (!hasConflict) {
					metrics.action = "merged";
					await ensureParentFolder(noteFilePath);
					const writeStartedAt = getNowMs();
					await plugin.app.vault.adapter.write(noteFilePath, mergedMdContent);
					metrics.writeNoteDurationMs += getNowMs() - writeStartedAt;
					if (existingKeepNoteIndex) {
						updateExistingKeepNoteIndex(existingKeepNoteIndex, noteFilePath, normalizedNote);
					}
					await logNote(`${noteLink} - merged (no conflict)`);
				} else {
					metrics.action = "conflict";
					// Write a conflict copy
					noteFilePath = noteFilePath.replace(/\.md$/, "");
					noteFilePath = `${noteFilePath}${CONFLICT_FILE_SUFFIX}${lastSyncedDate}.md`;

					await ensureParentFolder(noteFilePath);
					const writeStartedAt = getNowMs();
					await plugin.app.vault.adapter.write(noteFilePath, mergedMdContent);
					metrics.writeNoteDurationMs += getNowMs() - writeStartedAt;
					if (existingKeepNoteIndex) {
						updateExistingKeepNoteIndex(existingKeepNoteIndex, noteFilePath, normalizedNote);
					}
					const conflictLink = `[${noteTitle}](${normalizePathSafe(noteFilePath)})`;
					await logNote(`${conflictLink} - conflict copy created`);
				}
			} else {
				metrics.action = "overwritten";
				const mdContentWithSyncDate = wrapMarkdown(mdFrontmatter, newTextWithoutFrontmatter);

				// overwrite path: write to current path
				await ensureParentFolder(noteFilePath);
				const writeStartedAt = getNowMs();
				await plugin.app.vault.adapter.write(noteFilePath, mdContentWithSyncDate);
				metrics.writeNoteDurationMs += getNowMs() - writeStartedAt;
				if (existingKeepNoteIndex) {
					updateExistingKeepNoteIndex(existingKeepNoteIndex, noteFilePath, normalizedNote);
				}
				await logNote(`${noteLink} - overwritten`);
			}
		}

		if (normalizedNote.blob_urls && normalizedNote.blob_urls.length > 0) {
			throwIfSyncCancelled(plugin);
			if (noteFolder) {
				await ensureFolderPath(mediaFolderPath(noteFolder));
			}
			const {
				downloaded,
				skippedIdentical,
				totalDurationMs = 0,
				fetchDurationMs = 0,
				compareDurationMs = 0,
				writeDurationMs = 0,
				fileNames = [],
			} = await processAttachments(
				plugin.app,
				normalizedNote.blob_urls,
				noteFolder || resolveNoteFolder(plugin.app, plugin.settings, normalizedNote),
				normalizedNote.blob_names,
				{
					email: plugin.settings.email,
					token: plugin.settings.token,
				}
			);
			metrics.attachmentDurationMs += totalDurationMs;
			metrics.attachmentFetchDurationMs += fetchDurationMs;
			metrics.attachmentCompareDurationMs += compareDurationMs;
			metrics.attachmentWriteDurationMs += writeDurationMs;
			if (plugin.settings.embedImportedImages && fileNames.length > 0) {
				const existingNoteContent = await plugin.app.vault.adapter.read(noteFilePath);
				const [existingFrontmatter, existingBody] = extractFrontmatter(existingNoteContent);
				const bodyWithEmbeds = withManagedImageEmbeds(existingBody, fileNames);
				const noteContentWithEmbeds = wrapMarkdown(existingFrontmatter, bodyWithEmbeds);
				if (noteContentWithEmbeds !== existingNoteContent) {
					const writeStartedAt = getNowMs();
					await plugin.app.vault.adapter.write(noteFilePath, noteContentWithEmbeds);
					metrics.writeNoteDurationMs += getNowMs() - writeStartedAt;
				}
			}
			if (downloaded > 0) {
				const attachmentWord = downloaded === 1 ? "attachment" : "attachments";
				const skippedSuffix = skippedIdentical > 0 ? ` (${skippedIdentical} identical skipped)` : "";
				await logNote(`${noteLink} - downloaded ${downloaded} ${attachmentWord}${skippedSuffix}`);
			} else if (skippedIdentical > 0) {
				const skippedWord = skippedIdentical === 1 ? "attachment" : "attachments";
				await logNote(`${noteLink} - attachments up to date (${skippedIdentical} ${skippedWord} identical)`);
			}
		}
	} catch (err: unknown) {
		if (err instanceof SyncCancellationError) {
			throw err;
		}
		const errorMessage = err instanceof Error ? err.message : String(err);
		await flushLogSync(plugin, { batchKey: NOTE_LOG_BATCH_KEY });
		await logSync(plugin, `${noteLink} - error: ${errorMessage}`);
		throw err;
	} finally {
		metrics.totalDurationMs = getNowMs() - startedAt;
	}

	return metrics;
}
