/** System tests: real temporary files, Windows filename rules, synthetic Keep API. */
jest.mock("obsidian");
jest.mock("@app/logging", () => ({ logSync: jest.fn(async () => {}), flushLogSync: jest.fn(async () => {}), prepareSyncLog: jest.fn(async () => true) }));
jest.mock("@app/sync-ui");
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import type KeepSidianPlugin from "@app/main";
import { buildManualSyncPlan, runPreparedSyncPlan } from "@app/main-sync-flows";
import { createMockPlugin } from "@test-utils/mocks/plugin";
import { DEFAULT_SETTINGS } from "../../../types/keepsidian-plugin-settings";
import { processAndSaveNotes } from "../sync";
import { extractFrontmatter, type PreNormalizedNote } from "../domain/note";
import * as api from "@integrations/server/keepApi";
import * as http from "@services/http";
import { processAttachments } from "../io/attachments";
import { collectNotesToPush } from "../push/collectNotes";

const roots: string[] = [];
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterEach(async () => { jest.useRealTimers(); jest.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
afterAll(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
	else Reflect.deleteProperty(globalThis, "crypto");
	if (encoderDescriptor) Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor);
	else Reflect.deleteProperty(globalThis, "TextEncoder");
});

const header = (id: string) => `---\nGoogleKeepUrl: https://keep.google.com/#NOTE/${id}\nGoogleKeepUpdatedDate: 2024-01-01T00:00:00.000Z\nKeepSidianLastSyncedDate: 2024-01-01T00:00:00.000Z\n---\n`;
const freezeClock = () => jest.useFakeTimers({ now: new Date("2026-10-10T20:00:00.000Z"), doNotFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "nextTick", "queueMicrotask", "performance"] });
async function fixture(windows = true) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "keepsidian-conflict-"));
	roots.push(root);
	const writes: string[] = [];
	const invalid: string[] = [];
	const validate = (name: string) => {
		if (windows && name.split("/").some(segment => /[<>:"\\|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment) || segment.length > 255)) {
			invalid.push(name); throw Object.assign(new Error("Synthetic Windows filename restriction"), { code: "EINVAL" });
		}
	};
	const disk = (name: string) => { validate(name); return path.join(root, name); };
	const mock = createMockPlugin();
	const adapter = mock.app.vault.adapter;
	adapter.exists.mockImplementation(async name => { try { await fs.stat(disk(name)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } });
	adapter.read.mockImplementation(name => fs.readFile(disk(name), "utf8"));
	adapter.readBinary.mockImplementation(async name => {
		const data = await fs.readFile(disk(name));
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	});
	adapter.writeBinary.mockImplementation(async (name, content) => { await fs.writeFile(disk(name), new Uint8Array(content)); });
	adapter.write.mockImplementation(async (name, content, options) => {
		validate(name);
		if (name.includes("new-")) await new Promise(resolve => setTimeout(resolve, 40));
		await fs.writeFile(disk(name), content); writes.push(name);
		if (options?.mtime !== undefined) await fs.utimes(disk(name), new Date(), new Date(options.mtime));
	});
	adapter.stat.mockImplementation(async name => { try { const stat = await fs.stat(disk(name)); return { ctime: stat.birthtimeMs, mtime: stat.mtimeMs, size: stat.size }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } });
	adapter.list.mockImplementation(async name => {
		const entries = await fs.readdir(disk(name), { withFileTypes: true });
		return { files: entries.filter(entry => entry.isFile()).map(entry => `${name}/${entry.name}`), folders: entries.filter(entry => entry.isDirectory()).map(entry => `${name}/${entry.name}`) };
	});
	mock.app.vault.createFolder.mockImplementation(async name => { await fs.mkdir(disk(name), { recursive: true }); });
	const plugin = Object.assign(mock, {
		settings: { ...DEFAULT_SETTINGS, saveLocation: "Keep", saveLocationMode: "custom", noteFileNamePattern: "{title}", frontmatterPascalCaseFixApplied: true, email: "synthetic@example.invalid", token: "synthetic", embedImportedImages: false, premiumFeatures: { ...DEFAULT_SETTINGS.premiumFeatures, archivedStatus: "all" } },
		subscriptionService: { isSubscriptionActive: jest.fn(async () => true) },
		throwIfSyncCancelled: jest.fn(), requireTwoWaySafeguards: jest.fn(async () => ({ allowed: true })), processedNotes: 0,
	}) as unknown as KeepSidianPlugin;
	await fs.mkdir(path.join(root, "Keep", "media"), { recursive: true });
	const seed = async (name: string, content: string, edited = false) => {
		await fs.writeFile(disk(name), content);
		await fs.utimes(disk(name), new Date("2024-01-01"), new Date(edited ? "2024-01-02" : "2024-01-01"));
	};
	return { plugin, adapter, root, writes, invalid, seed };
}

it.each([false, true])("saves the customer's synthetic 11-change batch with Windows rules=%s", async windows => {
	const f = await fixture(windows);
	const ids = ["new-a", "new-b", "conflict-a", "conflict-b", ...Array.from({ length: 7 }, (_, i) => `overwrite-${i}`)];
	for (const id of ids.slice(2)) await f.seed(`Keep/${id}.md`, header(id) + `shared\n${id.startsWith("conflict") ? "local edit" : "old text"}`, id.startsWith("conflict"));
	const originals = await Promise.all(["a", "b"].map(id => f.adapter.read(`Keep/conflict-${id}.md`)));
	const settled = jest.fn();
	const progress = jest.fn();
	await processAndSaveNotes(f.plugin, ids.map(id => ({ id, title: id, text: "shared\nremote edit", updated: "2024-01-03T00:00:00Z" })), { mergeAction: "merge-save-conflicts", onEntrySettled: settled, reportProgress: progress }, ids);
	expect(progress).toHaveBeenCalledTimes(11);
	expect(settled.mock.calls.filter(([, success]) => success)).toHaveLength(11);
	expect(f.invalid).toEqual([]);
	const copies = f.writes.filter(name => /-conflict-\d/.test(name));
	expect(copies).toHaveLength(2);
	for (const [i, id] of ["a", "b"].entries()) expect(await f.adapter.read(`Keep/conflict-${id}.md`)).toBe(originals[i]);
	for (const copy of copies) { const content = await f.adapter.read(copy); expect(content).toContain("local edit"); expect(content).toContain("remote edit"); }
});

it("preserves occupied copies across same-clock retries", async () => {
	const f = await fixture();
	freezeClock();
	const original = header("one") + "shared\nlocal edit";
	await f.seed("Keep/note.md", original, true);
	const occupied = "Keep/note-conflict-2026-10-10T20-00-00.000Z.md";
	await f.seed(occupied, "Preserve previous conflict copy");
	const run = () => processAndSaveNotes(f.plugin, [{ id: "one", title: "note", text: "shared\nremote edit", updated: "2024-01-03T00:00:00Z" }], { mergeAction: "merge-save-conflicts" });
	await run(); await run();
	expect(await f.adapter.read(occupied)).toBe("Preserve previous conflict copy");
	expect(await f.adapter.read("Keep/note.md")).toBe(original);
	expect(f.writes.filter(name => name.includes("-conflict-"))).toEqual([occupied.replace(".md", "-2.md"), occupied.replace(".md", "-3.md")]);
});

it("preserves a file appearing after reservation and succeeds on retry", async () => {
	const f = await fixture();
	freezeClock();
	await f.seed("Keep/note.md", header("one") + "shared\nlocal edit", true);
	const exists = f.adapter.exists.getMockImplementation()!;
	let checks = 0;
	const occupied = "Keep/note-conflict-2026-10-10T20-00-00.000Z.md";
	f.adapter.exists.mockImplementation(async name => {
		if (name === occupied && ++checks === 2) await f.seed(occupied, "Competing user content");
		return exists(name);
	});
	const run = () => processAndSaveNotes(f.plugin, [{ id: "one", title: "note", text: "shared\nremote edit", updated: "2024-01-03T00:00:00Z" }], { mergeAction: "merge-save-conflicts" });
	await expect(run()).rejects.toThrow(/appeared at the download destination/);
	expect(await f.adapter.read(occupied)).toBe("Competing user content");
	await run();
	expect(await f.adapter.read(occupied)).toBe("Competing user content");
	expect(await f.adapter.exists(occupied.replace(".md", "-2.md"))).toBe(true);
});

it("reserves distinct names when concurrent long filenames truncate to the same stem", async () => {
	const f = await fixture();
	freezeClock();
	const titles = ["a", "b"].map(suffix => "x".repeat(190) + suffix);
	for (const [index, title] of titles.entries()) await f.seed(`Keep/${title}.md`, header(`long-${index}`) + "shared\nlocal edit", true);
	await processAndSaveNotes(f.plugin, titles.map((title, index) => ({ id: `long-${index}`, title, text: "shared\nremote edit", updated: "2024-01-03T00:00:00Z" })), { mergeAction: "merge-save-conflicts" });
	expect(new Set(f.writes).size).toBe(2);
	for (const name of f.writes) expect(Buffer.byteLength(name.split("/").pop()!, "utf8")).toBeLessThanOrEqual(255);
	const identities = await Promise.all(f.writes.map(async name => extractFrontmatter(await f.adapter.read(name))[2].GoogleKeepUrl));
	expect(new Set(identities).size).toBe(2);
});

// Windows cannot seed a reserved source filename; the other cases run on every host.
it.each(["CON.notes", "trailing. ", "emoji-" + "😀".repeat(55)].filter(title => process.platform !== "win32" || title !== "CON.notes"))("makes a portable conflict sibling for a Mac-origin filename %s", async title => {
	const f = await fixture(false);
	await f.seed(`Keep/${title}.md`, header("portable") + "shared\nlocal edit", true);
	await processAndSaveNotes(f.plugin, [{ id: "portable", title, text: "shared\nremote edit", updated: "2024-01-03T00:00:00Z" }], { mergeAction: "merge-save-conflicts" });
	expect(f.writes).toHaveLength(1);
	const name = f.writes[0].split("/").pop()!;
	expect(name).not.toMatch(/[<>:"\\|?*\x00-\x1f]|[. ]$/);
	expect(name).not.toMatch(/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i);
	expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
	expect(await f.adapter.read(`Keep/${title}.md`)).toBe(header("portable") + "shared\nlocal edit");
});

it("completes two-way conflict download and unrelated upload, then repeats without writes after resolution", async () => {
	const f = await fixture();
	const original = header("one") + "shared\nlocal edit";
	await f.seed("Keep/note.md", original, true);
	await f.seed("Keep/upload.md", header("upload") + "common\nlocal addition", true);
	const remote: PreNormalizedNote[] = [
		{ id: "one", title: "note", text: "shared\nremote edit", updated: "2024-01-03T00:00:00Z" },
		{ id: "upload", title: "upload", text: "common", updated: "2024-01-01T00:00:00Z" },
	];
	jest.spyOn(api, "getReplayEpoch").mockResolvedValue(undefined);
	jest.spyOn(api, "fetchNotesWithPremiumFeatures").mockImplementation(async (_email, _token, _flags, offset = 0) => ({ notes: offset ? [] : remote, total_notes: remote.length }));
	jest.spyOn(api, "fetchNotes").mockImplementation(async (_email, _token, offset = 0) => ({ notes: offset ? [] : remote, total_notes: remote.length }));
	const push = jest.spyOn(api, "pushNotes").mockImplementation(async (_email, _token, notes) => ({ results: notes.map(note => {
		const target = remote.find(item => item.title === note.title)!;
		target.text = extractFrontmatter(note.content)[1]; target.updated = new Date().toISOString();
		return { path: note.path, success: true, keep_url: `https://keep.google.com/#NOTE/${target.id}`, remote_updated: target.updated };
	}) }));
	const run = async () => {
		const plan = await buildManualSyncPlan(f.plugin, "two-way", undefined, { kind: "all" });
		expect(plan).not.toBeNull();
		plan!.plan.mergeAction = "merge-save-conflicts";
		const failure = jest.spyOn(plan!.attempt!, "fail");
		const result = await runPreparedSyncPlan(f.plugin, plan!, () => "Synthetic failure", () => {});
		if (result.nextPlan) await runPreparedSyncPlan(f.plugin, result.nextPlan, () => "Synthetic failure", () => {});
		expect(failure.mock.calls).toEqual([]);
		expect(plan!.attempt?.outcome).toBe("success");
		return result;
	};
	const result = await run();
	expect(result.nextPlan?.stage).toBe("upload");
	expect(push).toHaveBeenCalledTimes(1);
	expect(push.mock.calls[0][2].map(note => note.title)).toEqual(["upload"]);
	expect(await f.adapter.read("Keep/note.md")).toBe(original);
	expect(remote[0].text).toBe("shared\nremote edit");
	expect(remote[1].text).toContain("local addition");
	const copies = f.writes.filter(name => name.includes("-conflict-"));
	expect(copies).toHaveLength(1);
	const savedCopy = await f.adapter.read(copies[0]);
	// Simulate the user's resolution, preserving the conflict artifact separately.
	await f.seed("Keep/note.md", header("one") + remote[0].text);
	await run();
	const afterResolution = f.writes.length;
	await run(); await run();
	expect(f.writes).toHaveLength(afterResolution);
	expect(push).toHaveBeenCalledTimes(1);
	expect(await f.adapter.read(copies[0])).toBe(savedCopy);
	expect(f.invalid).toEqual([]);
});

it.each([false, true])("preserves source titles, identities and user renames through portable allocation (Windows=%s)", async windows => {
	const f = await fixture(windows);
	const titles = ["CON", "Note", "note", "café", "cafe\u0301", "heading#part", "cost#$&$$$`$'", "😀".repeat(80)];
	const notes = titles.map((title, i) => ({ id: `portable-${i}`, title, text: `Synthetic body ${i}`, updated: "2024-01-03T00:00:00Z" }));
	await processAndSaveNotes(f.plugin, notes, { mergeAction: "merge-save-conflicts" });
	const paths = [...new Set(f.writes)];
	expect(paths).toHaveLength(titles.length);
	const before = await Promise.all(paths.map(name => f.adapter.read(name)));
	const push = await collectNotesToPush(f.plugin, paths);
	expect(push.notesToPush.map(note => note.title).sort()).toEqual([...titles].sort());
	await processAndSaveNotes(f.plugin, notes, { mergeAction: "merge-save-conflicts" });
	expect(await Promise.all(paths.map(name => f.adapter.read(name)))).toEqual(before);
	expect(f.writes).toHaveLength(paths.length);
	const renamed = "Keep/User renamed.md";
	await fs.rename(path.join(f.root, paths[0]), path.join(f.root, renamed));
	const afterRename = await collectNotesToPush(f.plugin, [renamed]);
	expect(afterRename.notesToPush.find(note => note.fullPath === renamed)?.title).toBe("User renamed");
	await processAndSaveNotes(f.plugin, notes, { mergeAction: "merge-save-conflicts" });
	expect(await f.adapter.exists(renamed)).toBe(true);
	expect(await f.adapter.exists(paths[0])).toBe(false);
});

it.each([false, true])("preserves concurrent attachment collisions and reuses exact versions on repeat (Windows=%s)", async windows => {
	const f = await fixture(windows);
	const names = ["a#b.png", "a[b.png", "Photo.png", "photo.png", "café.png", "cafe\u0301.png"];
	jest.spyOn(http, "httpGetArrayBuffer").mockImplementation(async url => new Uint8Array([Number(url.split("/").pop()) + 1]).buffer);
	const run = () => Promise.all(names.map((name, i) => processAttachments(f.plugin.app, [`https://example.invalid/${i}`], "Keep", [name])));
	const first = await run();
	for (const [i, result] of first.entries()) {
		expect(result.failures).toEqual([]);
		expect([...new Uint8Array(await f.adapter.readBinary(`Keep/media/${result.fileNames[0]}`))]).toEqual([i + 1]);
	}
	expect(new Set(first.flatMap(result => result.fileNames)).size).toBe(names.length);
	const second = await run();
	expect(second.map(result => result.fileNames)).toEqual(first.map(result => result.fileNames));
	expect(second.every(result => result.skippedIdentical === 1 && result.downloaded === 0)).toBe(true);
});

it("keeps source title and generated media references correct through download and repeat", async () => {
	const f = await fixture();
	f.plugin.settings.embedImportedImages = true;
	jest.spyOn(http, "httpGetArrayBuffer").mockImplementation(async url => new Uint8Array([Number(url.split("/").pop())]).buffer);
	const note = { id: "media-note", title: "Title:#[]", text: "Synthetic body", updated: "2024-01-03T00:00:00Z", blob_urls: ["https://example.invalid/1", "https://example.invalid/2"], blob_names: ["a#b.png", "a[b.png"] };
	await processAndSaveNotes(f.plugin, [note], { mergeAction: "merge-save-conflicts" });
	const filename = f.writes[0];
	const content = await f.adapter.read(filename);
	const embeds = [...content.matchAll(/!\[\[media\/([^\]]+)\]\]/g)].map(match => match[1]);
	expect(new Set(embeds).size).toBe(2);
	for (const [i, name] of embeds.entries()) expect([...new Uint8Array(await f.adapter.readBinary(`Keep/media/${name}`))]).toEqual([i + 1]);
	expect((await collectNotesToPush(f.plugin, [filename])).notesToPush[0].title).toBe(note.title);
	const writes = f.writes.length;
	await processAndSaveNotes(f.plugin, [note], { mergeAction: "merge-save-conflicts" });
	expect(await f.adapter.read(filename)).toBe(content);
	expect(f.writes).toHaveLength(writes);
});
