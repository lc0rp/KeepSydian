import { Notice } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { normalizePathSafe } from "@services/paths";
import { logSync, flushLogSync } from "@app/logging";
import { SyncCancellationError, isSyncCancellationError } from "@app/sync-cancel";
import { buildFrontmatterWithSyncDate, wrapMarkdown } from "./frontmatter";
import { FRONTMATTER_GOOGLE_KEEP_URL_KEY } from "./constants";
import type { SyncCallbacks } from "./sync";
import { collectNotesToPush, roundDateToSeconds, type NoteForPush } from "./push/collectNotes";
import { pushNotes as apiPushNotes, PushNotePayload, PushNoteResult } from "@integrations/server/keepApi";
import type { SyncPlan, SyncPlanEntry } from "@types";
import { safeSyncError } from "@app/sync-attempt";
import { AppError } from "@services/errors";

const SKIPPED_LOG_BATCH_SIZE = 50;
const PUSH_PAYLOAD_BATCH_SIZE = 20;
const NOTE_LOG_BATCH_SIZE = 20;

function throwIfSyncCancelled(plugin: KeepSidianPlugin): void {
	const cancelablePlugin = plugin as KeepSidianPlugin & {
		throwIfSyncCancelled?: () => void;
	};
	cancelablePlugin.throwIfSyncCancelled?.();
}

function mapResultsByPath(results?: PushNoteResult[]): Map<string, PushNoteResult> {
	const map = new Map<string, PushNoteResult>();
	if (!results) {
		return map;
	}
	for (const result of results) {
		if (!result?.path) {
			continue;
		}
		map.set(normalizePathSafe(result.path), result);
	}
	return map;
}

export interface BuiltPushSyncPlan {
	plan: SyncPlan;
	notesToPush: NoteForPush[];
}

function buildPushPlanEntry(
	note: NoteForPush,
	index: number,
	allowPerNoteSelection: boolean,
	selectionLockedReason?: string
): SyncPlanEntry {
	const attachmentCount = note.updatedAttachmentNames.length;
	const missingAttachmentCount = note.missingAttachments.length;
	const detailParts: string[] = [];

	if (attachmentCount > 0) {
		detailParts.push(
			attachmentCount === 1 ? "Includes 1 updated attachment." : `Includes ${attachmentCount} updated attachments.`
		);
	}
	if (missingAttachmentCount > 0) {
		detailParts.push(
			missingAttachmentCount === 1
				? "1 referenced attachment is missing."
				: `${missingAttachmentCount} referenced attachments are missing.`
		);
	}

	return {
		id: `upload:${index}:${normalizePathSafe(note.fullPath)}`,
		mode: "push",
		stage: "upload",
		title: note.title,
		path: normalizePathSafe(note.fullPath),
		action: "upload",
		label: "Upload",
		selectable: true,
		selected: true,
		selectionLocked: !allowPerNoteSelection,
		selectionLockedReason: !allowPerNoteSelection ? selectionLockedReason : undefined,
		meta: {
			relativePath: note.relativePath,
			attachmentCount,
			missingAttachmentCount,
			missingAttachmentNames: note.missingAttachments,
			detail: detailParts.join(" "),
		},
	};
}

export async function buildPushSyncPlan(
	plugin: KeepSidianPlugin,
	allowPerNoteSelection = true,
	selectionLockedReason?: string
): Promise<BuiltPushSyncPlan> {
	const { notesToPush, skippedNotes } = await collectNotesToPush(plugin);
	const entries: SyncPlanEntry[] = [
		...notesToPush.map((note, index) => buildPushPlanEntry(note, index, allowPerNoteSelection, selectionLockedReason)),
		...skippedNotes.map((skipped, index) => ({
			id: `upload-skipped:${index}:${normalizePathSafe(skipped.path)}`,
			mode: "push" as const,
			stage: "upload" as const,
			title: skipped.path.split("/").pop() || skipped.path,
			path: normalizePathSafe(skipped.path),
			action: skipped.reason === "up-to-date" ? ("skipped-up-to-date" as const) : ("skipped-conflict-copy" as const),
			label: skipped.reason === "up-to-date" ? "Skipped: up to date" : "Skipped: conflict copy",
			selectable: false,
			selected: false,
			selectionLocked: false,
			meta: {
				detail:
					skipped.reason === "up-to-date"
						? "No changes detected since the last sync."
						: "Conflict copies are never uploaded.",
			},
		})),
	];
	const actionableCount = notesToPush.length;
	const counts = entries.reduce<Record<string, number>>((acc, entry) => {
		acc[entry.label] = (acc[entry.label] ?? 0) + 1;
		return acc;
	}, {});

	return {
		plan: {
			id: `push-plan:${Date.now()}`,
			mode: "push",
			stage: "upload",
			generatedAt: Date.now(),
			title: "Review upload changes",
			entries,
			counts,
			selectedCount: actionableCount,
			actionableCount,
		},
		notesToPush,
	};
}

