import { Notice } from "obsidian";
import type { DataAdapter } from "obsidian";
import type KeepSidianPlugin from "./main";
import type { NoteImportOptions } from "@ui/modals/NoteImportOptionsModal";
import type { PreNormalizedNote } from "@features/keep/domain/note";
import type { NoteForPush } from "@features/keep/push/collectNotes";
import { HIDDEN_CLASS } from "@app/ui-constants";
import { logSync, prepareSyncLog } from "@app/logging";
import { appendPerfTrace } from "@app/perf-trace";
import { isSyncCancellationError } from "@app/sync-cancel";
import { startSyncUI, finishSyncUI, setTotalNotes as uiSetTotalNotes, reportSyncProgress } from "@app/sync-ui";
import type { DownloadScope, SyncMode, SyncPlan, SyncPlanStage } from "@types";
import {
	buildImportSyncPlan,
	importGoogleKeepNotes,
	importGoogleKeepNotesWithOptions,
	importSelectedGoogleKeepNotes,
} from "@features/keep/sync";
import { buildPushSyncPlan, pushGoogleKeepNotes } from "@features/keep/push";
import { ensureFolder, normalizePathSafe } from "@services/paths";
import { resolveLogBaseFolder } from "@services/note-path-resolver";

type ErrorMessageResolver = (error: unknown) => string;
const SUPPORTER_LOCK_REASON = "Available to project supporters";

export interface PreparedSyncPlan {
	plan: SyncPlan;
	mode: SyncMode;
	stage: SyncPlanStage;
	importNotes?: PreNormalizedNote[];
	importEntryIds?: string[];
	completionDate?: string;
	pushNotes?: NoteForPush[];
	attachmentWarnings?: number;
}

export interface RunPreparedSyncPlanResult {
	nextPlan?: PreparedSyncPlan;
	canceled?: boolean;
}

