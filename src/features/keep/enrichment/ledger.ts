import type KeepSidianPlugin from "@app/main";
import { EnrichmentSourceSchema, type EnrichmentSource } from "@schemas/keep";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { isSafeVaultPath } from "../local-deletions/state";
import { extractFrontmatter, getFrontmatterStringValue, normalizeNote, type PreNormalizedNote } from "../domain/note";
import { CONFLICT_FILE_SUFFIX } from "../constants";
import { KEEPSIDIAN_SERVER_URL } from "../../../config";
import { permitsLegacyTags } from "./consent";
import {
	StateSchema,
	ApplicationJournalSchema,
	RecordSchema,
	emptyState,
	hash,
	bodyHash,
	effectiveTitle,
	tags,
	observeLocal,
	replaceTitle,
	replaceTags,
	type EnrichmentState,
	type EnrichmentRecord,
} from "./state";

const ledgers = new WeakMap<KeepSidianPlugin, EnrichmentLedger>();
const queues = new WeakMap<object, Map<string, Promise<void>>>();
const LIMIT = 8 * 1024 * 1024;
const APPLICATION_LIMIT = 256 * 1024;
const APPLICATION_BATCH_SIZE = 16;

/** Serialize writers sharing an adapter/path; outside writes fail closed. No TTL/eviction. */
export class EnrichmentLedger {
	private state: EnrichmentState = emptyState();
	private disk?: string;
	private snapshotChecksum?: string;
	private applicationDisk?: string;
	private applicationsLoaded = false;
	private pendingRecords: Record<string, EnrichmentRecord> = {};
	private blocked = false;
	readonly path: string;
	readonly applicationPath: string;

