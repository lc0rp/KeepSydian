jest.mock("obsidian");
jest.mock("@app/sync-ui");

import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import type KeepSidianPlugin from "@app/main";
import { buildManualSyncPlan, runPreparedSyncPlan, type PreparedSyncPlan } from "@app/main-sync-flows";
import { SyncCancellationError } from "@app/sync-cancel";
import { createMockPlugin } from "@test-utils/mocks/plugin";
import { DEFAULT_SETTINGS } from "../../types/keepsidian-plugin-settings";
import * as api from "@integrations/server/keepApi";
import { extractFrontmatter, type PreNormalizedNote } from "@features/keep/domain/note";
import { bodyBaseline, hasPendingUpload, isRemoteBodyUnchanged, withSyncState } from "@features/keep/domain/sync-state";
import { wrapMarkdown } from "@features/keep/frontmatter";
import { pushGoogleKeepNotes } from "@features/keep/push";
import type { MergeAction } from "@types";

// Both sync engines, comparison, collectors, plan orchestration and attempt
// persistence are real. Only HTTP, the vault and UI are replaced by test I/O.
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterAll(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
	else Reflect.deleteProperty(globalThis, "crypto");
	if (encoderDescriptor) Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor);
	else Reflect.deleteProperty(globalThis, "TextEncoder");
});
beforeEach(() => {
	jest.restoreAllMocks();
	jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "performance"] });
	jest.setSystemTime(new Date("2024-01-04T12:00:00.000Z"));
});
afterEach(() => jest.useRealTimers());

const checkpoint = "2024-01-01T00:00:00.000Z";
const t1 = "2024-01-04T12:00:01.000Z";
const t2 = "2024-01-04T12:00:02.000Z";
const pathFor = (id: string) => `Keep/${id}.md`;
const bodyOf = (content: string) => extractFrontmatter(content)[1];
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
function attachmentBytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	const buffer = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(buffer).set(encoded);
	return buffer;
}
function remoteNote(id: string, body: string, updated = "2024-01-04T11:00:00.000Z"): PreNormalizedNote {
	return { id, title: id, created: checkpoint, updated,
		text: wrapMarkdown(`GoogleKeepUrl: https://keep.google.com/u/0/#NOTE/${id}\nGoogleKeepUpdatedDate: ${updated}`, body) };
}

