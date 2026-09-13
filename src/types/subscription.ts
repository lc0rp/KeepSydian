export type TrialOrPromoDetails = null | Record<string, unknown>;

export interface SubscriptionInfo {
	subscription_status: "active" | "inactive" | "expired";
	plan_details: {
		plan_id: string;
		features: string[];
	};
	metering_info: {
		usage: number;
		limit: number;
	};
	trial_or_promo: TrialOrPromoDetails;
}

export interface SubscriptionCache {
	info: SubscriptionInfo;
	timestamp: number;
	email?: string;
	identity?: string;
}

export interface SubscriptionStatus {
	isActive: boolean;
	expiresAt?: Date;
	plan?: "basic" | "premium";
}

export type KeepPinnedStatus = "all" | "pinned" | "unpinned";
export type KeepArchivedStatus = "active-only" | "archived-only" | "all";

export const KEEP_COLOR_OPTIONS = [
	{ value: "DEFAULT", label: "White", hex: "#f4f3ee" },
	{ value: "RED", label: "Red", hex: "#f28b82" },
	{ value: "ORANGE", label: "Orange", hex: "#fbbc04" },
	{ value: "YELLOW", label: "Yellow", hex: "#fff475" },
	{ value: "GREEN", label: "Green", hex: "#ccff90" },
	{ value: "TEAL", label: "Teal", hex: "#a7ffeb" },
	{ value: "BLUE", label: "Blue", hex: "#cbf0f8" },
	{ value: "CERULEAN", label: "Dark blue", hex: "#aecbfa" },
	{ value: "PURPLE", label: "Purple", hex: "#d7aefb" },
	{ value: "PINK", label: "Pink", hex: "#fdcfe8" },
	{ value: "BROWN", label: "Brown", hex: "#e6c9a8" },
	{ value: "GRAY", label: "Gray", hex: "#e8eaed" },
] as const;

export type KeepColorValue = (typeof KEEP_COLOR_OPTIONS)[number]["value"];

export function getAllKeepColorValues(): KeepColorValue[] {
	return KEEP_COLOR_OPTIONS.map(({ value }) => value);
}

export function getEffectiveKeepColorValues(selectedColors: string[]): KeepColorValue[] {
	const allowed = new Set(selectedColors);
	const allColors = getAllKeepColorValues();
	const normalizedColors = allColors.filter((value) => allowed.has(value));

	if (normalizedColors.length === 0) {
		return allColors;
	}

	return normalizedColors;
}

export function normalizeKeepColorSelection(selectedColors: Iterable<string>): string[] {
	const allowed = new Set(selectedColors);
	const normalizedColors = KEEP_COLOR_OPTIONS.map(({ value }) => value).filter((value) => allowed.has(value));

	if (normalizedColors.length === KEEP_COLOR_OPTIONS.length) {
		return [];
	}

	return normalizedColors;
}

export function formatKeepColorSummary(selectedColors: string[]): string {
	const effectiveColors = getEffectiveKeepColorValues(selectedColors);

	if (effectiveColors.length === KEEP_COLOR_OPTIONS.length) {
		return "All colors";
	}

	if (effectiveColors.length <= 2) {
		return effectiveColors
			.map((value) => KEEP_COLOR_OPTIONS.find((option) => option.value === value)?.label ?? value)
			.join(", ");
	}

	return `${effectiveColors.length} selected`;
}

export interface PremiumFeatureSettings {
	autoSync: boolean;
	syncIntervalMinutes: number;
	includeNotesTerms: string[];
	excludeNotesTerms: string[];
	includeColors: string[];
	pinnedStatus: KeepPinnedStatus;
	archivedStatus: KeepArchivedStatus;
	updateTitle: boolean;
	suggestTags: boolean;
	maxTags: number;
	tagPrefix: string;
	limitToExistingTags: boolean;
}

export const DEFAULT_PREMIUM_FEATURES: PremiumFeatureSettings = {
	autoSync: false,
	syncIntervalMinutes: 5,
	includeNotesTerms: [],
	excludeNotesTerms: [],
	includeColors: [],
	pinnedStatus: "all",
	archivedStatus: "active-only",
	updateTitle: false,
	suggestTags: false,
	maxTags: 5,
	tagPrefix: "",
	limitToExistingTags: false,
};