	constructor(
		readonly plugin: KeepSidianPlugin,
		path?: string
	) {
		const directory =
			plugin.manifest?.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest?.id ?? "keepsidian"}`;
		if (!path && !plugin.manifest?.dir && !plugin.app.vault.configDir)
			throw new Error("Vault configuration directory is unavailable.");
		this.path = path ?? `${directory}/enrichment-v1.json`;
		this.applicationPath = `${this.path}.applications.json`;
		if (!isSafeVaultPath(this.path)) throw new Error("Unsafe enrichment ledger path.");
	}

	async namespace(): Promise<string> {
		return hash(["keep-enrichment-local-v1", KEEPSIDIAN_SERVER_URL, this.plugin.settings.email.trim().toLowerCase()]);
	}

	async key(source: EnrichmentSource): Promise<string> {
		return hash([await this.namespace(), source.id, source.incarnation]);
	}

	async transaction<T>(
		work: (state: EnrichmentState, save: () => Promise<void>) => Promise<T>,
		applicationKey?: string
	): Promise<T> {
		const adapter = this.plugin.app.vault.adapter;
		let byPath = queues.get(adapter);
		if (!byPath) {
			byPath = new Map();
			queues.set(adapter, byPath);
		}
		const operation = (byPath.get(this.path) ?? Promise.resolve()).then(async () => {
			if (this.blocked) throw new Error("Enrichment metadata is unavailable. No AI request was sent.");
			const adapter = this.plugin.app.vault.adapter;
			try {
				const exists = await adapter.exists(this.path);
				if (this.disk === undefined && exists) {
					const disk = await adapter.read(this.path);
					if (new TextEncoder().encode(disk).byteLength > LIMIT) throw new Error("Enrichment ledger is too large.");
					const envelope: unknown = JSON.parse(disk);
					const parsed = StateSchema.parse((envelope as { state?: unknown }).state);
					if ((envelope as { checksum?: unknown }).checksum !== (await hash(parsed)))
						throw new Error("Invalid enrichment checksum.");
					this.state = parsed;
					this.disk = disk;
					this.snapshotChecksum = (envelope as { checksum: string }).checksum;
				} else if (this.disk === undefined && this.plugin.settings.enrichmentLedgerInitialized) {
					throw new Error("Enrichment ledger is missing.");
				} else if (this.disk !== undefined && (!exists || (await adapter.read(this.path)) !== this.disk)) {
					throw new Error("Enrichment ledger changed outside this session.");
				}
				const applicationExists = await adapter.exists(this.applicationPath);
				if (!this.applicationsLoaded) {
					if (applicationExists) {
						const text = await adapter.read(this.applicationPath);
						if (new TextEncoder().encode(text).byteLength > APPLICATION_LIMIT)
							throw new Error("Enrichment application journal is too large.");
						const envelope = JSON.parse(text) as { journal?: unknown; checksum?: unknown };
						const journal = ApplicationJournalSchema.parse(envelope.journal);
						if (envelope.checksum !== (await hash(journal)))
							throw new Error("Invalid enrichment application checksum.");
						if (journal.base === this.snapshotChecksum) {
							for (const [key, record] of Object.entries(journal.records)) {
								if (!this.state.records[key]) throw new Error("Unknown enrichment application record.");
								this.state.records[key] = record;
							}
							this.pendingRecords = journal.records;
						} else {
							// Snapshot-first compaction can leave the previous journal.
							// Only an exact, checksummed checkpoint proves it was included.
							const checkpoint = this.disk
								? (JSON.parse(this.disk) as { appliedJournal?: unknown; checkpointChecksum?: unknown })
								: {};
							if (
								checkpoint.appliedJournal !== envelope.checksum ||
								checkpoint.checkpointChecksum !== (await hash([this.snapshotChecksum, checkpoint.appliedJournal]))
							)
								throw new Error("Enrichment application journal does not match its snapshot.");
						}
						this.applicationDisk = text;
					} else if (this.plugin.settings.enrichmentApplicationJournalInitialized) {
						throw new Error("Enrichment application journal is missing.");
					}
					this.applicationsLoaded = true;
				} else if (
					this.applicationDisk === undefined
						? applicationExists
						: !applicationExists || (await adapter.read(this.applicationPath)) !== this.applicationDisk
				) {
					throw new Error("Enrichment application journal changed outside this session.");
				}
			} catch (error) {
				this.blocked = true;
				throw error;
			}
			const context = JSON.stringify([
				this.plugin.settings.email,
				this.plugin.settings.token,
				this.plugin.settings.saveLocation,
			]);
			const save = async () => {
				try {
					if (
						context !==
						JSON.stringify([this.plugin.settings.email, this.plugin.settings.token, this.plugin.settings.saveLocation])
					)
						throw new Error("Enrichment account/folder changed.");
					if (Object.keys(this.state.cache).length > 20000 || Object.keys(this.state.records).length > 10000)
						throw new Error("Enrichment capacity reached.");
					const state = StateSchema.parse(this.state);
					if (new TextEncoder().encode(JSON.stringify(state)).byteLength > LIMIT - 512)
						throw new Error("Enrichment capacity reached.");
					let applicationText: string | undefined;
					if (applicationKey) {
						this.pendingRecords[applicationKey] = RecordSchema.parse(this.state.records[applicationKey]);
						for (const key of Object.keys(this.pendingRecords))
							this.pendingRecords[key] = RecordSchema.parse(this.state.records[key]);
						if (Object.keys(this.pendingRecords).length < APPLICATION_BATCH_SIZE) {
							const journal = ApplicationJournalSchema.parse({
								version: 1,
								base: this.snapshotChecksum,
								records: this.pendingRecords,
							});
							const candidate = JSON.stringify({ journal, checksum: await hash(journal) });
							if (new TextEncoder().encode(candidate).byteLength <= APPLICATION_LIMIT) applicationText = candidate;
						}
					}
					let checksum: string | undefined;
					let text: string | undefined;
					if (applicationText === undefined) {
						checksum = await hash(state);
						const appliedJournal = this.applicationDisk
							? (JSON.parse(this.applicationDisk) as { checksum: string }).checksum
							: undefined;
						text = JSON.stringify({
							state,
							checksum,
							appliedJournal,
							checkpointChecksum: appliedJournal ? await hash([checksum, appliedJournal]) : undefined,
						});
						if (new TextEncoder().encode(text).byteLength > LIMIT) throw new Error("Enrichment capacity reached.");
					}
					if (applicationText !== undefined || text !== this.disk) {
						const parts = this.path.split("/");
						for (let i = 1; i < parts.length; i++) {
							const folder = parts.slice(0, i).join("/");
							if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
						}
						if (
							this.disk === undefined ? await adapter.exists(this.path) : (await adapter.read(this.path)) !== this.disk
						)
							throw new Error("Enrichment ledger changed before write.");
						if (
							this.applicationDisk === undefined
								? await adapter.exists(this.applicationPath)
								: (await adapter.read(this.applicationPath)) !== this.applicationDisk
						)
							throw new Error("Enrichment application journal changed before write.");
						if (applicationText !== undefined) {
							await adapter.write(this.applicationPath, applicationText);
							if ((await adapter.read(this.applicationPath)) !== applicationText)
								throw new Error("Enrichment application write was not confirmed.");
							this.applicationDisk = applicationText;
						} else {
							await adapter.write(this.path, text!);
							if ((await adapter.read(this.path)) !== text) throw new Error("Enrichment write was not confirmed.");
							this.disk = text;
							this.snapshotChecksum = checksum;
							if (this.applicationDisk !== undefined) {
								const journal = { version: 1 as const, base: checksum!, records: {} };
								const empty = JSON.stringify({ journal, checksum: await hash(journal) });
								await adapter.write(this.applicationPath, empty);
								if ((await adapter.read(this.applicationPath)) !== empty)
									throw new Error("Enrichment journal checkpoint was not confirmed.");
								this.applicationDisk = empty;
							}
							this.pendingRecords = {};
						}
					}
					if (!this.plugin.settings.enrichmentLedgerInitialized) {
						this.plugin.settings.enrichmentLedgerInitialized = true;
						await this.plugin.saveSettings();
					}
					if (this.applicationDisk !== undefined && !this.plugin.settings.enrichmentApplicationJournalInitialized) {
						this.plugin.settings.enrichmentApplicationJournalInitialized = true;
						await this.plugin.saveSettings();
					}
				} catch (error) {
					this.blocked = true;
					throw error;
				}
			};
			return work(this.state, save);
		});
		byPath.set(
			this.path,
			operation.then(
				() => undefined,
				() => undefined
			)
		);
		return operation;
	}

	async recover(record: EnrichmentRecord): Promise<void> {
		if (!record.journal) return;
		const journal = record.journal;
		const adapter = this.plugin.app.vault.adapter;
		const current = (await adapter.exists(journal.receipt.path))
			? await hash(await adapter.read(journal.receipt.path))
			: undefined;
		if (current === journal.after) {
			record.local = journal.receipt;
			record.owned = journal.receipt.owned;
		} else if (current !== journal.before) {
			record.manualTitle = true;
			record.tagsAdmitted = false;
			record.owned = {};
			for (const raw of Object.keys(journal.receipt.owned))
				if (!record.suppressed.includes(raw)) record.suppressed.push(raw);
		}
		delete record.journal;
	}

	async stage(
		note: PreNormalizedNote,
		path: string,
		before: string | undefined,
		proposed: string,
		finalize: (content: string) => Promise<string> = async (content) => content
	): Promise<string> {
		if (!note.local_enrichment || path.includes(CONFLICT_FILE_SUFFIX)) return proposed;
		return this.transaction(async (state, save) => {
			const record = state.records[note.local_enrichment!.receipt];
			if (!record) throw new Error("Enrichment receipt unavailable.");
			if (note.local_enrichment!.receipt !== (await this.key(record.source)))
				throw new Error("Enrichment account changed before application.");
			const source = EnrichmentSourceSchema.parse(note.enrichment_source);
			if (
				source.source_hash !== record.source.source_hash ||
				source.id !== record.source.id ||
				source.incarnation !== record.source.incarnation
			)
				throw new Error("Enrichment source changed before application.");
			await this.recover(record);
			const newlyObservedManual = before !== undefined && !record.local;
			if (newlyObservedManual) {
				// A file appearing during the provider await is not an AI application.
				// Recovery above first recognizes our own completed journal image.
				record.manualTitle = true;
				record.tagsAdmitted = permitsLegacyTags(
					note.enrichment_legacy_consent,
					await this.namespace(),
					`${note.local_enrichment!.receipt}:${source.source_hash}`
				);
				record.owned = {};
			}
			if (before !== undefined) observeLocal(record, path, before);
			const plan = { ...note.local_enrichment! };
			if (newlyObservedManual) {
				plan.title = undefined;
				plan.titleSource = false;
				plan.removeValues = [];
				if (!record.tagsAdmitted) plan.tags = {};
			}
			let content = proposed;
			if (
				plan.title !== undefined &&
				before !== undefined &&
				record.local &&
				effectiveTitle(path, before) === record.local.title &&
				effectiveTitle(path, before) !== plan.title &&
				(plan.titleSource || !record.manualTitle)
			) {
				content = replaceTitle(content, plan.title);
			}
			const existing = before === undefined ? [] : tags(before);
			const ownedValues = new Set(Object.values(record.owned));
			const manual = existing.filter(
				(tag) => !ownedValues.has(tag) && (!plan.removeValues.includes(tag) || record.conflicts.includes(`tag:${tag}`))
			);
			for (const value of plan.sourceTags)
				if (!record.suppressedValues.includes(value) && !manual.includes(value)) manual.push(value);
			const wanted = Object.fromEntries(
				Object.entries(plan.tags ?? record.owned).filter(([raw]) => !record.suppressed.includes(raw))
			);
			const values = [...new Set([...manual, ...Object.values(wanted)])];
			if (JSON.stringify(tags(content)) !== JSON.stringify(values)) content = replaceTags(content, values);
			content = await finalize(content);
			const nextOwned = Object.fromEntries(Object.entries(wanted).filter(([, value]) => !manual.includes(value)));
			// A merge containing local body work must not hide that work in a
			// subsequent own-upload alias to an older source projection.
			const groundedBody = extractFrontmatter(content)[1] === normalizeNote(note).textWithoutFrontmatter;
			const receipt = {
				source: EnrichmentSourceSchema.parse(note.enrichment_source),
				path,
				title: effectiveTitle(path, content),
				body: groundedBody ? await bodyHash(content) : "local-work",
				tags: tags(content),
				owned: nextOwned,
			};
			if (before === content && record.local && (await hash(receipt)) === (await hash(record.local))) return content;
			record.journal = {
				before: before === undefined ? undefined : await hash(before),
				after: await hash(content),
				receipt,
			};
			await save();
			return content;
		}, note.local_enrichment.receipt);
	}

	async finish(note: PreNormalizedNote): Promise<void> {
		if (!note.local_enrichment) return;
		await this.transaction(async (state, save) => {
			const record = state.records[note.local_enrichment!.receipt];
			if (record?.journal) {
				await this.recover(record);
				await save();
			}
		}, note.local_enrichment.receipt);
	}

	async acknowledgeUpload(path: string, content: string, sourceInput: unknown): Promise<void> {
		const parsed = EnrichmentSourceSchema.safeParse(sourceInput);
		if (!parsed.success) return;
		await this.transaction(async (state, save) => {
			const source = parsed.data,
				record = state.records[await this.key(source)];
			if (!record?.local || record.local.path !== path) return;
			const [, , properties] = extractFrontmatter(content);
			if (
				canonicalKeepUrl(getFrontmatterStringValue(properties, "GoogleKeepUrl")) !==
				`https://keep.google.com/#NOTE/${source.id}`
			)
				return;
			observeLocal(record, path, content);
			const unchangedBody = (await bodyHash(content)) === record.local.body;
			const projection = {
				body: unchangedBody ? record.projection.body : source.body_hash,
				title:
					!record.manualTitle && source.title === effectiveTitle(path, content)
						? record.projection.title
						: source.title,
				labels: source.labels.filter(
					(tag) => !Object.values(record.owned).includes(tag) || record.projection.labels.includes(tag)
				),
			};
			record.alias = {
				source,
				projection,
				owned: Object.fromEntries(
					Object.entries(record.owned).filter(
						([, value]) => source.labels.includes(value) && !projection.labels.includes(value)
					)
				),
			};
			record.source = source;
			record.local.body = await bodyHash(content);
			record.local.source = source;
			record.local.title = effectiveTitle(path, content);
			record.local.tags = tags(content);
			record.local.owned = { ...record.owned };
			delete record.uploadPending;
			await save();
		});
	}

	async stageUpload(path: string): Promise<void> {
		await this.assertUploadAllowed(path, true);
	}

	async assertUploadAllowed(path: string, stageIntent = false): Promise<void> {
		await this.transaction(async (state, save) => {
			const adapter = this.plugin.app.vault.adapter;
			if (!(await adapter.exists(path))) return;
			const content = await adapter.read(path);
			const url = canonicalKeepUrl(getFrontmatterStringValue(extractFrontmatter(content)[2], "GoogleKeepUrl"));
			if (!url) return;
			for (const [key, record] of Object.entries(state.records)) {
				if (url !== `https://keep.google.com/#NOTE/${record.source.id}` || key !== (await this.key(record.source)))
					continue;
				await this.recover(record);
				if (!record.local) continue;
				if (record.local.path !== path) {
					if (await adapter.exists(record.local.path)) throw new Error("Multiple local notes share a Keep identity.");
					record.local.path = path;
					observeLocal(record, path, content);
					await save();
				}
				if (record.conflicts.length)
					throw new Error("Title or tags changed on both sides. Resolve those fields before upload.");
				if (stageIntent && !record.uploadPending) {
					record.uploadPending = true;
					await save();
				}
			}
		});
	}
}

export function getEnrichmentLedger(plugin: KeepSidianPlugin): EnrichmentLedger {
	let ledger = ledgers.get(plugin);
	if (!ledger) {
		ledger = new EnrichmentLedger(plugin);
		ledgers.set(plugin, ledger);
	}
	return ledger;
}
