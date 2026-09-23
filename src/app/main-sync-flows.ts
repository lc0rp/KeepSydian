import { Notice } from "obsidian";
import type { DataAdapter } from "obsidian";
import type KeepSidianPlugin from "./main";
import type { NoteImportOptions } from "@ui/modals/NoteImportOptionsModal";
import type { KeepArchivedStatus } from "../types/subscription";
import type { PreNormalizedNote } from "@features/keep/domain/note";
import type { NoteForPush } from "@features/keep/push/collectNotes";
import { HIDDEN_CLASS } from "@app/ui-constants";
import { isSyncCancellationError } from "@app/sync-cancel";
import { startSyncUI, finishSyncUI, setTotalNotes as uiSetTotalNotes, reportSyncProgress } from "@app/sync-ui";
import type { DownloadScope, SyncMode, SyncPlan, SyncPlanAction, SyncPlanStage } from "@types";
import {
	buildImportSyncPlan,
	importGoogleKeepNotes,
	importGoogleKeepNotesWithOptions,
	importSelectedGoogleKeepNotes,
	persistLastSuccessfulSyncDate,
} from "@features/keep/sync";
import { buildPushSyncPlan, pushGoogleKeepNotes } from "@features/keep/push";
import { buildDeletionPlan, type PreparedDeletions } from "@features/keep/deletions";
import { excludeDeletionUploads, getDeletionUploadPaths } from "@features/keep/deletion-upload-exclusions";
import { getDeletionLedger } from "@features/keep/local-deletions/ledger";
import { executeTrackedInboundDeletions } from "@features/keep/local-deletions/inbound";
import { stageIdenticalDownloadReceipts } from "@features/keep/local-deletions/download";
import {
	assertNoUnreviewedLocalDeletions,
	downloadedKeepIdentity,
	executeReviewedLocalDeletions,
	getLocalDeletionProtection,
	type PreparedLocalDeletions,
} from "@features/keep/local-deletions/plan";
import { normalizeMergeAction } from "@features/keep/domain/merge-action";
import { ensureFolder, normalizePathSafe } from "@services/paths";
import { resolveLogBaseFolder } from "@services/note-path-resolver";
import { SyncAttempt } from "@app/sync-attempt";
import { prepareSyncLog } from "@app/logging";

type ErrorMessageResolver = (error: unknown) => string;
const SUPPORTER_LOCK_REASON = "Available to project supporters";

export interface PreparedSyncPlan {
	attempt?: SyncAttempt;
	plan: SyncPlan;
	mode: SyncMode;
	stage: SyncPlanStage;
	importNotes?: PreNormalizedNote[];
	importEntryIds?: string[];
	deletions?: PreparedDeletions;
	localDeletions?: PreparedLocalDeletions;
	deletionContext?: { account: string; scope: string };
	protectedLocalKeepUrls?: string[];
	archivedStatus?: KeepArchivedStatus;
	completionDate?: string;
	pushNotes?: NoteForPush[];
	attachmentWarnings?: number;
	/** Originals preserved by the download phase must never be uploaded by this attempt. */
	unresolvedConflictPaths?: string[];
	/** Clean downloaded merges can contain local additions that still need uploading. */
	forceUploadPaths?: string[];
}

export interface RunPreparedSyncPlanResult {
	nextPlan?: PreparedSyncPlan;
	canceled?: boolean;
	failed?: boolean;
}

export interface SyncPlanBuildCallbacks {
	attempt?: SyncAttempt;
	onAttempt?: (attempt: SyncAttempt) => void;
	validateCredentials?: () => boolean;
	setTotalNotes?: (total: number) => void;
	reportPlanProgress?: (processed: number, total?: number) => void;
	protectedPaths?: readonly string[];
	forceUploadPaths?: readonly string[];
}

export interface SyncPlanRunCallbacks {
	onEntrySettled?: (entryId: string, success: boolean, outcome?: SyncPlanAction) => void;
}

