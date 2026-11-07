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
	readonly retryAllowed: boolean = true;
	status?: number;
	retryAfterMs?: number;
	code?: string;
	transportFailure = false;
	constructor(message: string, status?: number, cause?: unknown) {
		super("network", message, cause);
		this.status = status;
	}
}

const ACCESS_V1_ERROR_CODES = new Set([
	"sync_session_expired",
	"sync_cursor_invalid",
	"sync_operation_conflict",
	"sync_snapshot_too_large",
	"sync_capacity",
	"sync_upload_review_requires_supporter",
	"sync_operation_held",
	"enrichment_replay_held",
	"enrichment_replay_pending",
	"enrichment_replay_expired",
	"enrichment_replay_conflict",
	"enrichment_source_changed",
	"access_expired",
	"access_v1_disabled",
	"access_request_failed",
	"access_protocol_required",
	"access_headers_invalid",
	"access_identity_required",
	"access_validation_unavailable",
	"access_configuration_unavailable",
	"invalid_access",
]);

/** Safe HTTP metadata only. Never retain raw bodies, headers or credential causes. Retry eligibility is assigned only by the request boundary. */
export class AccessV1RequestError extends NetworkError {
	retryAllowed = false;
	retryHandled = false;
	responseRejected = false;
	constructor(status?: number, code?: unknown, retryAfterMs?: number) {
		super(
			"Short-lived request failed. Safe reads can be resumed; paid work and writes need review.",
			typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined
		);
		if (typeof code === "string" && ACCESS_V1_ERROR_CODES.has(code)) this.code = code;
		if (Number.isFinite(retryAfterMs) && retryAfterMs! >= 0) this.retryAfterMs = Math.min(retryAfterMs!, 60_000);
	}
}

export class ParseError extends AppError {
	constructor(message: string, cause?: unknown) {
		super("parse", message, cause);
	}
}

export const UPLOAD_PREPARATION_MESSAGES = {
	upload_collection_failed:
		"Local notes or attachments could not be prepared. Check vault access before rebuilding the upload review.",
	upload_review_requires_supporter:
		"A complete archive lookup requires an active supporter entitlement. Verify your supporter access before retrying. No uploads were sent.",
	upload_review_scope_unconfirmed:
		"The server did not confirm the complete archive scope. A compatible server update may be required. No uploads were sent.",
	upload_review_failed: "Remote notes could not be verified for upload review. No uploads were sent.",
	upload_linked_note_unavailable: "A linked Keep note is unavailable. Refresh the download before uploading it.",
	upload_deletion_review_failed: "Folder membership could not be verified for upload review. No uploads were sent.",
} as const;
export type UploadPreparationCode = keyof typeof UPLOAD_PREPARATION_MESSAGES;

/** Fixed diagnostics only; the cause is retained for status classification, never displayed. */
export class UploadPreparationError extends AppError {
	constructor(
		readonly code: UploadPreparationCode,
		cause?: unknown
	) {
		super("unknown", UPLOAD_PREPARATION_MESSAGES[code], cause);
	}
}