export async function pushGoogleKeepNotes(
	plugin: KeepSidianPlugin,
	callbacks?: SyncCallbacks,
	preparedNotes?: NoteForPush[]
): Promise<number> {
	try {
		throwIfSyncCancelled(plugin);
		const { notesToPush, skippedNotes } = preparedNotes
			? { notesToPush: preparedNotes, skippedNotes: [] }
			: await collectNotesToPush(plugin);

		if (skippedNotes.length > 0) {
			for (const skipped of skippedNotes) {
				const fileName = skipped.path.split("/").pop() || skipped.path;
				const link = callbacks?.attempt
					? `Note (attempt ${callbacks.attempt.id})`
					: `[${fileName}](${normalizePathSafe(skipped.path)})`;
				const message = skipped.reason === "up-to-date" ? "up to date (skipped)" : skipped.reason;
				await logSync(plugin, `${link} - ${message}`, {
					batchKey: "push:skipped",
					batchSize: SKIPPED_LOG_BATCH_SIZE,
				});
			}
			await flushLogSync(plugin, { batchKey: "push:skipped" });
		}

		if (notesToPush.length === 0) {
			new Notice("No Google Keep notes to push.");
			return 0;
		}

		callbacks?.setTotalNotes?.(notesToPush.length);

		const { email, token } = plugin.settings;
		const supporterKey = plugin.settings.supporterKeyConfigured ? (plugin.settings.supporterKey ?? "") : undefined;
		let successCount = 0;
		let firstFailure: Error | undefined;

		for (let index = 0; index < notesToPush.length; index += PUSH_PAYLOAD_BATCH_SIZE) {
			throwIfSyncCancelled(plugin);
			const batch = notesToPush.slice(index, index + PUSH_PAYLOAD_BATCH_SIZE);
			const payloadBatch: PushNotePayload[] = batch.map((note) => ({
				path: note.relativePath,
				title: note.title,
				content: note.content,
				attachments: note.attachments.length > 0 ? note.attachments : undefined,
			}));

			const response = await apiPushNotes(email, token, payloadBatch, supporterKey);
			const resultMap = mapResultsByPath(response?.results);

			const batchKey = "push:notes";
			const batchSize = NOTE_LOG_BATCH_SIZE;
			const batchOptions = { batchKey, batchSize };
			for (const [batchIndex, note] of batch.entries()) {
				throwIfSyncCancelled(plugin);
				const noteLabel = callbacks?.attempt
					? `Note (attempt ${callbacks.attempt.id})`
					: `[${note.title}](${normalizePathSafe(note.fullPath)})`;
				let pushSucceeded = false;
				try {
					const pushTimestamp = roundDateToSeconds(new Date()).toISOString();
					const normalizedPath = normalizePathSafe(note.relativePath);
					const result = resultMap.get(normalizedPath) ?? resultMap.get(note.relativePath);
					if (result && result.success === false) {
						firstFailure ??= new Error("The server rejected an upload");
						await flushLogSync(plugin, { batchKey });
						await logSync(plugin, `${noteLabel} - push failed: server rejected upload`);
						continue;
					}

					// Update Google Keep URL if provided and changed
					if (result?.keep_url) {
						const normalizedKeepUrl = result.keep_url.trim();
						if (normalizedKeepUrl) {
							const keyPrefix = `${FRONTMATTER_GOOGLE_KEEP_URL_KEY}:`;
							const match = note.frontmatter.match(new RegExp(`^${FRONTMATTER_GOOGLE_KEEP_URL_KEY}:\\s*(.*)$`, "m"));
							const existingValue = match?.[1]?.trim();
							if (existingValue !== normalizedKeepUrl) {
								if (match) {
									note.frontmatter = note.frontmatter.replace(
										new RegExp(`^${FRONTMATTER_GOOGLE_KEEP_URL_KEY}:\\s*.*$`, "m"),
										`${keyPrefix} ${normalizedKeepUrl}`
									);
								} else {
									note.frontmatter = note.frontmatter
										? `${note.frontmatter}\n${keyPrefix} ${normalizedKeepUrl}`
										: `${keyPrefix} ${normalizedKeepUrl}`;
								}
							}
						}
					}

					const frontmatterWithSync = buildFrontmatterWithSyncDate(note.frontmatter, pushTimestamp);
					const updatedContent = wrapMarkdown(frontmatterWithSync, note.body);
					await plugin.app.vault.adapter.write(note.fullPath, updatedContent);

					const attachmentSuffix =
						note.updatedAttachmentNames.length > 0
							? ` (updated ${
									note.updatedAttachmentNames.length === 1
										? "1 attachment"
										: `${note.updatedAttachmentNames.length} attachments`
								})`
							: "";

					await logSync(plugin, `${noteLabel} - pushed${attachmentSuffix}`, batchOptions);
					for (const missing of note.missingAttachments) {
						await logSync(
							plugin,
							`${noteLabel} - missing attachment${callbacks?.attempt ? "" : ` ${missing}`}`,
							batchOptions
						);
					}
					successCount += 1;
					pushSucceeded = true;
				} catch (error: unknown) {
					if (error instanceof SyncCancellationError) {
						throw error;
					}
					firstFailure ??= error instanceof Error ? error : new AppError("unknown", "Upload failed", error);
					await flushLogSync(plugin, { batchKey });
					await logSync(plugin, `${noteLabel} - error: ${JSON.stringify(safeSyncError(error))}`);
				} finally {
					callbacks?.onEntrySettled?.(
						`upload:${index + batchIndex}:${normalizePathSafe(note.fullPath)}`,
						pushSucceeded
					);
					callbacks?.reportProgress?.();
				}
			}
			await flushLogSync(plugin, { batchKey: "push:notes" });
		}

		if (callbacks?.attempt && firstFailure !== undefined) throw firstFailure;
		throwIfSyncCancelled(plugin);
		new Notice("Pushed Google Keep notes.");
		return successCount;
	} catch (error: unknown) {
		if (isSyncCancellationError(error)) {
			throw error;
		}
		new Notice("Failed to push notes.");
		throw error;
	}
}
