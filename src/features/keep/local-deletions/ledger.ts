import type KeepSidianPlugin from "@app/main";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { KEEP_REVISION_PATTERN } from "@integrations/server/keepTrash";
import { normalizeNote, type PreNormalizedNote } from "../domain/note";
import { contentKeepIdentity, scanLocalIdentities, type IdentityScan } from "./scan";
import {
	decodeLedger, deletionAccount, deletionScope, encodeLedger, isSafeVaultPath,
	isWithinScope, recordGeneration, MAX_DELETION_RECORDS,
	type DownloadedRevisionReceipt, type LocalDeletionRecord, type LocalDeletionState,
} from "./state";

interface ReceiptSession {
	id: string;
	account: string;
	scope: string;
	receipts: Map<string, DownloadedRevisionReceipt>;
}
export interface LocalDeletionIntent { account: string; records: LocalDeletionRecord[]; }

const ledgers = new WeakMap<KeepSidianPlugin, LocalDeletionLedger>();

/** All durable writes are serialized independently of settings/credential saves. */
export class LocalDeletionLedger {
	readonly ready: Promise<void>;
	private state?: LocalDeletionState;
	private diskText?: string;
	private queue: Promise<void> = Promise.resolve();
	private blocked = false;
	private revision = 0;
	private session?: ReceiptSession;

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

