import { Notice } from "obsidian";
import type { DataAdapter } from "obsidian";
import type KeepSidianPlugin from "./main";
import type { NoteImportOptions } from "@ui/modals/NoteImportOptionsModal";
import type { PreNormalizedNote } from "@features/keep/domain/note";
import type { NoteForPush } from "@features/keep/push/collectNotes";
import { HIDDEN_CLASS } from "@app/ui-constants";
import { isSyncCancellationError } from "@app/sync-cancel";
import { startSyncUI, finishSyncUI, setTotalNotes as uiSetTotalNotes, reportSyncProgress } from "@app/sync-ui";
import type { DownloadScope, SyncMode, SyncPlan, SyncPlanStage } from "@types";
import {
	buildImportSyncPlan,
	importGoogleKeepNotes,
	importGoogleKeepNotesWithOptions,
	importSelectedGoogleKeepNotes,
	persistLastSuccessfulSyncDate,
} from "@features/keep/sync";
import { buildDeletionPlan, executeReviewedDeletions, type PreparedDeletions } from "@features/keep/deletions";
import { excludeDeletionUploads } from "@features/keep/deletion-upload-exclusions";
import { buildPushSyncPlan, pushGoogleKeepNotes } from "@features/keep/push";
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
	completionDate?: string;
	pushNotes?: NoteForPush[];
	attachmentWarnings?: number;
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
}

export interface SyncPlanRunCallbacks {
	onEntrySettled?: (entryId: string, success: boolean) => void;
}

