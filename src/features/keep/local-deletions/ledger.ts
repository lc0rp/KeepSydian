import type KeepSidianPlugin from "@app/main";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { KEEP_REVISION_PATTERN } from "@integrations/server/keepTrash";
import { normalizeNote, type PreNormalizedNote } from "../domain/note";
import { scanLocalIdentities, type IdentityScan } from "./scan";
import {
	decodeLedger, deletionAccount, deletionScope, encodeLedger, isSafeVaultPath,
	isWithinScope, recordGeneration, sha256, MAX_DELETION_RECORDS,
	type DeletionContext, type DownloadedRevisionReceipt, type LocalDeletionRecord,
	type LocalDeletionState, type StoredDeletionState,
} from "./state";

interface ReceiptSession extends DeletionContext {
	id: string;
	receipts: Map<string, DownloadedRevisionReceipt>;
}
const ledgers = new WeakMap<KeepSidianPlugin, LocalDeletionLedger>();

function sameContext(a: DeletionContext, b: DeletionContext): boolean {
	return a.account === b.account && a.scope === b.scope && a.generation === b.generation;
}

/** Folder membership is proved by complete scans; events only detect instability. */
export class LocalDeletionLedger {
	readonly ready: Promise<void>;
	private state?: StoredDeletionState;
	private diskText?: string;
	private queue: Promise<void> = Promise.resolve();
	private blocked = false;
	private revision = 0;
	private session?: ReceiptSession;
	private invalidatedSession?: string;

	constructor(readonly plugin: KeepSidianPlugin, readonly metadataPath: string) {
		if (!isSafeVaultPath(metadataPath)) throw new Error("Unsafe deletion metadata path.");
		this.ready = this.load().catch(() => { this.blocked = true; });
	}

	private async load(): Promise<void> {
		if (await this.plugin.app.vault.adapter.exists(this.metadataPath)) {
			this.diskText = await this.plugin.app.vault.adapter.read(this.metadataPath);
			this.state = await decodeLedger(this.diskText);
		}
	}

	get generation(): number { return this.revision; }
	changed(): void { this.revision += 1; }

	private async settingsContext(): Promise<{ account: string; scope: string }> {
		const email = this.plugin.settings.email.trim().toLowerCase();
		const scope = deletionScope(this.plugin.settings.saveLocation);
		// Clearing account settings must durably invalidate the old scope too.
		// This empty context has no authenticated receipts or eligible records.
		const account = email ? await deletionAccount(email) : await sha256("keep-unconfigured-account-v2");
		if (email !== this.plugin.settings.email.trim().toLowerCase() || scope !== deletionScope(this.plugin.settings.saveLocation)) {
			throw new Error("The account or sync folder changed while reading membership context.");
		}
		return { account, scope };
	}

	private async verifyDisk(): Promise<void> {
		if (this.blocked) throw new Error("Deletion metadata is unavailable or incomplete. No Keep deletion is authorized.");
		const adapter = this.plugin.app.vault.adapter;
		const exists = await adapter.exists(this.metadataPath);
		if (this.diskText === undefined ? exists : !exists || await adapter.read(this.metadataPath) !== this.diskText) {
			this.blocked = true;
			throw new Error("Deletion metadata changed outside this session. Restart and review before any Keep deletion.");
		}
	}

	async verify(): Promise<void> {
		await this.ready;
		await this.queue;
		await this.verifyDisk();
	}

