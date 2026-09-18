import type KeepSidianPlugin from "@app/main";
import { appendLog } from "../services/logger";
import { ensureFile, normalizePathSafe } from "../services/paths";
import { Notice } from "obsidian";
import { resolveLogBaseFolder } from "@services/note-path-resolver";

interface LogSyncOptions {
	batchKey?: string;
	batchSize?: number;
	/** Report failed persistence to lifecycle callers; legacy callers remain best-effort. */
	strict?: boolean;
}

interface FlushOptions {
	batchKey?: string;
}

type LogQueue = Map<string, string[]>;

const logQueues = new WeakMap<KeepSidianPlugin, LogQueue>();
const logWrites = new WeakMap<KeepSidianPlugin, Promise<void>>();

function getQueue(plugin: KeepSidianPlugin, key: string): string[] {
	let pluginQueues = logQueues.get(plugin);
	if (!pluginQueues) {
		pluginQueues = new Map();
		logQueues.set(plugin, pluginQueues);
	}

	const existing = pluginQueues.get(key);
	if (existing) {
		return existing;
	}

	const queue: string[] = [];
	pluginQueues.set(key, queue);
	return queue;
}

function formatLogLine(message: string): string {
	const now = new Date();
	const hours = String(now.getUTCHours()).padStart(2, "0");
	const minutes = String(now.getUTCMinutes()).padStart(2, "0");
	const currentTime = `${hours}:${minutes}`;
	const raw = `${currentTime} ${message}`;
	const line = raw.trimStart().startsWith("-") ? raw : `- ${raw}`;
	return `${line}\n`;
}

async function writeLogEntries(plugin: KeepSidianPlugin, entries: string[], strict = false): Promise<void> {
	const previous = logWrites.get(plugin) ?? Promise.resolve();
	const pending = previous.catch(() => undefined).then(() => writeLogEntriesNow(plugin, entries, strict));
	logWrites.set(plugin, pending);
	try {
		await pending;
	} finally {
		if (logWrites.get(plugin) === pending) logWrites.delete(plugin);
	}
}

async function writeLogEntriesNow(plugin: KeepSidianPlugin, entries: string[], strict: boolean) {
	if (entries.length === 0) {
		return;
	}

	const logPath = await prepareSyncLog(plugin);
	if (!logPath) {
		if (strict) throw new Error("Sync log unavailable");
		return;
	}

	try {
		const payload = entries.map((entry) => formatLogLine(entry)).join("");
		await appendLog(plugin.app, logPath, payload);
	} catch (e) {
		if (strict) throw e;
		try {
			const isTest =
				typeof process !== "undefined" && (process.env?.NODE_ENV === "test" || !!process.env?.JEST_WORKER_ID);
			if (!isTest) {
				console.error("Failed to write sync log.");
			}
			new Notice("KeepSidian: failed to write sync log.");
		} catch {
			/* empty */
		}
	}
}

async function flushQueue(plugin: KeepSidianPlugin, queue: string[]): Promise<void> {
	if (queue.length === 0) {
		return;
	}
	const entries = queue.splice(0, queue.length);
	await writeLogEntries(plugin, entries);
}

/**
 * Prepare today's sync log file. Shows a Notice on failure and returns null.
 * Returns the normalized log file path on success.
 */
export async function prepareSyncLog(plugin: KeepSidianPlugin): Promise<string | null> {
	const currentDate = new Date().toISOString();
	const syncLogFile = `${currentDate.slice(0, 10)}.md`;
	const logBaseFolder = resolveLogBaseFolder(plugin.app, plugin.settings);
	const logPath = normalizePathSafe(`${logBaseFolder}/_KeepSidianLogs/${syncLogFile}`);

	try {
		await ensureFile(plugin.app, logPath);
		plugin.lastSyncLogPath = logPath;
		plugin.settings.lastSyncLogPath = logPath;
		return logPath;
	} catch {
		// Keep message text aligned with tests/UX expectations
		new Notice(`KeepSidian: Failed to create log file: ${logPath}`);
		return null;
	}
}

export async function logSync(plugin: KeepSidianPlugin, message: string, options: LogSyncOptions = {}): Promise<void> {
	const { batchKey = "default", batchSize } = options;

	if (!batchSize) {
		await writeLogEntries(plugin, [message], options.strict);
		return;
	}

	const queue = getQueue(plugin, batchKey);
	queue.push(message);

	if (queue.length >= batchSize) {
		await flushQueue(plugin, queue);
	}
}

export async function flushLogSync(plugin: KeepSidianPlugin, options: FlushOptions = {}): Promise<void> {
	const { batchKey } = options;
	const pluginQueues = logQueues.get(plugin);
	if (!pluginQueues) {
		return;
	}

	if (batchKey) {
		const queue = pluginQueues.get(batchKey);
		if (!queue) {
			return;
		}
		await flushQueue(plugin, queue);
		return;
	}

	const entries: string[] = [];
	for (const [, queue] of pluginQueues) {
		if (queue.length === 0) {
			continue;
		}
		entries.push(...queue.splice(0, queue.length));
	}

	await writeLogEntries(plugin, entries);
}
