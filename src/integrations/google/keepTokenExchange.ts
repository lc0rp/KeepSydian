import type KeepSidianPlugin from "main";
import { Notice } from "obsidian";
import type { KeepSidianSettingsTab } from "ui/settings/KeepSidianSettingsTab";
import { KEEPSIDIAN_SERVER_URL } from "../../config";
import { httpPostJson } from "../../services/http";
import { logRetrievalWizardEvent } from "./retrievalSessionLogger";

function logErrorIfNotTest(...args: unknown[]) {
	try {
		const isTest =
			typeof process !== "undefined" &&
			(process.env?.NODE_ENV === "test" || !!process.env?.JEST_WORKER_ID);
		if (!isTest) {
			console.error(...args);
		}
	} catch {
		// no-op
	}
}

const redactToken = (token: string): string => {
	if (!token) {
		return "";
	}
	const trimmed = token.trim();
	if (trimmed.length <= 8) {
		return `${trimmed.length === 0 ? "empty" : "short"}-token`;
	}
	const start = trimmed.slice(0, 4);
	const end = trimmed.slice(-4);
	return `${start}…${end}`;
};

const logSessionEvent = (
	level: "info" | "warn" | "error" | "debug",
	message: string,
	metadata: Record<string, unknown> = {}
) => {
	void logRetrievalWizardEvent(level, message, metadata);
};

interface TokenResponse {
	keep_token: string;
	[key: string]: unknown;
}

type TestExchangeHook = (payload: {
	email?: string;
	oauth_token: string;
}) => Promise<TokenResponse | null> | TokenResponse | null;

function isTokenResponse(obj: unknown): obj is TokenResponse {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"keep_token" in obj &&
		typeof (obj as Record<string, unknown>).keep_token === "string"
	);
}

export async function exchangeOauthToken(
	settingsTab: KeepSidianSettingsTab,
	plugin: KeepSidianPlugin,
	oauthToken: string
) {
	try {
		const trimmedToken = oauthToken.trim();
		if (!trimmedToken.startsWith("oauth2_4")) {
			logSessionEvent("warn", "Rejected non-oauth2_4 token exchange attempt", {
				tokenSample: redactToken(trimmedToken),
			});
			throw new Error("OAuth token must start with oauth2_4");
		}
		const testExchangeHook = (
			window as Window & {
				__keepsidianTestExchange?: TestExchangeHook;
			}
		).__keepsidianTestExchange;
		if (typeof testExchangeHook === "function") {
			const result = await testExchangeHook({
				email: plugin.settings.email,
				oauth_token: trimmedToken,
			});
			if (result) {
				if (!isTokenResponse(result)) {
					throw new Error("Invalid test exchange response format");
				}
				plugin.settings.token = result.keep_token;
				await plugin.saveSettings();
				settingsTab.display();
				return;
			}
		}
		logSessionEvent("info", "exchangeOauthToken invoked", {
			email: plugin.settings.email,
			tokenSample: redactToken(trimmedToken),
		});
		try {
			logSessionEvent("debug", "Sending oauth_token to KeepSidian server", {
				endpoint: `${KEEPSIDIAN_SERVER_URL}/register`,
			});
			const parsed = await httpPostJson<TokenResponse, { email: string; oauth_token: string }>(
				`${KEEPSIDIAN_SERVER_URL}/register`,
				{
					email: plugin.settings.email,
					oauth_token: trimmedToken,
				},
				{ "Content-Type": "application/json" }
			);

			if (!isTokenResponse(parsed)) {
				logSessionEvent("error", "Invalid token exchange response shape", {
					responseKeys: Object.keys(parsed ?? {}),
				});
				throw new Error("Invalid response format");
			}

			if (!parsed.keep_token) {
				logSessionEvent("error", "Token exchange response missing keep_token");
				throw new Error("Server response missing keep_token");
			}

			plugin.settings.token = parsed.keep_token;
			await plugin.saveSettings();
			logSessionEvent("info", "Persisted keep_token from exchange", {
				keepTokenSample: redactToken(parsed.keep_token),
			});
			settingsTab.display();
			new Notice("Token exchanged successfully.");
		} catch (e) {
			// Preserve legacy error message shape expected by tests
			if (e instanceof Error && e.message.startsWith("Server returned status")) {
				throw e;
			}
			logSessionEvent("error", "Failed to parse server response during token exchange", {
				errorMessage: e instanceof Error ? e.message : String(e),
			});
			throw new Error(
				`Failed to parse server response: ${e instanceof Error ? e.message : String(e)}`
			);
		}
	} catch (error) {
		logErrorIfNotTest("Error exchanging OAuth token:", error);
		logSessionEvent("error", "Error exchanging OAuth token", {
			errorMessage: error instanceof Error ? error.message : String(error),
		});
		new Notice(
			`Failed to exchange OAuth token: ${error instanceof Error ? error.message : String(error)}`
		);
		throw error;
	}
}