function fixture(ids = ["A"]) {
	const files = new Map<string, string>();
	const binaries = new Map<string, ArrayBuffer>();
	const mtimes = new Map<string, number>();
	const folders = new Set(["Keep", "Keep/media"]);
	const remotes = new Map(ids.map((id) => [id, remoteNote(id, `remote ${id}\ncommon`)]));
	for (const id of ids) {
		files.set(pathFor(id), wrapMarkdown(`GoogleKeepUrl: https://keep.google.com/u/0/#NOTE/${id}\nKeepSidianLastSyncedDate: ${checkpoint}`, `common\nlocal ${id}`));
		mtimes.set(pathFor(id), Date.parse("2024-01-03T00:00:00.000Z"));
	}
	const sent: api.PushNotePayload[] = [];
	const rejected = new Set<string>();
	let canceled = false, failWrite = "", missingAck = false;
	let plugin: KeepSidianPlugin;
	function makePlugin(settings = { ...DEFAULT_SETTINGS, saveLocation: "Keep", email: "test@example.invalid", token: "test-token", frontmatterPascalCaseFixApplied: true, keepSidianLastSuccessfulSyncDate: checkpoint }) {
		const mock = createMockPlugin();
		mock.app.vault.adapter.exists.mockImplementation(async (path) => files.has(path) || binaries.has(path) || folders.has(path));
		mock.app.vault.adapter.list.mockImplementation(async (path) => ({
			files: [...files.keys(), ...binaries.keys()].filter((file) => parentOf(file) === path),
			folders: [...folders].filter((folder) => parentOf(folder) === path),
		}));
		mock.app.vault.adapter.read.mockImplementation(async (path) => {
			if (!files.has(path)) throw new Error("Test file unavailable");
			return files.get(path)!;
		});
		mock.app.vault.adapter.write.mockImplementation(async (path, content) => {
			if (path === failWrite) throw new Error("Test write failure");
			files.set(path, content);
			mtimes.set(path, Math.floor(Date.now() / 1000) * 1000);
		});
		mock.app.vault.adapter.stat.mockImplementation(async (path) => ({ ctime: Date.parse(checkpoint), mtime: mtimes.get(path) ?? Date.now() }));
		mock.app.vault.adapter.readBinary.mockImplementation(async (path) => {
			if (!binaries.has(path)) throw new Error("Test attachment unavailable");
			return binaries.get(path)!.slice(0);
		});
		mock.app.vault.adapter.writeBinary.mockImplementation(async (path, bytes) => { binaries.set(path, bytes.slice(0)); });
		mock.app.vault.createFolder.mockImplementation(async (path) => { folders.add(path); });
		return Object.assign(mock, {
			settings,
			subscriptionService: { isSubscriptionActive: jest.fn(async () => true) },
			requireTwoWaySafeguards: jest.fn(async () => ({ allowed: true })),
			showTwoWaySafeguardNotice: jest.fn(),
			throwIfSyncCancelled: () => { if (canceled) throw new SyncCancellationError(); },
			processedNotes: 0,
		}) as unknown as KeepSidianPlugin;
	}
	plugin = makePlugin();
	const page = (offset: number) => ({ notes: offset === 0 ? JSON.parse(JSON.stringify([...remotes.values()])) as PreNormalizedNote[] : [] });
	jest.spyOn(api, "fetchNotes").mockImplementation(async (_email, _token, offset = 0) => page(offset));
	jest.spyOn(api, "fetchNotesWithPremiumFeatures").mockImplementation(async (_email, _token, _features, offset = 0) => page(offset));
	jest.spyOn(api, "getReplayEpoch").mockResolvedValue(undefined);
	const push = jest.spyOn(api, "pushNotes").mockImplementation(async (_email, _token, payload) => {
		sent.push(...payload);
		if (missingAck) return { results: [] };
		return { results: payload.map((note) => {
			const id = note.path.replace(/\.md$/, "");
			if (rejected.has(id)) return { path: note.path, success: false };
			remotes.set(id, remoteNote(id, bodyOf(note.content), new Date().toISOString()));
			return { path: note.path, success: true };
		}) };
	});
	const run = (plan: PreparedSyncPlan) => runPreparedSyncPlan(plugin, plan, String, () => {});
	const build = async (mode: "two-way" | "import" | "push" = "two-way") => {
		const plan = await buildManualSyncPlan(plugin, mode, undefined, { kind: "all" });
		expect(plan).not.toBeNull();
		return plan!;
	};
	const download = async () => {
		const plan = await build();
		jest.setSystemTime(new Date(t2));
		const result = await run(plan);
		expect(result.nextPlan).toBeDefined();
		return result.nextPlan!;
	};
	return {
		get plugin() { return plugin; }, files, binaries, mtimes, remotes, rejected, sent, push, run, build, download,
		restart: () => { plugin = makePlugin(JSON.parse(JSON.stringify(plugin.settings))); canceled = false; },
		cancel: () => { canceled = true; },
		failLocalWrite: (path: string) => { failWrite = path; },
		omitAck: () => { missingAck = true; },
	};
}