	async context(): Promise<{ account: string; scope: string }> {
		return { account: await deletionAccount(this.plugin.settings.email), scope: deletionScope(this.plugin.settings.saveLocation) };
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

	async records(): Promise<LocalDeletionRecord[]> {
		await this.verify();
		const { account } = await this.context();
		return this.state?.account === account ? this.state.records.map((record) => ({ ...record })) : [];
	}

	async scan(): Promise<IdentityScan> {
		await this.verify();
		return scanLocalIdentities(this.plugin, this.metadataPath, () => this.generation);
	}

	private async mutate(
		account: string,
		change: (records: LocalDeletionRecord[]) => Promise<LocalDeletionRecord[]> | LocalDeletionRecord[]
	): Promise<void> {
		const operation = this.queue.then(async () => {
			await this.ready;
			await this.verifyDisk();
			if ((await this.context()).account !== account) throw new Error("The Keep account changed. Refresh the deletion plan.");
			const records = await change(this.state?.account === account ? this.state.records.map((record) => ({ ...record })) : []);
			if (records.length > MAX_DELETION_RECORDS) throw new Error("Deletion metadata capacity reached; no baseline was advanced.");
			const next: LocalDeletionState = { version: 1, account, records };
			const text = await encodeLedger(next);
			if (text === this.diskText) return;
			try {
				await this.plugin.app.vault.adapter.write(this.metadataPath, text);
				if (await this.plugin.app.vault.adapter.read(this.metadataPath) !== text) throw new Error("Deletion metadata write was not confirmed.");
			} catch {
				this.blocked = true;
				throw new Error("Deletion metadata could not be saved. Unconfirmed rows remain unacknowledged.");
			}
			this.state = next;
			this.diskText = text;
		});
		this.queue = operation.catch(() => undefined);
		await operation;
	}

	async beginReceipts(id: string): Promise<void> {
		await this.ready;
		if (this.blocked) return;
		if (this.session?.id === id) return;
		const context = await this.context();
		this.session = { id, ...context, receipts: new Map() };
	}

	stageDownload(note: PreNormalizedNote, path: string): void {
		if (!this.session || !isSafeVaultPath(path)) return;
		const normalized = normalizeNote(note);
		const keepUrl = canonicalKeepUrl(normalized.frontmatterDict.GoogleKeepUrl);
		if (!keepUrl) return;
		const revision = typeof note.remote_revision === "string" && KEEP_REVISION_PATTERN.test(note.remote_revision) ? note.remote_revision : undefined;
		this.session.receipts.set(keepUrl, { keepUrl, path, scope: this.session.scope, revision });
	}

	stageUpload(keepUrl: string | undefined, path: string, revision: string | undefined): void {
		if (!this.session || !keepUrl || canonicalKeepUrl(keepUrl) !== keepUrl || !isSafeVaultPath(path)) return;
		// A newly uploaded/untracked note is NOT enrolled as a downloaded note.
		const downloaded = this.session.receipts.has(keepUrl) ||
			(this.state?.account === this.session.account && this.state.records.some((record) => record.keepUrl === keepUrl));
		if (!downloaded) return;
		this.session.receipts.set(keepUrl, {
			keepUrl, path, scope: this.session.scope,
			revision: revision && KEEP_REVISION_PATTERN.test(revision) ? revision : undefined,
		});
	}

	discardReceipts(id: string): void {
		if (this.session?.id === id) this.session = undefined;
	}

	/** Returns false when a successful non-destructive sync cannot enroll a baseline. */
	async finishReceipts(id: string): Promise<boolean> {
		const session = this.session;
		if (!session || session.id !== id) return !this.blocked;
		if (!session.receipts.size) { this.session = undefined; return true; }
		const context = await this.context();
		if (context.account !== session.account || context.scope !== session.scope) throw new Error("The account or sync folder changed before the baseline completed.");
		const scan = await this.scan();
		if (!scan.complete) { this.session = undefined; return false; }
		await this.mutate(session.account, (records) => {
			const next = new Map(records.map((record) => [record.keepUrl, record]));
			for (const receipt of session.receipts.values()) {
				const paths = scan.identities.get(receipt.keepUrl) ?? [];
				if (paths.length !== 1 || !isWithinScope(paths[0], session.scope)) continue;
				// Never overwrite a witnessed deletion that happened after this scan.
				if (scan.generation !== this.generation) throw new Error("The vault changed before the deletion baseline completed.");
				if (!receipt.revision) { next.delete(receipt.keepUrl); continue; }
				next.set(receipt.keepUrl, {
					keepUrl: receipt.keepUrl, path: paths[0], scope: session.scope,
					revision: receipt.revision, generation: recordGeneration(), state: "present",
				});
			}
			return [...next.values()];
		});
		this.session = undefined;
		return true;
	}

	/** Called BEFORE an explicit Obsidian trash/delete API invocation, not a watcher event. */
	async captureIntent(path: string): Promise<LocalDeletionIntent> {
		const { account } = await this.context();
		const records: LocalDeletionRecord[] = [];
		for (const record of await this.records()) {
			if (record.path !== path && !record.path.startsWith(`${path}/`)) continue;
			try {
				const content = await this.plugin.app.vault.adapter.read(record.path);
				if (contentKeepIdentity(content) === record.keepUrl) records.push(record);
			} catch { /* An unreadable identity cannot authorize a tombstone. */ }
		}
		return { account, records };
	}

	/** Persist a witness only AFTER the explicit local operation succeeds and the path is absent. */
	async confirmIntent(intent: LocalDeletionIntent, witness: "obsidian-trash" | "obsidian-delete"): Promise<void> {
		if (!intent.records.length) return;
		await this.mutate(intent.account, async (records) => {
			for (const candidate of intent.records) {
				const index = records.findIndex((record) => record.keepUrl === candidate.keepUrl && record.generation === candidate.generation && record.path === candidate.path);
				if (index < 0 || await this.plugin.app.vault.adapter.exists(candidate.path)) continue;
				records[index] = { ...records[index], state: "tombstone", witness, generation: recordGeneration() };
			}
			return records;
		});
	}

	async renamed(oldPath: string, newPath: string): Promise<void> {
		if (oldPath === newPath || !isSafeVaultPath(oldPath) || !isSafeVaultPath(newPath)) return;
		const { account } = await this.context();
		await this.mutate(account, (records) => records.map((record) => {
			if (record.path !== oldPath && !record.path.startsWith(`${oldPath}/`)) return record;
			const { witness: _witness, ...rest } = record;
			return { ...rest, path: newPath + record.path.slice(oldPath.length), state: "present", generation: recordGeneration() };
		}));
	}

	async assertCurrent(candidate: LocalDeletionRecord): Promise<void> {
		const current = (await this.records()).find((record) => record.keepUrl === candidate.keepUrl);
		if (!current || current.generation !== candidate.generation || current.path !== candidate.path ||
			current.revision !== candidate.revision || current.scope !== candidate.scope || current.state !== "tombstone" || !current.witness) {
			throw new Error("The local tombstone changed. Refresh the upload plan before deleting from Keep.");
		}
	}

	async retire(candidate: LocalDeletionRecord): Promise<void> {
		await this.assertCurrent(candidate);
		const { account } = await this.context();
		await this.mutate(account, (records) => {
			const current = records.find((record) => record.keepUrl === candidate.keepUrl);
			if (!current || current.generation !== candidate.generation) throw new Error("The local tombstone changed before acknowledgement.");
			return records.filter((record) => record.keepUrl !== candidate.keepUrl);
		});
	}

	async retireRemoteTrash(keepUrls: ReadonlySet<string>): Promise<void> {
		const { account } = await this.context();
		await this.mutate(account, (records) => records.filter((record) => !keepUrls.has(record.keepUrl)));
	}
}

export function registerDeletionLedger(plugin: KeepSidianPlugin, ledger: LocalDeletionLedger): void { ledgers.set(plugin, ledger); }
export function getDeletionLedger(plugin: KeepSidianPlugin): LocalDeletionLedger | undefined { return ledgers.get(plugin); }
export function unregisterDeletionLedger(plugin: KeepSidianPlugin): void { ledgers.delete(plugin); }
