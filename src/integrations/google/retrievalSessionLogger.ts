import type KeepSidianPlugin from "main";
import { appendLog } from "@services/logger";
import { normalizePathSafe } from "@services/paths";

type LogLevel = "info" | "warn" | "error" | "debug";
type SessionStatus = "success" | "error" | "aborted";

interface SessionState {
	plugin: KeepSidianPlugin;
	logPath: string;
	startedAt: Date;
}
let activeSession: SessionState | null = null;

const pad = (value: number, size = 2) => value.toString().padStart(size, "0");

const formatFileTimestamp = (date: Date) => {
	const year = date.getFullYear();
	const month = pad(date.getMonth() + 1);
	const day = pad(date.getDate());
	const hours = pad(date.getHours());
	const minutes = pad(date.getMinutes());
	const seconds = pad(date.getSeconds());
	const millis = pad(date.getMilliseconds(), 3);
	return `${year}${month}${day}-${hours}${minutes}${seconds}-${millis}`;
};

const shouldLogToConsole = () => {
	try {
		return !(
			typeof process !== "undefined" &&
			(process.env?.NODE_ENV === "test" || !!process.env?.JEST_WORKER_ID)
		);
	} catch {
		return true;
	}
};

const getLogDirectory = (plugin: KeepSidianPlugin) => {
	const configDir = plugin.app?.vault?.configDir;
	const pluginId = plugin.manifest?.id ?? "KeepSidian";
	if (configDir && configDir.length > 0) {
		return normalizePathSafe(`${configDir}/plugins/${pluginId}/logs`);
	}
	return normalizePathSafe(`plugins/${pluginId}/logs`);
};

const serializeMetadata = (metadata?: Record<string, unknown>) => {
	if (!metadata || Object.keys(metadata).length === 0) {
		return "";
	}
	try {
		return ` | ${JSON.stringify(metadata)}`;
	} catch (error) {
		if (shouldLogToConsole()) {
			console.error("Failed to serialize retrieval wizard metadata", error);
		}
		return "";
	}
};

async function writeLine(
	level: LogLevel,
	message: string,
	metadata?: Record<string, unknown>
): Promise<void> {
	if (!activeSession) {
		return;
	}
	const { plugin, logPath } = activeSession;
	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${serializeMetadata(
		metadata
	)}\n`;
	try {
		await appendLog(plugin.app, logPath, line);
	} catch (error) {
		if (shouldLogToConsole()) {
			console.error("Failed to write retrieval wizard log entry", error);
		}
	}
}

export async function startRetrievalWizardSession(
	plugin: KeepSidianPlugin,
	metadata: Record<string, unknown> = {}
): Promise<string | undefined> {
	if (!plugin) {
		return undefined;
	}
	if (activeSession) {
		await writeLine("warn", "Starting new session while previous session active.", {
			previousStartedAt: activeSession.startedAt.toISOString(),
		});
		await endRetrievalWizardSession("aborted", {
			reason: "overlapping-session",
		});
	}
	const startedAt = new Date();
	const fileName = `retrieval-session-${formatFileTimestamp(startedAt)}.log`;
	const logDirectory = getLogDirectory(plugin);
	const logPath = normalizePathSafe(`${logDirectory}/${fileName}`);
	activeSession = {
		plugin,
		logPath,
		startedAt,
	};
	await writeLine("info", "Session started", {
		...metadata,
		logPath,
		logDirectory,
		startedAt: startedAt.toISOString(),
	});
	return logPath;
}

export async function logRetrievalWizardEvent(
	level: LogLevel,
	message: string,
	metadata: Record<string, unknown> = {}
): Promise<void> {
	await writeLine(level, message, metadata);
}

export async function endRetrievalWizardSession(
	status: SessionStatus,
	metadata: Record<string, unknown> = {}
): Promise<void> {
	if (!activeSession) {
		return;
	}
	const { startedAt } = activeSession;
	const durationMs = Date.now() - startedAt.getTime();
	await writeLine("info", "Session ended", {
		status,
		durationMs,
		...metadata,
	});
	activeSession = null;
}
