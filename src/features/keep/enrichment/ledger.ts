import type KeepSidianPlugin from "@app/main";
import { EnrichmentSourceSchema, type EnrichmentSource } from "@schemas/keep";
import { canonicalKeepUrl } from "@integrations/server/keepDeletions";
import { isSafeVaultPath } from "../local-deletions/state";
import { extractFrontmatter, getFrontmatterStringValue, normalizeNote, type PreNormalizedNote } from "../domain/note";
import { CONFLICT_FILE_SUFFIX } from "../constants";
import { KEEPSIDIAN_SERVER_URL } from "../../../config";
import {
	StateSchema,
	emptyState,
	hash,
	bodyHash,
	effectiveTitle,
	tags,
	observeLocal,
	replaceTags,
	type EnrichmentState,
	type EnrichmentRecord,
} from "./state";

const ledgers = new WeakMap<KeepSidianPlugin, EnrichmentLedger>();
const queues = new WeakMap<object, Map<string, Promise<void>>>();
const LIMIT = 8 * 1024 * 1024;

/** One writer per plugin instance; outside writes fail closed. No TTL/eviction. */
export class EnrichmentLedger {
	private state: EnrichmentState = emptyState();
	private disk?: string;
	private blocked = false;
	readonly path: string;

	constructor(
		readonly plugin: KeepSidianPlugin,
		path?: string
	) {
		const directory =
			plugin.manifest?.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest?.id ?? "keepsidian"}`;
		if (!path && !plugin.manifest?.dir && !plugin.app.vault.configDir)
			throw new Error("Vault configuration directory is unavailable.");
		this.path = path ?? `${directory}/enrichment-v1.json`;
		if (!isSafeVaultPath(this.path)) throw new Error("Unsafe enrichment ledger path.");
	}

	async namespace(): Promise<string> {
		return hash(["keep-enrichment-local-v1", KEEPSIDIAN_SERVER_URL, this.plugin.settings.email.trim().toLowerCase()]);
	}

	async key(source: EnrichmentSource): Promise<string> {
		return hash([await this.namespace(), source.id, source.incarnation]);
	}

	async transaction<T>(work: (state: EnrichmentState, save: () => Promise<void>) => Promise<T>): Promise<T> {
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
				} else if (this.disk === undefined && this.plugin.settings.enrichmentLedgerInitialized) {
					throw new Error("Enrichment ledger is missing.");
				} else if (this.disk !== undefined && (!exists || (await adapter.read(this.path)) !== this.disk)) {
					throw new Error("Enrichment ledger changed outside this session.");
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
					const text = JSON.stringify({ state: StateSchema.parse(this.state), checksum: await hash(this.state) });
					if (new TextEncoder().encode(text).byteLength > LIMIT) throw new Error("Enrichment capacity reached.");
					if (text !== this.disk) {
						const parts = this.path.split("/");
						for (let i = 1; i < parts.length; i++) {
							const folder = parts.slice(0, i).join("/");
							if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
						}
						if (
							this.disk === undefined ? await adapter.exists(this.path) : (await adapter.read(this.path)) !== this.disk
						)
							throw new Error("Enrichment ledger changed before write.");
						await adapter.write(this.path, text);
						if ((await adapter.read(this.path)) !== text) throw new Error("Enrichment write was not confirmed.");
						this.disk = text;
					}
					if (!this.plugin.settings.enrichmentLedgerInitialized) {
						this.plugin.settings.enrichmentLedgerInitialized = true;
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
			await this.recover(record);
			if (before !== undefined) observeLocal(record, path, before);
			const plan = note.local_enrichment!;
			let content = proposed;
			if (
				plan.title !== undefined &&
				before !== undefined &&
				record.local &&
				effectiveTitle(path, before) === record.local.title &&
				effectiveTitle(path, before) !== plan.title &&
				(plan.titleSource || !record.manualTitle)
			) {
				const match = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(content);
				if (match) {
					const line = `Title: ${JSON.stringify(plan.title)}`;
					const properties = /^Title:/m.test(match[1])
						? match[1].replace(/^Title:[^\r\n]*/m, line)
						: `${match[1]}\n${line}`;
					content = content.replace(match[1], properties);
				}
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
		});
	}

	async finish(note: PreNormalizedNote): Promise<void> {
		if (!note.local_enrichment) return;
		await this.transaction(async (state, save) => {
			const record = state.records[note.local_enrichment!.receipt];
			if (record?.journal) {
				await this.recover(record);
				await save();
			}
		});
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
			await save();
		});
	}

	async assertUploadAllowed(path: string): Promise<void> {
		await this.transaction(async (state, save) => {
			const adapter = this.plugin.app.vault.adapter;
			if (!(await adapter.exists(path))) return;
			const content = await adapter.read(path);
			const url = canonicalKeepUrl(getFrontmatterStringValue(extractFrontmatter(content)[2], "GoogleKeepUrl"));
			if (!url) return;
			for (const [key, record] of Object.entries(state.records)) {
				if (
					!record.local ||
					url !== `https://keep.google.com/#NOTE/${record.source.id}` ||
					key !== (await this.key(record.source))
				)
					continue;
				if (record.local.path !== path) {
					if (await adapter.exists(record.local.path)) throw new Error("Multiple local notes share a Keep identity.");
					record.local.path = path;
					observeLocal(record, path, content);
					await save();
				}
				if (record.conflicts.length)
					throw new Error("Title or tags changed on both sides. Resolve those fields before upload.");
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
