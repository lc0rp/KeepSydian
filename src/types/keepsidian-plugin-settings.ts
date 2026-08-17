import { DEFAULT_PREMIUM_FEATURES, PremiumFeatureSettings, SubscriptionCache } from "./subscription";
import type { TokenHelperManifest } from "./token-helper";

export type SyncMode = "import" | "push" | "two-way";
export type SaveLocationMode = "custom" | "daily-notes";
export type SyncRunStatus = "success" | "failed" | "canceled";

export const LEGACY_SAVE_LOCATION = "/Google Keep";
export const NEW_INSTALL_SAVE_LOCATION = "/KeepSidian";
export const DEFAULT_SAVE_LOCATION_MODE: SaveLocationMode = "custom";
export const DEFAULT_NOTE_FILE_NAME_PATTERN = "{title}";

export interface LastSyncSummary {
	timestamp: number;
	processedNotes: number;
	totalNotes?: number | null;
	success: boolean;
	status?: SyncRunStatus;
	mode: SyncMode;
}

export interface KeepSidianPluginSettings {
	email: string;
	token: string;
	syncTokenSecretId: string;
	saveLocation: string;
	saveLocationMode: SaveLocationMode;
	noteFileNamePattern: string;
	embedImportedImages: boolean;
	oauthFlow: "desktop" | "webviewer";
	oauthDebugMode: boolean;
	oauthPlaywrightUseSystemBrowser: boolean;
	tokenHelperPath?: string;
	tokenHelperVersion?: string;
	tokenHelperLastCheckedAt?: number;
	tokenHelperConsentAcceptedAt?: number;
	tokenHelperLastSeenReleaseId?: number;
	tokenHelperCheckedForPluginVersion?: string;
	tokenHelperCompatibleManifest?: TokenHelperManifest;
	tokenHelperInstalledManifest?: TokenHelperManifest;
	subscriptionCache?: SubscriptionCache;
	premiumFeatures: PremiumFeatureSettings;
	gdriveToken?: string;
	gdriveTokenSecretId: string;
	gdriveRefreshToken?: string;
	gdriveRefreshTokenSecretId: string;
	gdriveSaveLocation?: string;
	autoSyncEnabled: boolean;
	autoSyncIntervalHours: number;
	lastSyncSummary: LastSyncSummary | null;
	lastSyncLogPath?: string | null;
	keepSidianLastSuccessfulSyncDate?: string | null;
	frontmatterPascalCaseFixApplied?: boolean;
	twoWaySyncBackupAcknowledged: boolean;
	twoWaySyncEnabled: boolean;
	twoWaySyncAutoSyncEnabled: boolean;
}

export const DEFAULT_SETTINGS: KeepSidianPluginSettings = {
	email: "",
	token: "",
	syncTokenSecretId: "google-sync-token",
	saveLocation: NEW_INSTALL_SAVE_LOCATION,
	saveLocationMode: DEFAULT_SAVE_LOCATION_MODE,
	noteFileNamePattern: DEFAULT_NOTE_FILE_NAME_PATTERN,
	embedImportedImages: false,
	oauthFlow: "desktop",
	oauthDebugMode: false,
	oauthPlaywrightUseSystemBrowser: true,
	tokenHelperPath: undefined,
	tokenHelperVersion: undefined,
	tokenHelperLastCheckedAt: undefined,
	tokenHelperConsentAcceptedAt: undefined,
	tokenHelperLastSeenReleaseId: undefined,
	tokenHelperCheckedForPluginVersion: undefined,
	tokenHelperCompatibleManifest: undefined,
	tokenHelperInstalledManifest: undefined,
	subscriptionCache: undefined,
	premiumFeatures: DEFAULT_PREMIUM_FEATURES,
	gdriveToken: undefined,
	gdriveTokenSecretId: "google-drive-access-token",
	gdriveRefreshToken: undefined,
	gdriveRefreshTokenSecretId: "google-drive-refresh-token",
	gdriveSaveLocation: undefined,
	autoSyncEnabled: false,
	autoSyncIntervalHours: 24,
	lastSyncSummary: null,
	lastSyncLogPath: null,
	keepSidianLastSuccessfulSyncDate: null,
	frontmatterPascalCaseFixApplied: false,
	twoWaySyncBackupAcknowledged: false,
	twoWaySyncEnabled: false,
	twoWaySyncAutoSyncEnabled: false,
};

export function normalizeRootedVaultPath(value: string): string {
	const trimmedValue = value.trim();
	if (!trimmedValue) {
		return "";
	}

	return trimmedValue.startsWith("/") ? trimmedValue : `/${trimmedValue}`;
}

export function resolveLoadedSettings(
	saved: Partial<KeepSidianPluginSettings> | null | undefined
): KeepSidianPluginSettings {
	const merged = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
	merged.premiumFeatures = {
		...DEFAULT_PREMIUM_FEATURES,
		...(saved?.premiumFeatures ?? {}),
	};

	if (saved && typeof saved.saveLocation === "undefined") {
		merged.saveLocation = LEGACY_SAVE_LOCATION;
	}

	merged.saveLocationMode = DEFAULT_SAVE_LOCATION_MODE;

	if (saved && typeof saved.noteFileNamePattern === "undefined") {
		merged.noteFileNamePattern = DEFAULT_NOTE_FILE_NAME_PATTERN;
	}

	merged.saveLocation = normalizeRootedVaultPath(merged.saveLocation);

	return merged;
}
