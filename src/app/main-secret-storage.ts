import type { KeepSidianPluginSettings } from "../types/keepsidian-plugin-settings";
import type KeepSidianPlugin from "./main";
import { createSupporterKeyIdentity, SUPPORTER_KEY_SECRET_ID } from "../services/supporter-key";

interface SecretStorageAdapter {
	setSecret: (id: string, secret: string) => void;
	getSecret: (id: string) => string | null;
}

interface SecretReadResult {
	success: boolean;
	value: string | null;
}

export const SYNC_TOKEN_SECRET_ID = "google-sync-token";
export const GDRIVE_TOKEN_SECRET_ID = "google-drive-access-token";
export const GDRIVE_REFRESH_TOKEN_SECRET_ID = "google-drive-refresh-token";

export type SupporterKeyStorageFailure = "unavailable" | "write-failed" | "readback-failed";

export interface SupporterKeyStorageResult {
	success: boolean;
	reason?: SupporterKeyStorageFailure;
}

function getSecretStorage(plugin: KeepSidianPlugin): SecretStorageAdapter | null {
	const candidate = (plugin.app as unknown as { secretStorage?: unknown }).secretStorage;
	if (!candidate || typeof candidate !== "object") {
		return null;
	}
	const storage = candidate as Partial<SecretStorageAdapter>;
	if (typeof storage.setSecret !== "function" || typeof storage.getSecret !== "function") {
		return null;
	}
	return storage as SecretStorageAdapter;
}

function readSecret(plugin: KeepSidianPlugin, secretId: string): SecretReadResult {
	const storage = getSecretStorage(plugin);
	if (!storage) {
		return { success: false, value: null };
	}
	try {
		return { success: true, value: storage.getSecret(secretId) };
	} catch {
		return { success: false, value: null };
	}
}

function getSecret(plugin: KeepSidianPlugin, secretId: string): string | null {
	return readSecret(plugin, secretId).value;
}

function setSecret(plugin: KeepSidianPlugin, secretId: string, value: string): boolean {
	const storage = getSecretStorage(plugin);
	if (!storage) {
		return false;
	}
	try {
		storage.setSecret(secretId, value);
		return true;
	} catch {
		return false;
	}
}

export function isSecretStorageAvailable(plugin: KeepSidianPlugin): boolean {
	return getSecretStorage(plugin) !== null;
}

export function hydrateSupporterKeyFromSecretStorage(plugin: KeepSidianPlugin): boolean {
	plugin.settings.supporterKeySecretId = plugin.settings.supporterKeySecretId || SUPPORTER_KEY_SECRET_ID;
	if (!plugin.settings.supporterKeyConfigured) {
		plugin.settings.supporterKey = undefined;
		return false;
	}

	let changed = false;
	const storedKey = readSecret(plugin, plugin.settings.supporterKeySecretId);
	plugin.settings.supporterKey = storedKey.success ? storedKey.value?.trim() || "" : "";
	if (!plugin.settings.supporterKey) {
		plugin.settings.subscriptionCache = undefined;
		return changed;
	}

	const currentIdentity = createSupporterKeyIdentity(plugin.settings.supporterKey);
	if (plugin.settings.supporterKeyIdentity !== currentIdentity) {
		plugin.settings.supporterKeyIdentity = currentIdentity;
		plugin.settings.subscriptionCache = undefined;
		changed = true;
	}
	return changed;
}

export function storeSupporterKeyInSecretStorage(
	plugin: KeepSidianPlugin,
	supporterKey: string
): SupporterKeyStorageResult {
	if (!getSecretStorage(plugin)) {
		return { success: false, reason: "unavailable" };
	}

	const secretId = plugin.settings.supporterKeySecretId || SUPPORTER_KEY_SECRET_ID;
	const previousKey = readSecret(plugin, secretId);
	if (!previousKey.success) {
		return { success: false, reason: "readback-failed" };
	}
	if (!setSecret(plugin, secretId, supporterKey)) {
		return { success: false, reason: "write-failed" };
	}
	const readback = readSecret(plugin, secretId);
	if (!readback.success || readback.value !== supporterKey) {
		if (previousKey.value !== null) {
			void setSecret(plugin, secretId, previousKey.value);
		}
		return { success: false, reason: "readback-failed" };
	}
	return { success: true };
}