export interface SyncPlanBuildCallbacks {
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

function formatAttachmentWarningSuffix(attachmentWarnings: number): string {
	return attachmentWarnings > 0
		? ` with ${attachmentWarnings} attachment warning${attachmentWarnings === 1 ? "" : "s"}`
		: "";
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
	await ensureStoragePathsOrThrow(plugin);

	const isSupporterActive = await getManualSupportState(plugin);
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

	return {
		plan: withPlanMode(builtImportPlan.plan, mode),
		mode,
		stage: "import",
		importNotes: builtImportPlan.notes,
		importEntryIds: builtImportPlan.noteEntryIds,
		completionDate: builtImportPlan.completionDate,
	};
}

function getSelectedImportNotes(preparedPlan: PreparedSyncPlan): PreNormalizedNote[] {
	const selectedEntryIds = new Set(
		preparedPlan.plan.entries.filter((entry) => entry.selectable && entry.selected).map((entry) => entry.id)
	);
	const importNotes = preparedPlan.importNotes ?? [];
	const importEntryIds = preparedPlan.importEntryIds ?? [];
	return importNotes.filter((_note, index) => {
		const entryId = importEntryIds[index];
		return entryId ? selectedEntryIds.has(entryId) : selectedEntryIds.size === 0;
	});
}

function getSelectedPushNotes(preparedPlan: PreparedSyncPlan): NoteForPush[] {
	const selectedEntryIds = new Set(
		preparedPlan.plan.entries.filter((entry) => entry.selectable && entry.selected).map((entry) => entry.id)
	);
	return (preparedPlan.pushNotes ?? []).filter((note, index) =>
		selectedEntryIds.has(`upload:${index}:${normalizePathSafe(note.fullPath)}`)
	);
}

export async function runPreparedSyncPlan(
	plugin: KeepSidianPlugin,
	preparedPlan: PreparedSyncPlan,
	getErrorMessage: ErrorMessageResolver,
	onTwoWaySuccess: () => void,
	runCallbacks?: SyncPlanRunCallbacks
): Promise<RunPreparedSyncPlanResult> {
	try {
		await ensureStoragePathsOrThrow(plugin);
	} catch {
		return {};
	}

	const logPrepared = await prepareSyncLog(plugin);
	if (!logPrepared) {
		return {};
	}

	if (preparedPlan.stage === "import") {
		const batchOptions = {
			batchSize: 2,
			batchKey: preparedPlan.mode === "two-way" ? "start-2way-sync" : "start-manual-sync",
		};
		await logSync(plugin, `\n\n---\n`, batchOptions);
		await logSync(
			plugin,
			preparedPlan.mode === "two-way" ? "Two-way sync started" : "Manual sync started",
			batchOptions
		);
		plugin.currentSyncMode = preparedPlan.mode;
		plugin.currentSyncPhaseLabel = preparedPlan.mode === "two-way" ? "Download step" : "Syncing";
		startSyncUI(plugin);

		try {
			let attachmentWarnings = 0;
			const selectedNotes = getSelectedImportNotes(preparedPlan);
			const selectedEntryIds = preparedPlan.plan.entries
				.filter((entry) => entry.selectable && entry.selected)
				.map((entry) => entry.id);
			await appendPerfTrace(plugin, "import-run-start", {
				selectedCount: selectedNotes.length,
				actionableCount: preparedPlan.plan.actionableCount,
			});
			const syncCallbacks = {
				setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
				reportProgress: () => reportSyncProgress(plugin),
				onEntrySettled: (entryId: string, success: boolean) => runCallbacks?.onEntrySettled?.(entryId, success),
				onAttachmentWarning: () => {
					attachmentWarnings += 1;
				},
			};
			uiSetTotalNotes(plugin, selectedNotes.length);
			const importStartedAt = Date.now();
			await importSelectedGoogleKeepNotes(
				plugin,
				selectedNotes,
				syncCallbacks,
				preparedPlan.completionDate,
				selectedEntryIds
			);
			await appendPerfTrace(plugin, "import-run-import-complete", {
				durationMs: Date.now() - importStartedAt,
				processedNotes: plugin.processedNotes,
			});
			if (preparedPlan.mode === "two-way") {
				await logSync(plugin, `Two-way sync - import completed. Processed ${plugin.processedNotes} note(s).`);
				resetProgressIndicatorsForNextStage(plugin);
				plugin.currentSyncPhaseLabel = "Upload step";
				await logSync(plugin, `Two-way sync - preparing push review`);
				const isSupporterActive = await getManualSupportState(plugin);
				const allowPerNoteSelection = isSupporterActive;
				const selectionLockedReason = allowPerNoteSelection ? undefined : SUPPORTER_LOCK_REASON;
				const builtPushPlan = await buildPushSyncPlan(plugin, allowPerNoteSelection, selectionLockedReason);
				return {
					nextPlan: {
						plan: withPlanMode(builtPushPlan.plan, "two-way"),
						mode: "two-way",
						stage: "upload",
						pushNotes: builtPushPlan.notesToPush,
						attachmentWarnings,
					},
				};
			}
			const completionLogStartedAt = Date.now();
			await logSync(
				plugin,
				`Manual sync ended - success${formatAttachmentWarningSuffix(attachmentWarnings)}. Processed ${plugin.processedNotes} note(s).`
			);
			await appendPerfTrace(plugin, "import-run-success-log-complete", {
				durationMs: Date.now() - completionLogStartedAt,
			});
			finishSyncUI(plugin, getSuccessfulRunStatus(attachmentWarnings), attachmentWarnings);
			await appendPerfTrace(plugin, "import-run-finish-ui-complete", {
				processedNotes: plugin.processedNotes,
				totalNotes: plugin.totalNotes,
			});
			return {};
		} catch (error: unknown) {
			const errorMessage = getErrorMessage(error);
			if (isSyncCancellationError(error)) {
				finishSyncUI(plugin, "canceled");
				await appendPerfTrace(plugin, "import-run-cancelled", {
					processedNotes: plugin.processedNotes,
				});
				await logSync(
					plugin,
					`${preparedPlan.mode === "two-way" ? "Two-way sync" : "Manual sync"} canceled. Processed ${
						plugin.processedNotes
					} note(s).`
				);
				return { canceled: true };
			}
			finishSyncUI(plugin, "failed");
			await appendPerfTrace(plugin, "import-run-failed", {
				error: errorMessage,
				processedNotes: plugin.processedNotes,
			});
			await logSync(
				plugin,
				`${preparedPlan.mode === "two-way" ? "Two-way sync" : "Manual sync"} ended - failed: ${errorMessage}. Processed ${
					plugin.processedNotes
				} note(s).`
			);
			return {};
		}
	}

	const batchOptions = { batchSize: 2, batchKey: "start-push-sync" };
	await logSync(plugin, `\n\n---\n`, batchOptions);
	await logSync(
		plugin,
		preparedPlan.mode === "two-way" ? "Two-way sync - starting push stage" : "Push sync started",
		batchOptions
	);
	plugin.currentSyncMode = preparedPlan.mode;
	plugin.currentSyncPhaseLabel = preparedPlan.mode === "two-way" ? "Upload step" : "Syncing";
	startSyncUI(plugin);
	try {
		const attachmentWarnings = preparedPlan.attachmentWarnings ?? 0;
		const selectedNotes = getSelectedPushNotes(preparedPlan);
		uiSetTotalNotes(plugin, selectedNotes.length);
		const pushed = await pushGoogleKeepNotes(
			plugin,
			{
				setTotalNotes: (n) => uiSetTotalNotes(plugin, n),
				reportProgress: () => reportSyncProgress(plugin),
				onEntrySettled: (entryId: string, success: boolean) => runCallbacks?.onEntrySettled?.(entryId, success),
			},
			selectedNotes
		);
		await logSync(
			plugin,
			preparedPlan.mode === "two-way"
				? `Two-way sync ended - success${formatAttachmentWarningSuffix(attachmentWarnings)}. Pushed ${pushed} note(s).`
				: `Push sync ended - success. Pushed ${pushed} note(s).`
		);
		finishSyncUI(plugin, getSuccessfulRunStatus(attachmentWarnings), attachmentWarnings);
		if (preparedPlan.mode === "two-way") {
			onTwoWaySuccess();
		}
		return {};
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		if (isSyncCancellationError(error)) {
			finishSyncUI(plugin, "canceled");
			await logSync(
				plugin,
				`${preparedPlan.mode === "two-way" ? "Two-way sync" : "Push sync"} canceled. Processed ${
					plugin.processedNotes
				} note(s).`
			);
			return { canceled: true };
		}
		finishSyncUI(plugin, "failed");
		await logSync(
			plugin,
			`${preparedPlan.mode === "two-way" ? "Two-way sync" : "Push sync"} ended - failed: ${errorMessage}. Processed ${
				plugin.processedNotes
			} note(s).`
		);
		return {};
	}
}

export async function runImportWithOptions(
	plugin: KeepSidianPlugin,
	options: NoteImportOptions,
	getErrorMessage: ErrorMessageResolver
): Promise<void> {
	try {
		await ensureStoragePathsOrThrow(plugin);
	} catch {
		return;
	}

	const logPrepared = await prepareSyncLog(plugin);
	if (!logPrepared) {
		return;
	}

	const batchOptions = {
		batchSize: 2,
		batchKey: "start-manual-sync",
	};
	await logSync(plugin, `\n\n---\n`, batchOptions);
	await logSync(plugin, `Manual sync started`, batchOptions);
	plugin.currentSyncMode = "import";
	startSyncUI(plugin);
	try {
		let attachmentWarnings = 0;
		await importGoogleKeepNotesWithOptions(plugin, options, {
			setTotalNotes: (n) => uiSetTotalNotes(plugin, n),
			reportProgress: () => reportSyncProgress(plugin),
			onAttachmentWarning: () => {
				attachmentWarnings += 1;
			},
		});
		await logSync(
			plugin,
			`Manual sync ended - success${formatAttachmentWarningSuffix(attachmentWarnings)}. Processed ${plugin.processedNotes} note(s).`
		);
		finishSyncUI(plugin, getSuccessfulRunStatus(attachmentWarnings), attachmentWarnings);
	} catch (error: unknown) {
		finishSyncUI(plugin, false);
		await logSync(
			plugin,
			`Manual sync ended - failed: ${getErrorMessage(error)}. Processed ${plugin.processedNotes} note(s).`
		);
	}
}

export async function runImportNotesFlow(
	plugin: KeepSidianPlugin,
	auto: boolean,
	getErrorMessage: ErrorMessageResolver,
	options?: NoteImportOptions
): Promise<void> {
	try {
		const isSubscriptionActive = await plugin.subscriptionService.isSubscriptionActive();
		(plugin as unknown as { subscriptionActive: boolean | null }).subscriptionActive = isSubscriptionActive;

		try {
			await ensureStoragePathsOrThrow(plugin);
		} catch {
			return;
		}

		const logPrepared = await prepareSyncLog(plugin);
		if (!logPrepared) {
			return;
		}

		const batchOptions = { batchSize: 2, batchKey: "start-sync" };
		await logSync(plugin, `\n\n---\n`, batchOptions);
		await logSync(plugin, `${auto ? "Auto" : "Manual"} sync started`, batchOptions);
		plugin.currentSyncMode = "import";
		plugin.currentSyncPhaseLabel = auto ? "Background sync" : "Syncing";
		startSyncUI(plugin);
		try {
			let attachmentWarnings = 0;
			const callbacks = {
				setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
				reportProgress: () => reportSyncProgress(plugin),
				onAttachmentWarning: () => {
					attachmentWarnings += 1;
				},
			};
			if (!auto && isSubscriptionActive) {
				await importGoogleKeepNotesWithOptions(plugin, options ?? plugin.settings.premiumFeatures, callbacks);
			} else {
				await importGoogleKeepNotes(plugin, callbacks);
			}
			await logSync(
				plugin,
				`${auto ? "Auto" : "Manual"} sync ended - success${formatAttachmentWarningSuffix(attachmentWarnings)}. Processed ${
					plugin.processedNotes
				} note(s).`
			);
			finishSyncUI(plugin, getSuccessfulRunStatus(attachmentWarnings), attachmentWarnings);
		} catch (error: unknown) {
			finishSyncUI(plugin, false);
			const errorMessage = getErrorMessage(error);
			await logSync(
				plugin,
				`${auto ? "Auto" : "Manual"} sync ended - failed: ${errorMessage}. Processed ${plugin.processedNotes} note(s).`
			);
		}
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		await logSync(
			plugin,
			`${auto ? "Auto" : "Manual"} sync ended - failed: ${errorMessage}. Processed ${plugin.processedNotes} note(s).`
		);
	}
}

export async function runPushNotesFlow(plugin: KeepSidianPlugin, getErrorMessage: ErrorMessageResolver): Promise<void> {
	try {
		try {
			await ensureStoragePathsOrThrow(plugin);
		} catch {
			return;
		}

		const logPrepared = await prepareSyncLog(plugin);
		if (!logPrepared) {
			return;
		}

		const batchOptions = { batchSize: 2, batchKey: "start-push-sync" };
		await logSync(plugin, `\n\n---\n`, batchOptions);
		await logSync(plugin, `Push sync started`, batchOptions);
		plugin.currentSyncMode = "push";
		plugin.currentSyncPhaseLabel = "Syncing";
		startSyncUI(plugin);
		try {
			const pushed = await pushGoogleKeepNotes(plugin, {
				setTotalNotes: (n) => uiSetTotalNotes(plugin, n),
				reportProgress: () => reportSyncProgress(plugin),
			});
			await logSync(plugin, `Push sync ended - success. Pushed ${pushed} note(s).`);
			finishSyncUI(plugin, true);
		} catch (error: unknown) {
			finishSyncUI(plugin, false);
			const errorMessage = getErrorMessage(error);
			await logSync(plugin, `Push sync ended - failed: ${errorMessage}. Processed ${plugin.processedNotes} note(s).`);
		}
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		await logSync(plugin, `Push sync ended - failed: ${errorMessage}. Processed ${plugin.processedNotes} note(s).`);
	}
}

export async function runTwoWaySyncFlow(
	plugin: KeepSidianPlugin,
	getErrorMessage: ErrorMessageResolver,
	onTwoWaySuccess: () => void
): Promise<void> {
	try {
		try {
			await ensureStoragePathsOrThrow(plugin);
		} catch {
			return;
		}

		const logPrepared = await prepareSyncLog(plugin);
		if (!logPrepared) {
			return;
		}

		const batchOptions = {
			batchSize: 2,
			batchKey: "start-2way-sync",
		};
		await logSync(plugin, `\n\n---\n`, batchOptions);
		await logSync(plugin, `Two-way sync started`, batchOptions);
		plugin.currentSyncMode = "two-way";
		plugin.currentSyncPhaseLabel = "Download step";
		startSyncUI(plugin);
		let attachmentWarnings = 0;
		const callbacks = {
			setTotalNotes: (n: number) => uiSetTotalNotes(plugin, n),
			reportProgress: () => reportSyncProgress(plugin),
			onAttachmentWarning: () => {
				attachmentWarnings += 1;
			},
		};

		let importProcessed = 0;
		try {
			await importGoogleKeepNotes(plugin, callbacks);
			importProcessed = plugin.processedNotes;
			await logSync(plugin, `Two-way sync - import completed. Processed ${importProcessed} note(s).`);
		} catch (error: unknown) {
			finishSyncUI(plugin, false);
			const errorMessage = getErrorMessage(error);
			await logSync(
				plugin,
				`Two-way sync ended - import failed: ${errorMessage}. Processed ${plugin.processedNotes} note(s).`
			);
			return;
		}

		resetProgressIndicatorsForNextStage(plugin);
		plugin.currentSyncPhaseLabel = "Upload step";
		await logSync(plugin, `Two-way sync - starting push stage`);

		try {
			const pushed = await pushGoogleKeepNotes(plugin, callbacks);
			await logSync(
				plugin,
				`Two-way sync ended - success${formatAttachmentWarningSuffix(attachmentWarnings)}. Imported ${importProcessed} note(s), pushed ${pushed} note(s).`
			);
			finishSyncUI(plugin, getSuccessfulRunStatus(attachmentWarnings), attachmentWarnings);
			onTwoWaySuccess();
		} catch (error: unknown) {
			finishSyncUI(plugin, false);
			const errorMessage = getErrorMessage(error);
			await logSync(
				plugin,
				`Two-way sync ended - push failed: ${errorMessage}. Processed ${plugin.processedNotes} note(s).`
			);
		}
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		await logSync(plugin, `Two-way sync ended - failed: ${errorMessage}. Processed ${plugin.processedNotes} note(s).`);
	}
}

export async function openLatestSyncLogFlow(plugin: KeepSidianPlugin): Promise<void> {
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