	private async serialized<T>(work: () => Promise<T>): Promise<T> {
		const operation = this.queue.then(async () => {
			await this.ready;
			await this.verifyDisk();
			return work();
		});
		this.queue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	private async persist(next: LocalDeletionState, guard: () => void = () => undefined): Promise<void> {
		if (next.records.length > MAX_DELETION_RECORDS) throw new Error("Deletion metadata capacity reached; no baseline was advanced.");
		const text = await encodeLedger(next);
		const assertContext = async () => {
			const current = await this.settingsContext();
			if (current.account !== next.account || current.scope !== next.scope) throw new Error("The account or sync folder changed before membership was saved.");
			guard();
		};
		await assertContext();
		if (text === this.diskText) return;
		const previousText = this.diskText;
		const adapter = this.plugin.app.vault.adapter;
		try {
			await adapter.write(this.metadataPath, text);
			if (await adapter.read(this.metadataPath) !== text) throw new Error("Membership write was not confirmed.");
			await assertContext();
		} catch {
			this.blocked = true;
			if (previousText !== undefined) {
				try { await adapter.write(this.metadataPath, previousText); } catch { /* Remain blocked. */ }
			}
			throw new Error("Deletion metadata could not be confirmed. No baseline or checkpoint was advanced.");
		}
		this.state = next;
		this.diskText = text;
	}

	/** Persist scope changes even when settings later return to the old folder. */
	async refreshContext(): Promise<DeletionContext> {
		return this.serialized(async () => {
			const current = await this.settingsContext();
			if (this.state?.version === 2 && this.state.account === current.account && this.state.scope === current.scope) {
				return { ...current, generation: this.state.generation };
			}
			const records: LocalDeletionRecord[] = [];
			if (this.state?.version === 1 && this.state.account === current.account) {
				for (const record of this.state.records) {
					if (record.scope !== current.scope || !isWithinScope(record.path, current.scope)) continue;
					// Preserve identities/revisions for anti-resurrection protection.
					// Only a fresh completed receipt can authorize the new semantics.
					records.push({ keepUrl: record.keepUrl, path: record.path, scope: record.scope,
						revision: record.revision, generation: recordGeneration(), baseline: "legacy" });
				}
			}
			const next: LocalDeletionState = { version: 2, ...current, generation: recordGeneration(), records };
			await this.persist(next);
			if (this.session) this.invalidatedSession = this.session.id;
			this.session = undefined;
			this.changed();
			return { ...current, generation: next.generation };
		});
	}

	async context(): Promise<DeletionContext> { return this.refreshContext(); }

	async records(): Promise<LocalDeletionRecord[]> {
		await this.context();
		return this.state?.version === 2 ? this.state.records.map((record) => ({ ...record })) : [];
	}

	async scan(): Promise<IdentityScan> {
		const context = await this.context();
		const scan = await scanLocalIdentities(this.plugin, this.metadataPath, () => this.generation, context.scope);
		if (!sameContext(context, await this.context())) {
			return { complete: false, reason: "The account or sync folder changed during the membership scan. No removal was proposed." };
		}
		return scan;
	}

	private async mutate(context: DeletionContext, change: (records: LocalDeletionRecord[]) => LocalDeletionRecord[], guard?: () => void): Promise<void> {
		await this.serialized(async () => {
			const state = this.state;
			if (state?.version !== 2 || !sameContext(context, state)) throw new Error("The membership baseline changed. Refresh the review.");
			const records = change(state.records.map((record) => ({ ...record })));
			await this.persist({ ...state, records }, guard);
		});
	}

	async beginReceipts(id: string): Promise<void> {
		const context = await this.context();
		if (this.invalidatedSession === id) throw new Error("The receipt session's account or folder changed. Start a fresh review.");
		if (this.session?.id === id && sameContext(context, this.session)) return;
		this.session = { id, ...context, receipts: new Map() };
	}

	stageDownload(note: PreNormalizedNote, path: string): void {
		if (!this.session || !isSafeVaultPath(path) || !isWithinScope(path, this.session.scope)) return;
		const keepUrl = canonicalKeepUrl(normalizeNote(note).frontmatterDict.GoogleKeepUrl);
		if (!keepUrl) return;
		const revision = typeof note.remote_revision === "string" && KEEP_REVISION_PATTERN.test(note.remote_revision) ? note.remote_revision : undefined;
		this.session.receipts.set(keepUrl, { keepUrl, path, scope: this.session.scope, revision });
	}

	stageUpload(keepUrl: string | undefined, path: string, revision: string | undefined): void {
		if (!this.session || !keepUrl || canonicalKeepUrl(keepUrl) !== keepUrl || !isSafeVaultPath(path) || !isWithinScope(path, this.session.scope)) return;
		const downloaded = this.session.receipts.has(keepUrl) ||
			(this.state?.version === 2 && sameContext(this.state, this.session) && this.state.records.some((record) => record.keepUrl === keepUrl));
		if (!downloaded) return;
		this.session.receipts.set(keepUrl, { keepUrl, path, scope: this.session.scope,
			revision: revision && KEEP_REVISION_PATTERN.test(revision) ? revision : undefined });
	}

	discardReceipts(id: string): void {
		if (this.session?.id === id) this.session = undefined;
		if (this.invalidatedSession === id) this.invalidatedSession = undefined;
	}

	/** Selection may be partial; the independent folder inventory must be complete. */
	async finishReceipts(id: string): Promise<boolean> {
		if (this.invalidatedSession === id) throw new Error("The receipt session's account or folder changed. No checkpoint may advance.");
		const session = this.session;
		if (!session || session.id !== id) return !this.blocked;
		const context = await this.context();
		if (!sameContext(context, session)) throw new Error("The account or sync folder changed before the baseline completed.");
		if (!session.receipts.size) { this.session = undefined; return true; }
		const scan = await this.scan();
		if (!scan.complete) { this.session = undefined; return false; }
		await this.mutate(context, (records) => {
			const next = new Map(records.map((record) => [record.keepUrl, record]));
			for (const receipt of session.receipts.values()) {
				const paths = scan.identities.get(receipt.keepUrl) ?? [];
				if (paths.length !== 1 || !isWithinScope(paths[0], context.scope)) continue;
				if (!receipt.revision) {
					const old = next.get(receipt.keepUrl);
					if (old) next.set(receipt.keepUrl, { ...old, path: paths[0], baseline: "legacy", generation: recordGeneration() });
					continue;
				}
				next.set(receipt.keepUrl, { keepUrl: receipt.keepUrl, path: paths[0], scope: context.scope,
					revision: receipt.revision, generation: recordGeneration(), baseline: "synced" });
			}
			return [...next.values()];
		}, () => {
			if (scan.generation !== this.generation) throw new Error("The sync folder changed before its baseline completed.");
		});
		this.session = undefined;
		return true;
	}

	async assertCurrent(candidate: LocalDeletionRecord): Promise<void> {
		const current = (await this.records()).find((record) => record.keepUrl === candidate.keepUrl);
		if (!current || current.generation !== candidate.generation || current.path !== candidate.path ||
			current.revision !== candidate.revision || current.scope !== candidate.scope || current.baseline !== "synced") {
			throw new Error("The tracked membership baseline changed. Refresh the upload plan before moving a note to Keep Trash.");
		}
	}

	async retire(candidate: LocalDeletionRecord): Promise<void> {
		await this.assertCurrent(candidate);
		const context = await this.context();
		await this.mutate(context, (records) => {
			const current = records.find((record) => record.keepUrl === candidate.keepUrl);
			if (!current || current.generation !== candidate.generation) throw new Error("The baseline changed before acknowledgement.");
			return records.filter((record) => record.keepUrl !== candidate.keepUrl);
		});
	}

	async retireRemoteTrash(keepUrls: ReadonlySet<string>): Promise<void> {
		const context = await this.context();
		await this.mutate(context, (records) => records.filter((record) => !keepUrls.has(record.keepUrl)));
	}
}

export function registerDeletionLedger(plugin: KeepSidianPlugin, ledger: LocalDeletionLedger): void { ledgers.set(plugin, ledger); }
export function getDeletionLedger(plugin: KeepSidianPlugin): LocalDeletionLedger | undefined { return ledgers.get(plugin); }
export function unregisterDeletionLedger(plugin: KeepSidianPlugin): void { ledgers.delete(plugin); }
