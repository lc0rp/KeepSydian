import { SubscriptionInfo, SubscriptionCache } from "../types/subscription";
import { Notice } from "obsidian";
import { KEEPSIDIAN_SERVER_URL } from "../config";
import { httpGetJson } from "./http";
import { NetworkError } from "./errors";

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export class SubscriptionService {
	constructor(
		private getEmail: () => string,
		private getCache: () => SubscriptionCache | undefined,
		private setCache: (cache: SubscriptionCache) => Promise<void>,
		private getSupporterKey: () => string | null = () => null,
		private getSupporterKeyIdentity: () => string | undefined = () => undefined,
		private clearCache: () => Promise<void> = async () => undefined
	) {}

	async checkSubscription(forceRefresh = false): Promise<SubscriptionInfo | null> {
		const email = this.getEmail().trim();
		const supporterKey = this.getSupporterKey();
		const usesSupporterKey = supporterKey !== null;
		if (!usesSupporterKey && !email) {
			return null;
		}

		if (usesSupporterKey && !supporterKey) {
			new Notice("Your saved supporter key could not be read. Re-enter it in KeepSidian settings.");
			return null;
		}

		const identity = this.buildIdentity(email, usesSupporterKey);

		const cache = this.getCache();
		if (
			!forceRefresh &&
			cache &&
			this.cacheMatchesIdentity(cache, identity, email, usesSupporterKey) &&
			Date.now() - cache.timestamp < CACHE_DURATION
		) {
			return cache.info;
		}

		try {
			const info = await this.fetchSubscriptionInfo(email, supporterKey, forceRefresh);
			if (!this.isCurrentIdentity(email, supporterKey, identity)) {
				return null;
			}
			await this.cacheInfo(info, identity, email, usesSupporterKey);
			if (!this.isCurrentIdentity(email, supporterKey, identity)) {
				return null;
			}
			return info;
		} catch (error) {
			if (!this.isCurrentIdentity(email, supporterKey, identity)) {
				return null;
			}
			if (usesSupporterKey && error instanceof NetworkError && error.status === 403) {
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
		await this.cacheInfo(info, identity, email, usesSupporterKey);
	}

	private buildIdentity(email: string, usesSupporterKey: boolean): string | undefined {
		if (usesSupporterKey) {
			const keyIdentity = this.getSupporterKeyIdentity();
			return keyIdentity ? `supporter-key:${keyIdentity}` : undefined;
		}
		return email ? `email:${email}` : undefined;
	}

	private cacheMatchesIdentity(
		cache: SubscriptionCache,
		identity: string | undefined,
		email: string,
		usesSupporterKey: boolean
	): boolean {
		if (!identity) {
			return false;
		}
		if (cache.identity) {
			return cache.identity === identity;
		}
		return !usesSupporterKey && cache.email === email;
	}

	private isCurrentIdentity(email: string, supporterKey: string | null, identity: string | undefined): boolean {
		const currentEmail = this.getEmail().trim();
		const currentSupporterKey = this.getSupporterKey();
		const currentUsesSupporterKey = currentSupporterKey !== null;
		return (
			currentEmail === email &&
			currentSupporterKey === supporterKey &&
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
		forceRefresh: boolean
	): Promise<SubscriptionInfo> {
		const refreshQuery = forceRefresh ? "?refresh=true" : "";
		const url = `${KEEPSIDIAN_SERVER_URL}/subscriber/info${refreshQuery}`;
		const headers: Record<string, string> =
			supporterKey !== null ? { "X-Supporter-Key": supporterKey } : { "X-User-Email": email };
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
		new Notice("Failed to check subscription status. Please try again later.");
	}

	async isSubscriptionActive(forceRefresh = false): Promise<boolean> {
		const info = await this.checkSubscription(forceRefresh);
		return info?.subscription_status === "active";
	}
}