it.each<MergeAction>(["merge-save-conflicts", "merge-skip-conflicts", "merge-overwrite-conflicts", "overwrite-all"])("honors %s after a T1 Keep edit between T0 review and T2 download", async (action) => {
	const f = fixture();
	const plan = await f.build();
	// Keep changes AFTER the download snapshot but BEFORE the local write stamp.
	f.remotes.set("A", remoteNote("A", "remote A\ncommon\nintervening edit", t1));
	jest.setSystemTime(new Date(t2));
	const next = (await f.run(plan)).nextPlan!;
	expect(next.plan.entries.find((entry) => entry.path === pathFor("A"))?.action).toBe("conflict-copy");
	const before = f.files.get(pathFor("A"))!;
	expect(await isRemoteBodyUnchanged(extractFrontmatter(before)[0], f.remotes.get("A")!)).toBe(false);
	next.plan.mergeAction = action;
	await f.run(next);
	if (action === "merge-save-conflicts" || action === "merge-skip-conflicts") {
		expect(f.sent).toHaveLength(0);
		expect(f.files.get(pathFor("A"))).toBe(before);
		expect(f.remotes.get("A")?.text).toContain("intervening edit");
		expect(f.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	} else {
		expect(f.sent).toHaveLength(1);
		expect(f.remotes.get("A")?.text).toContain("local A");
		expect(f.remotes.get("A")?.text).not.toContain("intervening edit");
	}
});

it("detects remote body changes even with an unchanged remote timestamp", async () => {
	const f = fixture();
	const plan = await f.build();
	f.remotes.get("A")!.text += "\nintervening edit";
	jest.setSystemTime(new Date(t2));
	const next = (await f.run(plan)).nextPlan!;
	expect(next.plan.entries[0].action).toBe("conflict-copy");
});

it("keeps deselected A eligible after B succeeds, the checkpoint advances, and the plugin restarts", async () => {
	const f = fixture(["A", "B"]);
	const next = await f.download();
	const beforeA = f.files.get(pathFor("A"))!;
	const stamp = extractFrontmatter(beforeA)[2].KeepSidianLastSyncedDate;
	expect(f.mtimes.get(pathFor("A"))).toBe(new Date(String(stamp)).getTime());
	next.plan.entries.find((entry) => entry.path === pathFor("A"))!.selected = false;
	await f.run(next);
	expect(f.sent.map((note) => note.path)).toEqual(["B.md"]);
	expect(f.files.get(pathFor("A"))).toBe(beforeA);
	expect(f.plugin.settings.keepSidianLastSuccessfulSyncDate).not.toBe(checkpoint);
	f.restart();
	const later = await f.build("push");
	expect(later.pushNotes?.map((note) => note.fullPath)).toEqual([pathFor("A")]);
	await f.run(later);
	expect(f.remotes.get("A")?.text).toContain("local A");
	expect(hasPendingUpload(extractFrontmatter(f.files.get(pathFor("A"))!)[0])).toBe(false);
	expect(f.sent.every((note) => !/KeepSidian(?:PendingUpload|RemoteBaseline):/.test(note.content))).toBe(true);
});

it.each(["abandoned", "canceled"] as const)("retains durable work after %s upload review and restart", async (outcome) => {
	const f = fixture();
	const next = await f.download();
	if (outcome === "abandoned") await next.attempt!.finish("abandoned");
	else { f.cancel(); expect((await f.run(next)).canceled).toBe(true); }
	f.restart();
	const later = await f.build("push");
	expect(later.pushNotes).toHaveLength(1);
	await f.run(later);
	expect(f.remotes.get("A")?.text).toContain("local A");
});

it("keeps only failed notes pending across a partial upload and successful retry", async () => {
	const f = fixture(["A", "B"]);
	const next = await f.download();
	f.rejected.add("B");
	expect((await f.run(next)).failed).toBe(true);
	expect(hasPendingUpload(extractFrontmatter(f.files.get(pathFor("A"))!)[0])).toBe(false);
	expect(hasPendingUpload(extractFrontmatter(f.files.get(pathFor("B"))!)[0])).toBe(true);
	f.rejected.clear(); f.restart();
	const retry = await f.build("push");
	expect(retry.pushNotes?.map((note) => note.fullPath)).toEqual([pathFor("B")]);
	await f.run(retry);
	expect(f.remotes.get("B")?.text).toContain("local B");
});

it.each(["missing-ack", "local-write"])("does not retire pending state after %s failure", async (failure) => {
	const f = fixture();
	const next = await f.download();
	const before = f.files.get(pathFor("A"));
	if (failure === "missing-ack") f.omitAck(); else f.failLocalWrite(pathFor("A"));
	expect((await f.run(next)).failed).toBe(true);
	expect(f.files.get(pathFor("A"))).toBe(before);
	f.failLocalWrite(""); f.restart();
	expect((await f.build("push")).pushNotes).toHaveLength(1);
});

it("preserves local-only deletions against a confirmed baseline through download and upload", async () => {
	const f = fixture();
	const remote = remoteNote("A", "common\nold line");
	f.remotes.set("A", remote);
	const baseline = await bodyBaseline("A", "common\nold line");
	expect(baseline).toMatch(/^sha256:/);
	const frontmatter = extractFrontmatter(f.files.get(pathFor("A"))!)[0];
	f.files.set(pathFor("A"), wrapMarkdown(withSyncState(frontmatter, true, baseline), "common"));
	const next = await f.download();
	expect(bodyOf(f.files.get(pathFor("A"))!)).toBe("common");
	await f.run(next);
	expect(bodyOf(f.remotes.get("A")!.text!)).toBe("common");
});

it("retains old-mtime local image references and bytes until their upload is acknowledged", async () => {
	const f = fixture();
	f.files.set(pathFor("A"), f.files.get(pathFor("A"))! + "\n\n![[media/local.png]]");
	f.binaries.set("Keep/media/local.png", attachmentBytes("local-image"));
	f.mtimes.set("Keep/media/local.png", Date.parse("2024-01-03T00:00:00.000Z"));
	const next = await f.download();
	expect(f.files.get(pathFor("A"))).toContain("![[media/local.png]]");
	expect(next.pushNotes?.[0].attachments).toEqual([{ name: "local.png", mime_type: "image/png", data: Buffer.from("local-image").toString("base64") }]);
	await f.run(next);
	expect(f.sent[0].attachments).toEqual(next.pushNotes?.[0].attachments);
	expect(hasPendingUpload(extractFrontmatter(f.files.get(pathFor("A"))!)[0])).toBe(false);
});

it.each(["before-upload", "in-flight"])("retains pending state when attachment bytes change %s without an mtime change", async (when) => {
	const f = fixture();
	f.files.set(pathFor("A"), f.files.get(pathFor("A"))! + "\n\n![[media/local.png]]");
	f.binaries.set("Keep/media/local.png", attachmentBytes("old-image"));
	const next = await f.download();
	const change = () => f.binaries.set("Keep/media/local.png", attachmentBytes("new-image"));
	if (when === "before-upload") change();
	else f.push.mockImplementationOnce(async (_email, _token, payload) => { change(); return { results: payload.map((note) => ({ path: note.path, success: true })) }; });
	expect((await f.run(next)).failed).toBe(true);
	expect(hasPendingUpload(extractFrontmatter(f.files.get(pathFor("A"))!)[0])).toBe(true);
	f.restart();
	expect((await f.build("push")).pushNotes?.[0].attachments[0].data).toBe(Buffer.from("new-image").toString("base64"));
});

it("uses the safe policy for pending work reached through the legacy upload entry point", async () => {
	const f = fixture();
	await f.download();
	f.remotes.set("A", remoteNote("A", "remote A\ncommon\nintervening edit", t1));
	f.restart();
	await pushGoogleKeepNotes(f.plugin);
	expect(f.sent).toHaveLength(0);
	expect(hasPendingUpload(extractFrontmatter(f.files.get(pathFor("A"))!)[0])).toBe(true);
});

it("falls back conservatively when no confirmed baseline is available", async () => {
	const f = fixture();
	const frontmatter = extractFrontmatter(f.files.get(pathFor("A"))!)[0];
	f.files.set(pathFor("A"), wrapMarkdown(withSyncState(frontmatter, true), "local replacement"));
	const plan = await f.build("push");
	expect(plan.plan.entries[0].action).toBe("conflict-copy");
	await f.run(plan);
	expect(f.sent).toHaveLength(0);
});

it("retains merge policy and the automatic checkpoint through a bounded two-way run", async () => {
	const f = fixture();
	const scope = { kind: "custom-since", since: "2024-01-02T00:00:00.000Z", until: "2024-01-04T11:30:00.000Z" } as const;
	const plan = (await buildManualSyncPlan(f.plugin, "two-way", undefined, scope))!;
	expect(plan.completionDate).toBeUndefined();
	const filters = (api.fetchNotesWithPremiumFeatures as jest.Mock).mock.calls[0]?.[5] ?? (api.fetchNotes as jest.Mock).mock.calls[0]?.[4];
	expect(filters).toEqual({ changed_gt: scope.since, created_lt: scope.until, updated_lt: scope.until });
	plan.plan.mergeAction = "merge-overwrite-conflicts";
	const next = (await f.run(plan)).nextPlan!;
	expect(next.plan.mergeAction).toBe("merge-overwrite-conflicts");
	expect(next.completionDate).toBeUndefined();
	expect(hasPendingUpload(extractFrontmatter(f.files.get(pathFor("A"))!)[0])).toBe(true);
	expect(await f.run(next)).toEqual({});
	expect(f.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe(checkpoint);
	expect(f.remotes.get("A")?.text).toContain("local A");
});

it("keeps a clean archived merge pending with its confirmed remote baseline", async () => {
	const f = fixture();
	f.plugin.settings.premiumFeatures = { ...f.plugin.settings.premiumFeatures, archivedStatus: "all" };
	f.remotes.get("A")!.archived = true;
	const next = await f.download();
	const content = f.files.get(pathFor("A"))!;
	expect(content).toContain("GoogleKeepArchived: true");
	expect(content).toContain("local A");
	expect(hasPendingUpload(extractFrontmatter(content)[0])).toBe(true);
	expect(await isRemoteBodyUnchanged(extractFrontmatter(content)[0], f.remotes.get("A")!)).toBe(true);
	expect(next.pushNotes?.map((note) => note.fullPath)).toEqual([pathFor("A")]);
});