function withPlanMode(plan: SyncPlan, mode: SyncMode): SyncPlan {
	return {
		...plan,
		mode,
		entries: plan.entries.map((entry) => ({ ...entry, mode })),
	};
}

function withPlanEntries(plan: SyncPlan, entries: SyncPlan["entries"]): SyncPlan {
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

function resetProgressIndicatorsForNextStage(plugin: KeepSidianPlugin) {
	plugin.processedNotes = 0;
	plugin.totalNotes = null;
	if (plugin.statusTextEl) plugin.statusTextEl.textContent = "Sync: 0/?";
	if (plugin.progressContainerEl) {
		plugin.progressContainerEl.classList.remove(HIDDEN_CLASS);
		plugin.progressContainerEl.classList.remove("complete", "failed");
		if (!plugin.progressContainerEl.classList.contains("indeterminate")) {
			plugin.progressContainerEl.classList.add("indeterminate");
		}
	}
	plugin.progressBar?.setValue(0);
	plugin.progressModal?.setProgress(0, undefined);
}

function getSuccessfulRunStatus(attachmentWarnings: number) {
	return attachmentWarnings > 0 ? ("warning" as const) : ("success" as const);
}

export async function ensureStoragePathsOrThrow(plugin: KeepSidianPlugin): Promise<void> {
	const saveLocation = resolveLogBaseFolder(plugin.app, plugin.settings);
	try {
		await ensureFolder(plugin.app, saveLocation);
	} catch (error: unknown) {
		new Notice(`KeepSidian: failed to create save location: ${saveLocation}`);
		throw error;
	}
}

async function getManualSupportState(plugin: KeepSidianPlugin): Promise<boolean> {
	const isSupporterActive = await plugin.subscriptionService.isSubscriptionActive();
	(plugin as unknown as { subscriptionActive: boolean | null }).subscriptionActive = isSupporterActive;
	return isSupporterActive;
}

async function assertPreparedDeletionContext(plugin: KeepSidianPlugin, prepared: PreparedSyncPlan): Promise<void> {
	if (!prepared.deletionContext) return;
	const current = await getDeletionLedger(plugin)?.context();
	if (!current || current.account !== prepared.deletionContext.account || current.scope !== prepared.deletionContext.scope) {
		throw new Error("The Google Keep account or sync folder changed. Refresh the review plan before applying it.");
	}
}

async function finishDeletionReceipts(plugin: KeepSidianPlugin, attempt: SyncAttempt): Promise<boolean> {
	const completed = await getDeletionLedger(plugin)?.finishReceipts(attempt.id);
	if (completed === false) {
		new Notice("Notes were processed, but a complete deletion baseline could not be recorded. No new deletion eligibility or successful-sync checkpoint was advanced.");
		return false;
	}
	return true;
}

export async function buildManualSyncPlan(
	plugin: KeepSidianPlugin,
	mode: SyncMode,
	callbacks?: SyncPlanBuildCallbacks,
	downloadScope?: DownloadScope
): Promise<PreparedSyncPlan | null> {
	const attempt = callbacks?.attempt ?? new SyncAttempt(plugin, mode, downloadScope);
	await attempt.start();
	try {
		if (downloadScope) attempt.setScope(downloadScope);
		callbacks?.onAttempt?.(attempt);
		if (attempt.finished) return null;
		if (callbacks?.validateCredentials && !callbacks.validateCredentials()) {
			await attempt.finish("canceled");
			return null;
		}
		await attempt.transition("storage");
		const prepared = await buildManualSyncPlanCore(plugin, mode, { ...callbacks, attempt }, downloadScope);
		if (attempt.finished) return null;
		if (!prepared) {
			await attempt.finish("canceled");
			return null;
		}
		await assertPreparedDeletionContext(plugin, prepared);
		prepared.attempt = attempt;
		await attempt.transition("review");
		return prepared;
	} catch (error) {
		await attempt.fail(error);
		throw error;
	}
}

async function buildManualSyncPlanCore(
	plugin: KeepSidianPlugin,
	mode: SyncMode,
	callbacks: SyncPlanBuildCallbacks,
	downloadScope?: DownloadScope
): Promise<PreparedSyncPlan | null> {
	await ensureStoragePathsOrThrow(plugin);
	await callbacks.attempt?.transition("subscription");
	const isSupporterActive = await getManualSupportState(plugin);
	callbacks.attempt?.setFeatures(isSupporterActive ? plugin.settings.premiumFeatures : undefined);
	const allowPerNoteSelection = isSupporterActive;
	const selectionLockedReason = allowPerNoteSelection ? undefined : SUPPORTER_LOCK_REASON;
	if (mode === "push" || mode === "two-way") {
		const gate = await plugin.requireTwoWaySafeguards();
		if (!gate.allowed) {
			plugin.showTwoWaySafeguardNotice(gate);
			return null;
		}
	}
	const deletionContext = await getDeletionLedger(plugin)?.context();
	if (mode === "push") {
		await callbacks.attempt?.transition("upload-plan");
		const builtPushPlan = await buildPushSyncPlan(plugin, allowPerNoteSelection, selectionLockedReason, {
			reviewMerges: true,
			protectedPaths: callbacks.protectedPaths,
			forcePaths: callbacks.forceUploadPaths,
		});
		return {
			plan: builtPushPlan.plan,
			mode,
			stage: "upload",
			pushNotes: builtPushPlan.notesToPush,
			localDeletions: builtPushPlan.localDeletions,
			deletionContext,
			unresolvedConflictPaths: callbacks.protectedPaths ? [...callbacks.protectedPaths] : undefined,
			forceUploadPaths: callbacks.forceUploadPaths ? [...callbacks.forceUploadPaths] : undefined,
		};
	}
	// This protection is independent of download filters and runs before the
	// download half of two-way sync can recreate a locally removed identity.
	const protectedKeepUrls = await getLocalDeletionProtection(plugin);
	const builtImportPlan = await buildImportSyncPlan(
		plugin,
		isSupporterActive ? plugin.settings.premiumFeatures : undefined,
		allowPerNoteSelection,
		selectionLockedReason,
		callbacks,
		downloadScope
	);
	const deletions = await buildDeletionPlan(plugin);
	const deletionPaths = new Set(deletions.entries.map((entry) => entry.path));
	const identityByEntry = new Map(builtImportPlan.noteEntryIds.map((id, index) => [id, downloadedKeepIdentity(builtImportPlan.notes[index])]));
	// The fresh trash check supersedes any stale import for the same local file.
	const entries = builtImportPlan.plan.entries.filter((entry) => !deletionPaths.has(entry.path)).map((entry) => {
		const identity = identityByEntry.get(entry.id);
		if (!identity || !protectedKeepUrls.has(identity)) return entry;
		return { ...entry, action: "skipped-conflict" as const, label: "Preserved local removal", selectable: false,
			selected: false, selectionLocked: false, meta: { ...entry.meta,
				detail: "This identity is known locally but is absent from the active vault. Review its deletion in the upload plan; this download will not recreate it." } };
	});
	entries.push(...deletions.entries);
	return {
		plan: withPlanMode(withPlanEntries(builtImportPlan.plan, entries), mode),
		mode,
		stage: "import",
		importNotes: builtImportPlan.notes,
		importEntryIds: builtImportPlan.noteEntryIds,
		deletions,
		deletionContext,
		protectedLocalKeepUrls: [...protectedKeepUrls],
		archivedStatus: builtImportPlan.archivedStatus,
		completionDate: builtImportPlan.completionDate,
	};
}

function getSelectedImportNotes(preparedPlan: PreparedSyncPlan): PreNormalizedNote[] {
	const selectedEntryIds = new Set(preparedPlan.plan.entries
		.filter((entry) => entry.action !== "delete" && entry.selectable && entry.selected).map((entry) => entry.id));
	const protectedKeepUrls = new Set(preparedPlan.protectedLocalKeepUrls ?? []);
	const importNotes = preparedPlan.importNotes ?? [];
	const importEntryIds = preparedPlan.importEntryIds ?? [];
	return importNotes.filter((note, index) => {
		const identity = downloadedKeepIdentity(note);
		if (identity && protectedKeepUrls.has(identity)) return false;
		const entryId = importEntryIds[index];
		// Unmapped legacy imports must not recreate a note from a deletion plan.
		return entryId ? selectedEntryIds.has(entryId) : !preparedPlan.deletions?.entries.length && selectedEntryIds.size === 0;
	});
}

function getSelectedPushNotes(preparedPlan: PreparedSyncPlan): NoteForPush[] {
	const plan = excludeDeletionUploads(preparedPlan.plan, preparedPlan.deletions);
	const selectedEntryIds = new Set(plan.entries.filter((entry) => entry.selectable && entry.selected).map((entry) => entry.id));
	const protectedPaths = new Set(preparedPlan.unresolvedConflictPaths ?? []);
	return (preparedPlan.pushNotes ?? []).filter((note, index) =>
		!protectedPaths.has(normalizePathSafe(note.fullPath)) && selectedEntryIds.has(`upload:${index}:${normalizePathSafe(note.fullPath)}`)
	);
}

/** Run both prepared and legacy work through the same terminal-outcome owner. */
async function executeAttempt(
	plugin: KeepSidianPlugin,
	attempt: SyncAttempt,
	work: () => Promise<RunPreparedSyncPlanResult>,
	warnings: () => number,
	beforeSuccess?: () => Promise<void>
): Promise<RunPreparedSyncPlanResult> {
	await attempt.start();
	if (attempt.finished) {
		getDeletionLedger(plugin)?.discardReceipts(attempt.id);
		return { canceled: attempt.outcome !== "failed", failed: attempt.outcome === "failed" };
	}
	try {
		await attempt.transition("storage");
		await ensureStoragePathsOrThrow(plugin);
		if (!(await prepareSyncLog(plugin))) throw new Error("Sync log storage unavailable");
		await getDeletionLedger(plugin)?.beginReceipts(attempt.id);
		plugin.currentSyncMode = attempt.mode;
		plugin.currentSyncPhaseLabel = attempt.mode === "two-way" ? "Download step" : "Syncing";
		startSyncUI(plugin);
		const result = await work();
		if (result.nextPlan) return result;
		plugin.throwIfSyncCancelled?.();
		if (beforeSuccess) await beforeSuccess();
		else await finishDeletionReceipts(plugin, attempt);
		await attempt.finish("success");
		finishSyncUI(plugin, getSuccessfulRunStatus(warnings()), warnings());
		return result;
	} catch (error) {
		getDeletionLedger(plugin)?.discardReceipts(attempt.id);
		await attempt.fail(error);
		const canceled = isSyncCancellationError(error);
		finishSyncUI(plugin, canceled ? "canceled" : "failed");
		return canceled ? { canceled: true } : { failed: true };
	}
}

export async function runPreparedSyncPlan(
	plugin: KeepSidianPlugin,
	preparedPlan: PreparedSyncPlan,
	_getErrorMessage: ErrorMessageResolver,
	onTwoWaySuccess: () => void,
	runCallbacks?: SyncPlanRunCallbacks
): Promise<RunPreparedSyncPlanResult> {
	const attempt = preparedPlan.attempt ?? new SyncAttempt(plugin, preparedPlan.mode);
	preparedPlan.attempt = attempt;
	const mergeAction = normalizeMergeAction(preparedPlan.plan.mergeAction);
	const unresolvedPaths = new Set(preparedPlan.unresolvedConflictPaths ?? []);
	const forceUploadPaths = new Set(preparedPlan.forceUploadPaths ?? []);
	let attachmentWarnings = preparedPlan.attachmentWarnings ?? 0;
	const callbacks = {
		archivedStatus: preparedPlan.archivedStatus ?? "active-only",
		attempt,
		mergeAction,
		onMergeConflict: (path: string) => {
			unresolvedPaths.add(normalizePathSafe(path));
			preparedPlan.unresolvedConflictPaths = [...unresolvedPaths];
		},
		setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
		reportProgress: () => reportSyncProgress(plugin),
		onEntrySettled: (entryId: string, success: boolean, outcome?: SyncPlanAction) => {
			if (success && outcome === "merge" && preparedPlan.stage === "import") {
				const path = preparedPlan.plan.entries.find((entry) => entry.id === entryId)?.path;
				if (path) forceUploadPaths.add(normalizePathSafe(path));
			}
			if (outcome === undefined) runCallbacks?.onEntrySettled?.(entryId, success);
			else runCallbacks?.onEntrySettled?.(entryId, success, outcome);
		},
		onAttachmentWarning: () => { attachmentWarnings += 1; },
	};
	return executeAttempt(plugin, attempt, async () => {
		await assertPreparedDeletionContext(plugin, preparedPlan);
		await attempt.transition(preparedPlan.stage === "import" ? "execution" : "upload");
		if (preparedPlan.stage === "import") {
			const selectedNotes = getSelectedImportNotes(preparedPlan);
			const selectedEntries = preparedPlan.plan.entries.filter((entry) => entry.selectable && entry.selected);
			const selectedEntryIds = selectedEntries.filter((entry) => entry.action !== "delete").map((entry) => entry.id);
			uiSetTotalNotes(plugin, selectedEntries.length);
			await executeTrackedInboundDeletions(plugin, preparedPlan.deletions, new Set(selectedEntries.map((entry) => entry.id)), callbacks);
			if (selectedNotes.length || !preparedPlan.deletions?.entries.length) {
				await importSelectedGoogleKeepNotes(plugin, selectedNotes, callbacks, undefined, selectedEntryIds);
			}
			await stageIdenticalDownloadReceipts(plugin, preparedPlan.importNotes ?? [], preparedPlan.importEntryIds ?? [], preparedPlan.plan.entries);
			if (preparedPlan.mode === "two-way") {
				resetProgressIndicatorsForNextStage(plugin);
				plugin.currentSyncPhaseLabel = "Upload step";
				await attempt.transition("upload-plan");
				const active = await getManualSupportState(plugin);
				const built = await buildPushSyncPlan(plugin, active, active ? undefined : SUPPORTER_LOCK_REASON, {
					reviewMerges: true,
					// Exclude before remote merge review, which rejects linked notes absent from Keep.
					protectedPaths: [...unresolvedPaths, ...getDeletionUploadPaths(preparedPlan.deletions)],
					forcePaths: [...forceUploadPaths],
				});
				const uploadPlan = excludeDeletionUploads(built.plan, preparedPlan.deletions);
				// Conflict-only deletion plans still need a visible review stage.
				if (uploadPlan.actionableCount > 0 || (built.localDeletions?.entries.length ?? 0) > 0) {
					await attempt.transition("review");
					return { nextPlan: {
						attempt,
						plan: { ...withPlanMode(uploadPlan, "two-way"), mergeAction },
						mode: "two-way",
						stage: "upload",
						pushNotes: built.notesToPush,
						deletions: preparedPlan.deletions,
						localDeletions: built.localDeletions,
						deletionContext: preparedPlan.deletionContext,
						protectedLocalKeepUrls: preparedPlan.protectedLocalKeepUrls,
						attachmentWarnings,
						completionDate: preparedPlan.completionDate,
						unresolvedConflictPaths: [...unresolvedPaths],
						forceUploadPaths: [...forceUploadPaths],
					} };
				}
				preparedPlan.localDeletions = built.localDeletions;
			}
		} else {
			plugin.currentSyncPhaseLabel = preparedPlan.mode === "two-way" ? "Upload step" : "Syncing";
			const selectedNotes = getSelectedPushNotes(preparedPlan);
			const selectedEntries = preparedPlan.plan.entries.filter((entry) => entry.selectable && entry.selected);
			const selectedDeletionCount = selectedEntries.filter((entry) => entry.action === "delete").length;
			uiSetTotalNotes(plugin, selectedNotes.length + selectedDeletionCount);
			if (selectedNotes.length || selectedDeletionCount === 0) {
				await pushGoogleKeepNotes(plugin, { ...callbacks, setTotalNotes: (n) => uiSetTotalNotes(plugin, n + selectedDeletionCount) }, selectedNotes);
			}
			await executeReviewedLocalDeletions(plugin, preparedPlan.localDeletions, new Set(selectedEntries.map((entry) => entry.id)), callbacks);
		}
		plugin.throwIfSyncCancelled?.();
		return {};
	}, () => attachmentWarnings, async () => {
		await assertPreparedDeletionContext(plugin, preparedPlan);
		const blocked = unresolvedPaths.size > 0 || preparedPlan.localDeletions?.hasBlockingConflicts ||
			(preparedPlan.mode === "import" && (preparedPlan.protectedLocalKeepUrls?.length ?? 0) > 0);
		if (blocked) {
			getDeletionLedger(plugin)?.discardReceipts(attempt.id);
			new Notice("Conflicts or unverified local removals were preserved. The last successful sync checkpoint has not advanced.");
			return;
		}
		if (!await finishDeletionReceipts(plugin, attempt)) return;
		if (preparedPlan.mode === "two-way") onTwoWaySuccess();
		if (preparedPlan.completionDate) persistLastSuccessfulSyncDate(plugin, preparedPlan.completionDate);
	});
}

export async function runImportWithOptions(plugin: KeepSidianPlugin, options: NoteImportOptions, getErrorMessage: ErrorMessageResolver): Promise<void> {
	await runImportNotesFlow(plugin, false, getErrorMessage, options);
}

export async function runImportNotesFlow(
	plugin: KeepSidianPlugin,
	auto: boolean,
	_getErrorMessage: ErrorMessageResolver,
	options?: NoteImportOptions,
	context?: SyncAttempt
): Promise<void> {
	const attempt = context ?? new SyncAttempt(plugin, "import", undefined, auto ? "scheduled" : "legacy");
	let attachmentWarnings = 0;
	let completionDate: string | undefined;
	await executeAttempt(plugin, attempt, async () => {
		await assertNoUnreviewedLocalDeletions(plugin);
		await attempt.transition("subscription");
		const active = await getManualSupportState(plugin);
		const effectiveOptions = !auto && active ? (options ?? plugin.settings.premiumFeatures) : undefined;
		attempt.setFeatures(effectiveOptions);
		const callbacks = {
			attempt,
			setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
			reportProgress: () => reportSyncProgress(plugin),
			onAttachmentWarning: () => { attachmentWarnings += 1; },
			deferCheckpoint: (date: string) => { completionDate = date; },
		};
		if (effectiveOptions !== undefined) await importGoogleKeepNotesWithOptions(plugin, effectiveOptions, callbacks);
		else await importGoogleKeepNotes(plugin, callbacks);
		return {};
	}, () => attachmentWarnings, async () => {
		if (await finishDeletionReceipts(plugin, attempt) && completionDate) persistLastSuccessfulSyncDate(plugin, completionDate);
	});
}

export async function runPushNotesFlow(plugin: KeepSidianPlugin, _getErrorMessage: ErrorMessageResolver, context?: SyncAttempt): Promise<void> {
	const attempt = context ?? new SyncAttempt(plugin, "push", undefined, "legacy");
	await executeAttempt(plugin, attempt, async () => {
		await attempt.transition("upload");
		await pushGoogleKeepNotes(plugin, {
			attempt,
			setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
			reportProgress: () => reportSyncProgress(plugin),
		});
		return {};
	}, () => 0);
}

export async function runTwoWaySyncFlow(plugin: KeepSidianPlugin, _getErrorMessage: ErrorMessageResolver, onTwoWaySuccess: () => void, context?: SyncAttempt): Promise<void> {
	const attempt = context ?? new SyncAttempt(plugin, "two-way", undefined, "legacy");
	let attachmentWarnings = 0;
	let completionDate: string | undefined;
	await executeAttempt(plugin, attempt, async () => {
		await assertNoUnreviewedLocalDeletions(plugin);
		const callbacks = {
			attempt,
			setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
			reportProgress: () => reportSyncProgress(plugin),
			onAttachmentWarning: () => { attachmentWarnings += 1; },
			deferCheckpoint: (date: string) => { completionDate = date; },
		};
		await importGoogleKeepNotes(plugin, callbacks);
		resetProgressIndicatorsForNextStage(plugin);
		plugin.currentSyncPhaseLabel = "Upload step";
		await attempt.transition("upload");
		await pushGoogleKeepNotes(plugin, callbacks);
		plugin.throwIfSyncCancelled?.();
		return {};
	}, () => attachmentWarnings, async () => {
		if (!await finishDeletionReceipts(plugin, attempt)) return;
		onTwoWaySuccess();
		if (completionDate) persistLastSuccessfulSyncDate(plugin, completionDate);
	});
}

export async function openLatestSyncLogFlow(plugin: KeepSidianPlugin): Promise<void> {
	if (plugin.settings.lastSyncAttempt?.logUnavailable) {
		new Notice(`KeepSidian: sync log unavailable for attempt ${plugin.settings.lastSyncAttempt.id}. Check vault storage permissions.`);
		return;
	}
	const adapter: DataAdapter | null = plugin.app?.vault?.adapter ?? null;
	if (!adapter) {
		new Notice("KeepSidian: unable to open sync log.");
		return;
	}
	let logPath = plugin.lastSyncLogPath;
	const logsFolder = normalizePathSafe(`${resolveLogBaseFolder(plugin.app, plugin.settings)}/_KeepSidianLogs`);
	if (!logPath) {
		if (typeof adapter.list === "function") {
			try {
				const { files } = await adapter.list(logsFolder);
				const markdownFiles = (files ?? []).map((file: string) => {
					const normalized = normalizePathSafe(file);
					return normalized.startsWith(logsFolder) ? normalized : normalizePathSafe(`${logsFolder}/${normalized.split("/").pop()}`);
				}).filter((file: string) => file.toLowerCase().endsWith(".md"));
				if (!markdownFiles.length) {
					new Notice("KeepSidian: no sync logs found.");
					return;
				}
				markdownFiles.sort();
				logPath = markdownFiles[markdownFiles.length - 1];
			} catch {
				new Notice("KeepSidian: failed to open sync log.");
				return;
			}
		} else {
			new Notice("KeepSidian: no sync logs found.");
			return;
		}
	}
	if (!logPath) {
		new Notice("KeepSidian: no sync logs found.");
		return;
	}
	const normalizedPath = normalizePathSafe(logPath);
	plugin.lastSyncLogPath = normalizedPath;
	plugin.settings.lastSyncLogPath = normalizedPath;
	if (typeof plugin.app?.workspace?.openLinkText === "function") {
		void plugin.app.workspace.openLinkText(normalizedPath, "", true);
	} else {
		new Notice("KeepSidian: unable to open sync log.");
	}
}
