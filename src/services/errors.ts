export type ErrorKind = "network" | "parse" | "io" | "unknown";

export class AppError extends Error {
	kind: ErrorKind;
	cause?: unknown;
	constructor(kind: ErrorKind, message: string, cause?: unknown) {
		super(message);
		this.name = this.constructor.name;
		this.kind = kind;
		this.cause = cause;
	}
}

export class NetworkError extends AppError {
	status?: number;
	retryAfterMs?: number;
	constructor(message: string, status?: number, cause?: unknown) {
		super("network", message, cause);
		this.status = status;
	}
}

export class ParseError extends AppError {
	constructor(message: string, cause?: unknown) {
		super("parse", message, cause);
	}
}

export class IOError extends AppError {
	path?: string;
	constructor(message: string, path?: string, cause?: unknown) {
		super("io", message, cause);
		this.path = path;
	}
}

export function isAppError(err: unknown): err is AppError {
	if (!err || typeof err !== "object") {
		return false;
	}
	const candidate = err as { name?: unknown; message?: unknown; kind?: unknown };
	if (typeof candidate.name !== "string" || typeof candidate.message !== "string") {
		return false;
	}
	return (
		candidate.kind === "network" ||
		candidate.kind === "parse" ||
		candidate.kind === "io" ||
		candidate.kind === "unknown"
	);
}

export function toAppError(err: unknown): AppError {
	if (isAppError(err)) return err;
	if (err instanceof Error) return new AppError("unknown", err.message, err);
	try {
		return new AppError("unknown", String(err));
	} catch {
		return new AppError("unknown", "Unknown error");
	}
}

export function toUserMessage(err: unknown): string {
	const appErr = toAppError(err);
	if (appErr instanceof NetworkError) {
		return appErr.status ? `Network error (status ${appErr.status})` : "Network error";
	}
	if (appErr instanceof ParseError) {
		return "Failed to parse server response";
	}
	if (appErr instanceof IOError) {
		return appErr.path ? `File error at ${appErr.path}` : "File error";
	}
	return appErr.message || "An unexpected error occurred";
}
