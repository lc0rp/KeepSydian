import { Notice } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { KEEPSIDIAN_SERVER_URL } from "../config";
import { NetworkError } from "./errors";
import type { GoogleKeepImportResponse } from "@integrations/server/keepApi";

type Scenario = "drop-first" | "drop-middle" | "drop-final" | "pause-middle" | "expire" | "cancel-backoff";
const enabled =
	process.env.KEEPSIDIAN_RECOVERY_UAT === "true" &&
	/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(KEEPSIDIAN_SERVER_URL);
let scenario: Scenario | undefined;
let remaining = 0;
let responses = 0;
let dropped = 0;
let expired = 0;

function reset(): void {
	scenario = undefined;
	remaining = responses = dropped = expired = 0;
}

export function recoveryUatHeaders(cursor?: string): Record<string, string> {
	if (!enabled || scenario !== "expire" || !cursor || remaining === 0) return {};
	remaining = 0;
	expired += 1;
	new Notice("Recovery testing: expiring this continuation on the local server.");
	return { "X-KeepSidian-UAT-Expire": "1" };
}

/** Discard a real, successful server response. Never fabricate notes or success. */
export function recoveryUatResponse(
	response: GoogleKeepImportResponse,
	offset: number,
	cursor?: string
): GoogleKeepImportResponse {
	if (!enabled || !scenario) return response;
	responses += 1;
	const first = !cursor && offset === 0;
	const middle = !!cursor && !!response.next_cursor;
	const final = response.notes.length > 0 && !response.next_cursor;
	const matched =
		scenario === "drop-first"
			? first
			: scenario === "drop-final"
				? final
				: scenario === "cancel-backoff"
					? first
					: middle;
	if (scenario === "expire" || !remaining || !matched) return response;
	remaining -= 1;
	dropped += 1;
	const error = new NetworkError("Controlled local UAT response loss", 504);
	if (scenario === "cancel-backoff") error.retryAfterMs = 15_000;
	new Notice(
		`Recovery testing: discarded successful response ${dropped}. ${scenario === "cancel-backoff" ? "Cancel now during the 15-second retry wait." : ""}`,
		8000
	);
	throw error;
}

export function registerRecoveryUatCommands(plugin: KeepSidianPlugin): void {
	if (!enabled) return;
	const scenarios: Array<[Scenario, string]> = [
		["drop-first", "Drop first download response once"],
		["drop-middle", "Drop middle download response once"],
		["drop-final", "Drop final download response once"],
		["pause-middle", "Pause download at middle page for resume"],
		["expire", "Expire next download continuation"],
		["cancel-backoff", "Drop first response with 15-second cancel window"],
	];
	for (const [value, label] of scenarios) {
		plugin.addCommand({
			id: `recovery-uat-${value}`,
			name: `Recovery testing: ${label.toLowerCase()}`,
			callback: () => {
				reset();
				scenario = value;
				remaining = value === "pause-middle" ? 3 : 1;
				new Notice(
					`Recovery testing armed: ${label.toLowerCase()}. Start a download preparation; stop at review.`,
					8000
				);
			},
		});
	}
	plugin.addCommand({
		id: "recovery-uat-status",
		name: "Recovery testing: show counters",
		callback: () => {
			new Notice(
				`Recovery testing: ${JSON.stringify({ scenario: scenario ?? "off", responses, dropped, expired, remaining })}`,
				15000
			);
		},
	});
	plugin.addCommand({
		id: "recovery-uat-reset",
		name: "Recovery testing: reset faults",
		callback: () => {
			reset();
			new Notice("Recovery testing faults reset.");
		},
	});
	plugin.register(reset);
}