export function clearSupporterKeyFromSecretStorage(plugin: KeepSidianPlugin): SupporterKeyStorageResult {
	if (!getSecretStorage(plugin)) {
		return { success: false, reason: "unavailable" };
	}

	const secretId = plugin.settings.supporterKeySecretId || SUPPORTER_KEY_SECRET_ID;
	const previousKey = readSecret(plugin, secretId);
	if (!previousKey.success) {
		return { success: false, reason: "readback-failed" };
	}
	if (!setSecret(plugin, secretId, "")) {
		return { success: false, reason: "write-failed" };
	}
	const readback = readSecret(plugin, secretId);
	if (!readback.success || (readback.value !== "" && readback.value !== null)) {
		if (previousKey.value !== null) {
			void setSecret(plugin, secretId, previousKey.value);
		}
		return { success: false, reason: "readback-failed" };
	}
	return { success: true };
}

export function hydrateSyncTokenFromSecretStorage(plugin: KeepSidianPlugin): boolean {
	const secretStorage = getSecretStorage(plugin);
	if (!secretStorage) {
		return false;
	}

	let changed = false;
	plugin.settings.syncTokenSecretId = plugin.settings.syncTokenSecretId || SYNC_TOKEN_SECRET_ID;
	const trimmedToken = plugin.settings.token?.trim() ?? "";

	if (trimmedToken.length > 0) {
		if (setSecret(plugin, plugin.settings.syncTokenSecretId, trimmedToken)) {
			plugin.settings.token = trimmedToken;
			changed = true;
		}
	} else {
		const secretToken = getSecret(plugin, plugin.settings.syncTokenSecretId);
		if (typeof secretToken === "string" && secretToken.trim().length > 0) {
			plugin.settings.token = secretToken;
			changed = true;
		}
	}

	return changed;
}

export function hydrateDriveSecretsFromSecretStorage(plugin: KeepSidianPlugin): boolean {
	const secretStorage = getSecretStorage(plugin);
	if (!secretStorage) {
		return false;
	}

	let changed = false;
	plugin.settings.gdriveTokenSecretId = plugin.settings.gdriveTokenSecretId || GDRIVE_TOKEN_SECRET_ID;
	plugin.settings.gdriveRefreshTokenSecretId =
		plugin.settings.gdriveRefreshTokenSecretId || GDRIVE_REFRESH_TOKEN_SECRET_ID;

	const trimmedDriveToken = plugin.settings.gdriveToken?.trim() ?? "";
	if (trimmedDriveToken.length > 0) {
		if (setSecret(plugin, plugin.settings.gdriveTokenSecretId, trimmedDriveToken)) {
			plugin.settings.gdriveToken = trimmedDriveToken;
			changed = true;
		}
	} else {
		const driveToken = getSecret(plugin, plugin.settings.gdriveTokenSecretId);
		if (typeof driveToken === "string" && driveToken.trim().length > 0) {
			plugin.settings.gdriveToken = driveToken;
			changed = true;
		}
	}

	const trimmedRefreshToken = plugin.settings.gdriveRefreshToken?.trim() ?? "";
	if (trimmedRefreshToken.length > 0) {
		if (setSecret(plugin, plugin.settings.gdriveRefreshTokenSecretId, trimmedRefreshToken)) {
			plugin.settings.gdriveRefreshToken = trimmedRefreshToken;
			changed = true;
		}
	} else {
		const refreshToken = getSecret(plugin, plugin.settings.gdriveRefreshTokenSecretId);
		if (typeof refreshToken === "string" && refreshToken.trim().length > 0) {
			plugin.settings.gdriveRefreshToken = refreshToken;
			changed = true;
		}
	}

	return changed;
}

export function persistSensitiveSettingsToSecretStorage(plugin: KeepSidianPlugin): void {
	if (!getSecretStorage(plugin)) {
		return;
	}

	plugin.settings.syncTokenSecretId = plugin.settings.syncTokenSecretId || SYNC_TOKEN_SECRET_ID;
	plugin.settings.gdriveTokenSecretId = plugin.settings.gdriveTokenSecretId || GDRIVE_TOKEN_SECRET_ID;
	plugin.settings.gdriveRefreshTokenSecretId =
		plugin.settings.gdriveRefreshTokenSecretId || GDRIVE_REFRESH_TOKEN_SECRET_ID;

	void setSecret(plugin, plugin.settings.syncTokenSecretId, plugin.settings.token?.trim() ?? "");
	void setSecret(plugin, plugin.settings.gdriveTokenSecretId, plugin.settings.gdriveToken?.trim() ?? "");
	void setSecret(plugin, plugin.settings.gdriveRefreshTokenSecretId, plugin.settings.gdriveRefreshToken?.trim() ?? "");
}

export function buildPersistedSettings(plugin: KeepSidianPlugin): KeepSidianPluginSettings {
	const persistedSettings = {
		...plugin.settings,
	};
	delete persistedSettings.supporterKey;
	if (!getSecretStorage(plugin)) {
		return persistedSettings;
	}
	return {
		...persistedSettings,
		token: "",
		gdriveToken: undefined,
		gdriveRefreshToken: undefined,
	};
}
