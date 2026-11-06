import { AccessV1RequestError } from "@services/errors";
import { consumeUncertainRetry } from "./retry-consent";
import type KeepSidianPlugin from "@app/main";
import {
	enrichLocalNotes,
	lookupLocalEnrichment,
	prepareLocalEnrichment,
	type LocalEnrichmentRequest,
	type PremiumFeatureFlags,
} from "@integrations/server/keepApi";
import { EnrichmentSourceSchema } from "@schemas/keep";
import { CONFLICT_FILE_SUFFIX } from "../constants";
import { buildExistingKeepNoteIndex, readKeepNoteIdentity } from "../domain/noteLookup";
import { extractFrontmatter, normalizeNote, type PreNormalizedNote } from "../domain/note";
import { getEnrichmentLedger, type EnrichmentLedger } from "./ledger";
import {
	hash,
	bodyHash,
	localEnrichmentSnapshot,
	observeLocal,
	effectiveTitle,
	tags,
	type EnrichmentRecord,
} from "./state";
import { bindLegacyTagConsent, permitsLegacyTags } from "./consent";

export function fetchFirstFlags(flags: PremiumFeatureFlags): PremiumFeatureFlags {
	const filters = { ...flags };
	delete filters.suggest_title;
	delete filters.suggest_tags;
	return filters;
}

type Provider = typeof enrichLocalNotes;

