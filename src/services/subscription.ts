import { SubscriptionInfo, SubscriptionCache } from "../types/subscription";
import { Notice } from "obsidian";
import { KEEPSIDIAN_SERVER_URL } from "../config";
import { httpGetJson } from "./http";
import { NetworkError } from "./errors";
import { ACCESS_V1_ENABLED } from "@integrations/google/accessV1Auth";

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

/** Versioned identity excludes caches populated by the former unverified email lookup. */
export function verifiedEmailSubscriptionIdentity(email: string, token: string): string | undefined {
	return ACCESS_V1_ENABLED && email && token ? `verified-email-v1:${email}` : undefined;
}

export function isFreshSubscriptionCache(cache: SubscriptionCache | undefined, identity: string | undefined): boolean {
	const age = cache ? Date.now() - cache.timestamp : NaN;
	return Boolean(
		cache && identity && cache.identity === identity && Number.isFinite(age) && age >= 0 && age < CACHE_DURATION
	);
}

export class SubscriptionService {
	constructor(
		private getEmail: () => string,
		private getCache: () => SubscriptionCache | undefined,
		private setCache: (cache: SubscriptionCache) => Promise<void>,
		private getSupporterKey: () => string | null = () => null,
		private getSupporterKeyIdentity: () => string | undefined = () => undefined,
		private clearCache: () => Promise<void> = async () => undefined,
		private getToken: () => string = () => ""
	) {}

	async checkSubscription(forceRefresh = false): Promise<SubscriptionInfo | null> {
		const email = this.getEmail().trim();
		const supporterKey = this.getSupporterKey();
		const usesSupporterKey = supporterKey !== null;
		const token = usesSupporterKey ? "" : this.getToken();
		if (!usesSupporterKey && !email) {
			return null;
		}

		if (usesSupporterKey && !supporterKey) {
			new Notice("Your saved supporter key could not be read. Re-enter it in KeepSidian settings.");
			return null;
		}

		const identity = this.buildIdentity(email, usesSupporterKey);
		if (!usesSupporterKey && !identity) {
			if (this.getCache()) await this.clearCache();
			return null;
		}

		const cache = this.getCache();
		if (!forceRefresh && isFreshSubscriptionCache(cache, identity)) {
			return cache!.info;
		}

		try {
			const info = await this.fetchSubscriptionInfo(email, supporterKey, forceRefresh, token);
			if (!this.isCurrentIdentity(email, supporterKey, identity, token)) {
				return null;
			}
			await this.cacheInfo(info, identity, email, usesSupporterKey);
			if (!this.isCurrentIdentity(email, supporterKey, identity, token)) {
				return null;
			}
			return info;
		} catch (error) {
			if (!this.isCurrentIdentity(email, supporterKey, identity, token)) {
				return null;
			}
			if (!usesSupporterKey || (error instanceof NetworkError && error.status === 403)) {
				await this.clearCache();
			}
			this.reportSubscriptionError(error, usesSupporterKey);
			return null;
		}
	}

	async validateSupporterKey(supporterKey: string): Promise<SubscriptionInfo> {
		return await this.fetchSubscriptionInfo("", supporterKey, true);
	}

	async primeCurrentCache(info: SubscriptionInfo): Promise<void> {
		const email = this.getEmail().trim();
		const supporterKey = this.getSupporterKey();
		const usesSupporterKey = supporterKey !== null;
		const identity = this.buildIdentity(email, usesSupporterKey);
		if (!usesSupporterKey) return; // Only key validation primes status outside an authenticated request.
		await this.cacheInfo(info, identity, email, usesSupporterKey);
	}

	private buildIdentity(email: string, usesSupporterKey: boolean): string | undefined {
		if (usesSupporterKey) {
			const keyIdentity = this.getSupporterKeyIdentity();
			return keyIdentity ? `supporter-key:${keyIdentity}` : undefined;
		}
		return verifiedEmailSubscriptionIdentity(email, this.getToken());
	}

	private isCurrentIdentity(
		email: string,
		supporterKey: string | null,
		identity: string | undefined,
		token: string
	): boolean {
		const currentEmail = this.getEmail().trim();
		const currentSupporterKey = this.getSupporterKey();
		const currentUsesSupporterKey = currentSupporterKey !== null;
		return (
			currentEmail === email &&
			currentSupporterKey === supporterKey &&
			(currentUsesSupporterKey || this.getToken() === token) &&
			this.buildIdentity(currentEmail, currentUsesSupporterKey) === identity
		);
	}

	private async cacheInfo(
		info: SubscriptionInfo,
		identity: string | undefined,
		email: string,
		usesSupporterKey: boolean
	): Promise<void> {
		if (!identity) {
			return;
		}
		await this.setCache({
			info,
			timestamp: Date.now(),
			identity,
			...(usesSupporterKey ? {} : { email }),
		});
	}

	private async fetchSubscriptionInfo(
		email: string,
		supporterKey: string | null,
		forceRefresh: boolean,
		token = ""
	): Promise<SubscriptionInfo> {
		const refreshQuery = forceRefresh ? "?refresh=true" : "";
		if (supporterKey === null && !verifiedEmailSubscriptionIdentity(email, token)) {
			throw new NetworkError("Verified subscription identity required", 401);
		}
		const path = supporterKey !== null ? "/subscriber/info" : "/keep/subscriber/info";
		const url = `${KEEPSIDIAN_SERVER_URL}${path}${refreshQuery}`;
		const headers: Record<string, string> =
			supporterKey !== null
				? { "X-Supporter-Key": supporterKey }
				: { "X-User-Email": email, Authorization: `Bearer ${token}` };
		return await httpGetJson<SubscriptionInfo>(url, headers);
	}

	private reportSubscriptionError(error: unknown, usesSupporterKey: boolean): void {
		const status = error instanceof NetworkError ? error.status : undefined;
		console.error("Failed to check subscription status", {
			status,
			errorType: error instanceof Error ? error.name : "unknown",
		});
		if (usesSupporterKey && status === 403) {
			new Notice("Your supporter key is invalid. Re-enter it in KeepSidian settings.");
			return;
		}
		if (usesSupporterKey && status === 429) {
			new Notice("Too many supporter key checks. Wait a moment, then try again.");
			return;
		}
		if (usesSupporterKey && status === 503) {
			new Notice("Supporter key checks are temporarily unavailable. Please try again later.");
			return;
		}
		if (!usesSupporterKey && (status === 401 || status === 403 || status === 404)) {
			new Notice(
				"Your subscription could not be verified. Sign in to Google Keep, use a compatible server, or enter a supporter key."
			);
			return;
		}
		new Notice("Failed to check subscription status. Please try again later.");
	}

	async isSubscriptionActive(forceRefresh = false): Promise<boolean> {
		const info = await this.checkSubscription(forceRefresh);
		return info?.subscription_status === "active";
	}
}