function withPlanMode(plan: SyncPlan, mode: SyncMode): SyncPlan {
	return {
		...plan,
		mode,
		entries: plan.entries.map((entry) => ({
			...entry,
			mode,
		})),
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
	if (plugin.statusTextEl) {
		plugin.statusTextEl.textContent = "Sync: 0/?";
	}
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

	if (mode === "push") {
		await callbacks.attempt?.transition("upload-plan");
		const builtPushPlan = await buildPushSyncPlan(plugin, allowPerNoteSelection, selectionLockedReason);
		return {
			plan: builtPushPlan.plan,
			mode,
			stage: "upload",
			pushNotes: builtPushPlan.notesToPush,
		};
	}

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
	// The trash check is newer than the paginated note snapshot. Never present
	// both an import and a deletion for the same file in one reviewed plan.
	const entries = builtImportPlan.plan.entries.filter((entry) => !deletionPaths.has(entry.path));
	entries.push(...deletions.entries);

	return {
		plan: withPlanMode(withPlanEntries(builtImportPlan.plan, entries), mode),
		mode,
		stage: "import",
		importNotes: builtImportPlan.notes,
		importEntryIds: builtImportPlan.noteEntryIds,
		deletions,
		completionDate: builtImportPlan.completionDate,
	};
}

function getSelectedImportNotes(preparedPlan: PreparedSyncPlan): PreNormalizedNote[] {
	const selectedEntryIds = new Set(
		preparedPlan.plan.entries
			.filter((entry) => entry.action !== "delete" && entry.selectable && entry.selected)
			.map((entry) => entry.id)
	);
	const importNotes = preparedPlan.importNotes ?? [];
	const importEntryIds = preparedPlan.importEntryIds ?? [];
	return importNotes.filter((_note, index) => {
		const entryId = importEntryIds[index];
		// Legacy plans may omit the mapping, but a deletion plan must never import
		// an unmapped snapshot that could recreate a note the user just deleted.
		return entryId
			? selectedEntryIds.has(entryId)
			: !preparedPlan.deletions?.entries.length && selectedEntryIds.size === 0;
	});
}

function getSelectedPushNotes(preparedPlan: PreparedSyncPlan): NoteForPush[] {
	const plan = excludeDeletionUploads(preparedPlan.plan, preparedPlan.deletions);
	const selectedEntryIds = new Set(
		plan.entries.filter((entry) => entry.selectable && entry.selected).map((entry) => entry.id)
	);
	return (preparedPlan.pushNotes ?? []).filter((note, index) =>
		selectedEntryIds.has(`upload:${index}:${normalizePathSafe(note.fullPath)}`)
	);
}

/** Run both prepared and legacy work through the same terminal-outcome owner. */
async function executeAttempt(
	plugin: KeepSidianPlugin,
	attempt: SyncAttempt,
	work: () => Promise<RunPreparedSyncPlanResult>,
	warnings: () => number
): Promise<RunPreparedSyncPlanResult> {
	await attempt.start();
	if (attempt.finished) return { canceled: attempt.outcome !== "failed", failed: attempt.outcome === "failed" };
	try {
		await attempt.transition("storage");
		await ensureStoragePathsOrThrow(plugin);
		if (!(await prepareSyncLog(plugin))) throw new Error("Sync log storage unavailable");
		plugin.currentSyncMode = attempt.mode;
		plugin.currentSyncPhaseLabel = attempt.mode === "two-way" ? "Download step" : "Syncing";
		startSyncUI(plugin);
		const result = await work();
		if (result.nextPlan) return result;
		await attempt.finish("success");
		finishSyncUI(plugin, getSuccessfulRunStatus(warnings()), warnings());
		return result;
	} catch (error) {
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
	let attachmentWarnings = preparedPlan.attachmentWarnings ?? 0;
	const callbacks = {
		attempt,
		setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
		reportProgress: () => reportSyncProgress(plugin),
		onEntrySettled: (entryId: string, success: boolean) => runCallbacks?.onEntrySettled?.(entryId, success),
		onAttachmentWarning: () => {
			attachmentWarnings += 1;
		},
	};
	return executeAttempt(
		plugin,
		attempt,
		async () => {
			await attempt.transition(preparedPlan.stage === "import" ? "execution" : "upload");
			if (preparedPlan.stage === "import") {
				const selectedNotes = getSelectedImportNotes(preparedPlan);
				const selectedEntries = preparedPlan.plan.entries.filter((entry) => entry.selectable && entry.selected);
				const selectedEntryIds = selectedEntries.filter((entry) => entry.action !== "delete").map((entry) => entry.id);
				uiSetTotalNotes(plugin, selectedEntries.length);
				await executeReviewedDeletions(
					plugin, preparedPlan.deletions, new Set(selectedEntries.map((entry) => entry.id)), callbacks
				);
				// Commit the checkpoint only after the entire attempt succeeds, including a later upload stage.
				if (selectedNotes.length || !preparedPlan.deletions?.entries.length) {
					await importSelectedGoogleKeepNotes(plugin, selectedNotes, callbacks, undefined, selectedEntryIds);
				}
				if (preparedPlan.mode === "two-way") {
					resetProgressIndicatorsForNextStage(plugin);
					plugin.currentSyncPhaseLabel = "Upload step";
					await attempt.transition("upload-plan");
					const active = await getManualSupportState(plugin);
					const built = await buildPushSyncPlan(plugin, active, active ? undefined : SUPPORTER_LOCK_REASON);
					const uploadPlan = excludeDeletionUploads(built.plan, preparedPlan.deletions);
					await attempt.transition("review");
					return {
						nextPlan: {
							attempt,
							plan: withPlanMode(uploadPlan, "two-way"),
							mode: "two-way",
							stage: "upload",
							pushNotes: built.notesToPush,
							deletions: preparedPlan.deletions,
							attachmentWarnings,
							completionDate: preparedPlan.completionDate,
						},
					};
				}
			} else {
				plugin.currentSyncPhaseLabel = preparedPlan.mode === "two-way" ? "Upload step" : "Syncing";
				const selectedNotes = getSelectedPushNotes(preparedPlan);
				uiSetTotalNotes(plugin, selectedNotes.length);
				await pushGoogleKeepNotes(plugin, callbacks, selectedNotes);
				if (preparedPlan.mode === "two-way") onTwoWaySuccess();
			}
			plugin.throwIfSyncCancelled?.();
			if (preparedPlan.completionDate) persistLastSuccessfulSyncDate(plugin, preparedPlan.completionDate);
			return {};
		},
		() => attachmentWarnings
	);
}

export async function runImportWithOptions(
	plugin: KeepSidianPlugin,
	options: NoteImportOptions,
	getErrorMessage: ErrorMessageResolver
): Promise<void> {
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
	await executeAttempt(
		plugin,
		attempt,
		async () => {
			await attempt.transition("subscription");
			const active = await getManualSupportState(plugin);
			const effectiveOptions = !auto && active ? (options ?? plugin.settings.premiumFeatures) : undefined;
			attempt.setFeatures(effectiveOptions);
			const callbacks = {
				attempt,
				setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
				reportProgress: () => reportSyncProgress(plugin),
				onAttachmentWarning: () => {
					attachmentWarnings += 1;
				},
			};
			if (effectiveOptions !== undefined) await importGoogleKeepNotesWithOptions(plugin, effectiveOptions, callbacks);
			else await importGoogleKeepNotes(plugin, callbacks);
			return {};
		},
		() => attachmentWarnings
	);
}

export async function runPushNotesFlow(
	plugin: KeepSidianPlugin,
	_getErrorMessage: ErrorMessageResolver,
	context?: SyncAttempt
): Promise<void> {
	const attempt = context ?? new SyncAttempt(plugin, "push", undefined, "legacy");
	await executeAttempt(
		plugin,
		attempt,
		async () => {
			await attempt.transition("upload");
			await pushGoogleKeepNotes(plugin, {
				attempt,
				setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
				reportProgress: () => reportSyncProgress(plugin),
			});
			return {};
		},
		() => 0
	);
}

export async function runTwoWaySyncFlow(
	plugin: KeepSidianPlugin,
	_getErrorMessage: ErrorMessageResolver,
	onTwoWaySuccess: () => void,
	context?: SyncAttempt
): Promise<void> {
	const attempt = context ?? new SyncAttempt(plugin, "two-way", undefined, "legacy");
	let attachmentWarnings = 0;
	let completionDate: string | undefined;
	await executeAttempt(
		plugin,
		attempt,
		async () => {
			const callbacks = {
				attempt,
				setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
				reportProgress: () => reportSyncProgress(plugin),
				onAttachmentWarning: () => {
					attachmentWarnings += 1;
				},
				deferCheckpoint: (date: string) => {
					completionDate = date;
				},
			};
			await importGoogleKeepNotes(plugin, callbacks);
			resetProgressIndicatorsForNextStage(plugin);
			plugin.currentSyncPhaseLabel = "Upload step";
			await attempt.transition("upload");
			await pushGoogleKeepNotes(plugin, callbacks);
			onTwoWaySuccess();
			plugin.throwIfSyncCancelled?.();
			if (completionDate) persistLastSuccessfulSyncDate(plugin, completionDate);
			return {};
		},
		() => attachmentWarnings
	);
}

export async function openLatestSyncLogFlow(plugin: KeepSidianPlugin): Promise<void> {
	if (plugin.settings.lastSyncAttempt?.logUnavailable) {
		new Notice(
			`KeepSidian: sync log unavailable for attempt ${plugin.settings.lastSyncAttempt.id}. Check vault storage permissions.`
		);
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
				const markdownFiles = (files ?? [])
					.map((file: string) => {
						const normalized = normalizePathSafe(file);
						return normalized.startsWith(logsFolder)
							? normalized
							: normalizePathSafe(`${logsFolder}/${normalized.split("/").pop()}`);
					})
					.filter((file: string) => file.toLowerCase().endsWith(".md"));
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