/** Paid work is admitted once, after durable local uncertainty guards exist. */
export async function enrichImportNotes(
	plugin: KeepSidianPlugin,
	notes: PreNormalizedNote[],
	requested: PremiumFeatureFlags,
	ledger?: EnrichmentLedger,
	provider: Provider = enrichLocalNotes,
	generate = true
): Promise<PreNormalizedNote[]> {
	if (!requested.suggest_title && !requested.suggest_tags) return notes;
	if (!notes.some((note) => EnrichmentSourceSchema.safeParse(note.enrichment_source).success))
		return notes.map((note) => ({
			...note,
			tags: undefined,
			processing_warnings: [...(note.processing_warnings ?? []), "local_enrichment_unavailable"],
		}));
	const index = await buildExistingKeepNoteIndex(plugin.app, plugin.settings.saveLocation);
	const credentials = {
		email: plugin.settings.email,
		token: plugin.settings.token,
		folder: plugin.settings.saveLocation,
		supporterKey: plugin.settings.supporterKeyConfigured ? plugin.settings.supporterKey : undefined,
	};
	const assertContext = () => {
		if (
			plugin.settings.email !== credentials.email ||
			plugin.settings.token !== credentials.token ||
			plugin.settings.saveLocation !== credentials.folder
		)
			throw new Error("Enrichment account or folder changed.");
	};
	const identities = new Map<string, string[]>();
	const contents = new Map<string, string>();
	for (const path of index.existingPaths) {
		if (path.includes(CONFLICT_FILE_SUFFIX)) continue;
		const markdown = await plugin.app.vault.adapter.read(path);
		contents.set(path, markdown);
		const identity = readKeepNoteIdentity(extractFrontmatter(markdown, true)[2], path);
		if (identity) identities.set(identity, [...(identities.get(identity) ?? []), path]);
	}
	const activeLedger = ledger ?? getEnrichmentLedger(plugin);
	return activeLedger.transaction(async (state, save) => {
		const before = JSON.stringify(state);
		const namespace = await activeLedger.namespace();
		const consentSources = await Promise.all(
			notes.map(async (note) => {
				const parsed = EnrichmentSourceSchema.safeParse(note.enrichment_source);
				return parsed.success ? `${await activeLedger.key(parsed.data)}:${parsed.data.source_hash}` : "";
			})
		);
		for (const note of notes) bindLegacyTagConsent(note.enrichment_legacy_consent, namespace, consentSources);
		let flags = requested;
		if (Array.isArray(requested.suggest_tags?.restrict_tags)) {
			state.vocabulary[namespace] ??= [...new Set(requested.suggest_tags.restrict_tags)].sort();
			flags = { ...requested, suggest_tags: { ...requested.suggest_tags, restrict_tags: state.vocabulary[namespace] } };
		}
		const retryChosen = new Set(
			generate ? notes.filter(consumeUncertainRetry).map((note) => note.enrichment_source?.id) : []
		);
		const retryKeys = new Set<string>();
		// Operations are bound to this backend/account namespace. Never probe other accounts.
		for (const [operation, saved] of Object.entries(state.operations ?? {})) {
			if (
				saved.namespace !== namespace ||
				!saved.rows.some((row) => notes.some((note) => note.enrichment_source?.id === row.request.source.id))
			)
				continue;
			assertContext();
			plugin.throwIfSyncCancelled?.();
			try {
				const response = await lookupLocalEnrichment(
					credentials.email,
					credentials.token,
					saved.rows.map((row) => row.request),
					credentials.supporterKey,
					operation
				);
				if (
					response.results.length !== saved.rows.length ||
					new Set(response.results.map((row) => row.source.id)).size !== saved.rows.length
				)
					throw new Error("Incomplete saved result.");
				for (const row of saved.rows) {
					const current = notes.find((note) => note.enrichment_source?.id === row.request.source.id);
					if (!current || current.enrichment_source?.source_hash !== row.request.source.source_hash) continue;
					const record = state.records[await activeLedger.key(row.request.source)];
					const paths = identities.get(`https://keep.google.com/#NOTE/${row.request.source.id}`) ?? [];
					if (paths.length > 1) continue;
					if (row.localPath) {
						if (
							paths[0] !== row.localPath ||
							(await hash(await plugin.app.vault.adapter.read(row.localPath))) !== row.localHash
						)
							continue;
					} else if (paths.length) {
						// An original-content import may have completed after the lost response.
						// Only its exact receipt proves this was not a later user edit.
						const content = await plugin.app.vault.adapter.read(paths[0]);
						if (
							!record?.local ||
							record.local.path !== paths[0] ||
							(await bodyHash(content)) !== record.local.body ||
							effectiveTitle(paths[0], content) !== record.local.title ||
							JSON.stringify(tags(content)) !== JSON.stringify(record.local.tags)
						)
							continue;
					}
					const result = response.results.find((value) => value.source.id === row.request.source.id);
					if (result?.status === "uncertain") {
						if (
							saved.executionWindowMs !== undefined &&
							Date.now() - saved.startedAt >= saved.executionWindowMs &&
							retryChosen.has(row.request.source.id)
						)
							Object.values(row.keys).forEach((key) => retryKeys.add(key));
						continue;
					}
					await acceptResult(row.request, row.keys, result);
				}
			} catch (error) {
				// A failed lookup is not proof that the previous paid operation ended.
				if (
					error instanceof AccessV1RequestError &&
					["enrichment_replay_expired", "enrichment_replay_held"].includes(error.code ?? "") &&
					saved.executionWindowMs !== undefined &&
					Date.now() - saved.startedAt >= saved.executionWindowMs
				) {
					for (const row of saved.rows)
						if (
							retryChosen.has(row.request.source.id) &&
							notes.some((note) => note.enrichment_source?.source_hash === row.request.source.source_hash)
						)
							Object.values(row.keys).forEach((key) => retryKeys.add(key));
				}
			}
		}
		async function acceptResult(
			request: LocalEnrichmentRequest,
			keys: Record<string, string>,
			result: Awaited<ReturnType<Provider>>["results"][number] | undefined
		): Promise<void> {
			if (
				!result ||
				result.source.source_hash !== request.source.source_hash ||
				result.source.incarnation !== request.source.incarnation ||
				result.status !== "ready"
			)
				return;
			const expected = Object.keys(request.features).map((feature) => (feature === "suggest_title" ? "title" : "tags"));
			if (Object.keys(result.outputs).sort().join() !== expected.sort().join()) return;
			if (result.outputs.title !== undefined && !result.outputs.title.trim()) return;
			const tagOptions = request.features.suggest_tags;
			if (
				result.outputs.tags &&
				(!tagOptions ||
					result.outputs.tags.length > tagOptions.max_tags ||
					result.outputs.tags.some(
						(tag) => !tag.trim() || (Array.isArray(tagOptions.restrict_tags) && !tagOptions.restrict_tags.includes(tag))
					))
			)
				return;
			for (const feature of ["title", "tags"] as const) {
				if (!request.features[feature === "title" ? "suggest_title" : "suggest_tags"]) continue;
				const output = result.outputs[feature];
				if (feature === "title" ? typeof output !== "string" : !Array.isArray(output)) return;
				state.cache[keys[feature]] = {
					...state.cache[keys[feature]],
					status: "ready",
					coverage: feature === "tags" ? request.features.suggest_tags!.max_tags : 0,
					output,
					provenance: result.provenance,
					recipe: await hash(result.provenance ?? request.features),
				};
			}
		}
		const planned: Array<{
			note: PreNormalizedNote;
			record: EnrichmentRecord;
			keys: Record<string, string>;
			request?: LocalEnrichmentRequest;
		}> = [];
		for (const original of notes) {
			const parsed = EnrichmentSourceSchema.safeParse(original.enrichment_source);
			if (!parsed.success) {
				planned.push({ note: { ...original, tags: undefined }, record: undefined as never, keys: {} });
				continue;
			}
			const source = parsed.data,
				key = await activeLedger.key(source);
			const paths = identities.get(`https://keep.google.com/#NOTE/${source.id}`) ?? [];
			if (paths.length > 1)
				throw new Error("Multiple local notes share a Keep identity. Resolve them before enrichment.");
			let record = state.records[key];
			if (record?.uploadPending)
				throw new Error(
					"An earlier upload has no confirmed enrichment receipt. Review and confirm that note's upload before requesting AI suggestions."
				);
			if (!record)
				record = state.records[key] = {
					source,
					projection: { body: source.body_hash, title: source.title, labels: source.labels },
					manualTitle: paths.length > 0,
					tagsAdmitted: paths.length === 0,
					manualKeepLabels: [],
					suppressed: [],
					suppressedValues: [],
					conflicts: [],
					owned: {},
				};
			if (record.tagsAdmitted === undefined)
				record.tagsAdmitted = paths.length === 0 || Object.keys(record.owned).length > 0;
			await activeLedger.recover(record);
			if (!record.local && paths.length) {
				// Preview does not prove that a later file was created by AI. Adopt
				// an independently imported note as manual before admitting work.
				record.manualTitle = true;
				record.tagsAdmitted = false;
				const markdown = contents.get(paths[0])!;
				record.local = {
					source,
					path: paths[0],
					title: effectiveTitle(paths[0], markdown),
					body:
						extractFrontmatter(markdown)[1] === normalizeNote(original).textWithoutFrontmatter
							? await bodyHash(markdown)
							: "local-work",
					tags: tags(markdown),
					owned: {},
				};
			}
			// Planning can observe a newer snapshot, but only an applied/confirmed
			// receipt advances the baseline used for manual field reconciliation.
			const seen = record.source;
			const prior = record.local?.source ?? record.source;
			const local = paths.length ? contents.get(paths[0]) : undefined;
			const localTitle = local === undefined ? undefined : effectiveTitle(paths[0], local);
			const localChangedTitle = record.local && localTitle !== record.local.title;
			if (local !== undefined) observeLocal(record, paths[0], local);
			const alias = record.alias;
			const remoteTitleChanged = prior && source.title !== prior.title && source.title !== alias?.source.title;
			const sourceTitle = remoteTitleChanged && !localChangedTitle ? source.title : undefined;
			if (remoteTitleChanged) record.manualTitle = true;
			record.conflicts =
				remoteTitleChanged && localChangedTitle && localTitle !== source.title
					? [...record.conflicts.filter((value) => value !== "title"), "title"]
					: record.conflicts.filter((value) => value !== "title" || localTitle !== source.title);
			const removed = (prior?.labels ?? []).filter((value) => !source.labels.includes(value));
			for (const value of source.labels) {
				if (
					alias?.source.labels.includes(value) &&
					!alias.projection.labels.includes(value) &&
					!seen.labels.includes(value)
				) {
					if (!record.manualKeepLabels.includes(value)) record.manualKeepLabels.push(value);
					record.suppressedValues = record.suppressedValues.filter((tag) => tag !== value);
				}
			}
			for (const [raw, value] of [...Object.entries(record.owned), ...Object.entries(alias?.owned ?? {})])
				if (removed.includes(value) && !record.suppressed.includes(raw)) record.suppressed.push(raw);
			const removeValues = removed.filter((value) => record.local?.tags.includes(value));
			for (const value of removed) {
				if (local !== undefined && tags(local).includes(value) && !record.local?.tags.includes(value))
					record.conflicts.push(`tag:${value}`);
			}
			record.conflicts = [...new Set(record.conflicts)].filter(
				(value) =>
					!value.startsWith("tag:") ||
					local === undefined ||
					tags(local).includes(value.slice(4)) !== source.labels.includes(value.slice(4))
			);
			record.projection = {
				body: source.body_hash === alias?.source.body_hash ? alias.projection.body : source.body_hash,
				title: source.title === alias?.source.title ? alias.projection.title : source.title,
				labels: source.labels.filter(
					(value) =>
						!(
							alias?.source.labels.includes(value) &&
							!alias.projection.labels.includes(value) &&
							!record.manualKeepLabels.includes(value)
						)
				),
			};
			record.source = source;
			const note: PreNormalizedNote = {
				...original,
				tags: undefined,
				local_enrichment: {
					receipt: key,
					observedLocalPath: paths[0],
					observedLocalHash: paths[0] ? await localEnrichmentSnapshot(paths[0], contents.get(paths[0])!) : undefined,
					sourceTags: record.projection.labels,
					removeValues,
					title: sourceTitle,
					titleSource: sourceTitle !== undefined,
				},
			};
			const tagConsent = permitsLegacyTags(
				original.enrichment_legacy_consent,
				namespace,
				`${key}:${source.source_hash}`
			);
			const eligibleTags = record.tagsAdmitted || tagConsent;
			note.enrichment_legacy_held = !!flags.suggest_tags && !eligibleTags;
			const eligibleTitle = flags.suggest_title !== undefined && !record.manualTitle;
			const features: LocalEnrichmentRequest["features"] = {};
			const keys: Record<string, string> = {};
			if (!source.has_body && !flags.suggest_title?.prompt) {
				planned.push({ note, record, keys });
				continue;
			}
			if (record.local && local === undefined) {
				planned.push({ note, record, keys });
				continue;
			}
			const titleKey = await hash([
				key,
				"title",
				record.projection.body,
				record.projection.title,
				undefined,
				flags.suggest_title ?? {},
			]);
			const acceptedTitle = state.cache[titleKey];
			const titleContext = record.manualTitle
				? (sourceTitle ?? localTitle ?? record.projection.title)
				: typeof acceptedTitle?.output === "string" && acceptedTitle.status === "ready"
					? acceptedTitle.output
					: undefined;
			const selectorTitle = record.manualTitle ? titleContext : record.projection.title;
			for (const feature of ["title", "tags"] as const) {
				if (feature === "title" ? !eligibleTitle : !flags.suggest_tags || !source.has_body) continue;
				const policy =
					feature === "title"
						? (flags.suggest_title ?? {})
						: [flags.suggest_tags!.restrict_tags, flags.suggest_title ?? {}];
				keys[feature] =
					feature === "title"
						? titleKey
						: await hash([key, feature, record.projection.body, selectorTitle, record.projection.labels, policy]);
				const cached = state.cache[keys[feature]];
				const upgrade =
					feature === "tags" &&
					cached?.status === "ready" &&
					cached.coverage < flags.suggest_tags!.max_tags &&
					(cached.attemptedCoverage ?? cached.coverage) < flags.suggest_tags!.max_tags;
				if (
					(!cached ||
						upgrade ||
						(retryKeys.has(keys[feature]) &&
							(cached.status === "uncertain" || (cached.attemptedCoverage ?? 0) > cached.coverage))) &&
					(feature !== "tags" || eligibleTags)
				) {
					if (feature === "title") features.suggest_title = flags.suggest_title;
					else features.suggest_tags = flags.suggest_tags;
				}
			}
			planned.push({
				note,
				record,
				keys,
				request:
					Object.keys(features).length && !record.conflicts.length
						? { source, features, title_context: !features.suggest_title ? titleContext : undefined }
						: undefined,
			});
		}
		if (before !== JSON.stringify(state)) await save();
		const missing = generate ? planned.filter((item) => item.request) : [];
		for (let offset = 0; offset < missing.length; offset += 16) {
			plugin.throwIfSyncCancelled?.();
			const batch = missing.slice(offset, offset + 16);
			// Capability failure proves no paid POST was attempted. Do this before
			// persisting uncertainty; an ordinary retry can safely try preflight again.
			assertContext();
			let executionWindowMs: number | undefined;
			const operation =
				provider === enrichLocalNotes
					? await prepareLocalEnrichment(credentials.email, credentials.token, credentials.supporterKey, (window) => {
							executionWindowMs = window;
						})
					: undefined;
			assertContext();
			plugin.throwIfSyncCancelled?.();
			for (const item of batch) if (item.request!.features.suggest_tags) item.record.tagsAdmitted = true;
			for (const item of batch)
				for (const feature of ["title", "tags"] as const) {
					if (item.request!.features[feature === "title" ? "suggest_title" : "suggest_tags"]) {
						const prior = state.cache[item.keys[feature]];
						const attemptedCoverage = feature === "tags" ? (item.request!.features.suggest_tags?.max_tags ?? 0) : 0;
						state.cache[item.keys[feature]] =
							prior?.status === "ready"
								? { ...prior, attemptedCoverage }
								: {
										status: "uncertain",
										coverage: 0,
										attemptedCoverage,
										recipe: await hash(item.request!.features),
									};
					}
				}
			if (operation) {
				state.operations ??= {};
				state.operations[operation] = {
					namespace,
					startedAt: Date.now(),
					executionWindowMs,
					rows: await Promise.all(
						batch.map(async (item) => {
							const path = identities.get(`https://keep.google.com/#NOTE/${item.request!.source.id}`)?.[0];
							return {
								request: item.request!,
								keys: item.keys,
								localPath: path,
								localHash: path ? await hash(await plugin.app.vault.adapter.read(path)) : undefined,
							};
						})
					),
				};
			}
			await save();
			try {
				assertContext();
				const response = await provider(
					credentials.email,
					credentials.token,
					batch.map((item) => item.request!),
					credentials.supporterKey,
					operation
				);
				if (
					response.results.length !== batch.length ||
					new Set(response.results.map((row) => row.source.id)).size !== batch.length
				)
					throw new Error("Incomplete enrichment response.");
				assertContext();
				for (const item of batch) {
					// Recheck local content after awaiting the provider, not just the original request hash.
					const path = identities.get(`https://keep.google.com/#NOTE/${item.request!.source.id}`)?.[0];
					if (path && (await plugin.app.vault.adapter.read(path)) !== contents.get(path)) continue;
					await acceptResult(
						item.request!,
						item.keys,
						response.results.find((row) => row.source.id === item.request!.source.id)
					);
				}
			} catch {
				/* Durable uncertainty guards prevent charged automatic retry. */
			}
			await save();
		}
		for (const [operation, saved] of Object.entries(state.operations ?? {})) {
			if (
				saved.namespace === namespace &&
				saved.rows.every((row) =>
					Object.values(row.keys).every(
						(key) =>
							state.cache[key]?.status === "ready" &&
							(state.cache[key]?.attemptedCoverage ?? 0) <= state.cache[key].coverage
					)
				)
			)
				delete state.operations![operation];
		}
		await save();
		assertContext();
		return planned.map(({ note, record, keys, request }) => {
			if (!record) return note;
			note.enrichment_requested = flags;
			note.enrichment_pending =
				(!generate && request !== undefined) ||
				note.local_enrichment!.titleSource ||
				note.local_enrichment!.removeValues.length > 0;
			const title = state.cache[keys.title];
			if (title?.status === "ready" && typeof title.output === "string" && !record.manualTitle) {
				note.title = title.output;
				note.local_enrichment!.title ??= title.output;
			}
			const tagResult = state.cache[keys.tags];
			if (!note.enrichment_legacy_held && tagResult?.status === "ready" && Array.isArray(tagResult.output)) {
				const rendered = Object.fromEntries(
					tagResult.output
						.slice(0, flags.suggest_tags!.max_tags)
						.filter((raw) => !record.suppressed.includes(raw))
						.map((raw) => [raw, flags.suggest_tags!.restrict_tags === false ? flags.suggest_tags!.prefix + raw : raw])
				);
				note.local_enrichment!.tags = rendered;
				if (Object.entries(record.owned).some(([raw, value]) => rendered[raw] !== value))
					note.enrichment_pending = true;
				note.tags = [
					...record.projection.labels.filter((value) => !record.suppressedValues.includes(value)),
					...Object.values(rendered),
				];
			}
			if (
				Object.entries(keys).some(
					([feature, key]) =>
						state.cache[key]?.status === "uncertain" ||
						(feature === "tags" && (state.cache[key]?.attemptedCoverage ?? 0) > (state.cache[key]?.coverage ?? 0))
				)
			) {
				note.enrichment_uncertain = true;
				note.enrichment_pending = true;
				note.processing_warnings = [...(note.processing_warnings ?? []), "local_enrichment_uncertain"];
			}
			return note;
		});
	});
}
