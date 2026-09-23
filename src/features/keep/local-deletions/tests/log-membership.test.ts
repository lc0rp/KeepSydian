import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import { TFile } from "obsidian";
import { logSync, prepareSyncLog } from "@app/logging";
import { decodeLedger } from "../state";
import { deletionFixture, keepUrl, METADATA, noteText, REVISION } from "./support";

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
let fixture: Awaited<ReturnType<typeof deletionFixture>>;

beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterAll(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
	if (encoderDescriptor) Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor);
});
beforeEach(async () => { fixture = await deletionFixture(); });
afterEach(() => { fixture.cleanup(); jest.restoreAllMocks(); });

function eventFile(path: string): TFile {
	return Object.assign(new TFile(), { path });
}

/** Use the real logger against the in-memory adapter, including its modify event. */
async function prepareLog(): Promise<string> {
	Object.assign(fixture.vault.adapter, {
		append: jest.fn(async (path: string, line: string): Promise<void> => {
			fixture.put(path, (fixture.stored.get(path) ?? "") + line);
			fixture.emit("modify", fixture.files.get(path)!);
		}),
	});
	const path = await prepareSyncLog(fixture.plugin);
	if (!path) throw new Error("Fixture log unavailable");
	return path;
}

it("completes a selected baseline while the real logger appends during the identity scan", async () => {
	const logPath = await prepareLog();
	await fixture.ledger.beginReceipts("selected-with-logs");
	fixture.put("Keep/a.md", noteText("a"));
	fixture.put("Keep/unchecked.md", noteText("unchecked"));
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	const generation = fixture.ledger.generation;
	const previousLog = fixture.stored.get(logPath)!;
	const read = fixture.vault.adapter.read.getMockImplementation()!;
	let appended = false;
	fixture.vault.adapter.read.mockImplementation(async (path) => {
		const content = await read(path);
		if (path === "Keep/a.md" && !appended) {
			appended = true;
			await logSync(fixture.plugin, "Disposable membership test progress", { strict: true });
		}
		return content;
	});

	expect(await fixture.ledger.finishReceipts("selected-with-logs")).toBe(true);
	expect(appended).toBe(true);
	expect(fixture.stored.get(logPath)!.length).toBeGreaterThan(previousLog.length);
	expect(fixture.ledger.generation).toBe(generation);
	expect(await decodeLedger(fixture.stored.get(METADATA)!)).toMatchObject({
		version: 2, scope: "Keep",
		records: [{ keepUrl: keepUrl("a"), path: "Keep/a.md", revision: REVISION, baseline: "synced" }],
	});
	expect(fixture.stored.get("Keep/unchecked.md")).toBe(noteText("unchecked"));
});

it("does not inspect the owned log subtree or count its loaded files as omitted members", async () => {
	const logPath = await prepareLog();
	const root = logPath.slice(0, logPath.lastIndexOf("/"));
	fixture.put(`${root}/nested/copied-identity.txt`, noteText("a"));
	const isLog = (path: string) => path === root || path.startsWith(`${root}/`);
	const adapter = fixture.vault.adapter;
	const read = adapter.read.getMockImplementation()!;
	const list = adapter.list.getMockImplementation()!;
	const stat = adapter.stat.getMockImplementation()!;
	adapter.read.mockImplementation(async (path) => {
		if (isLog(path)) throw new Error("Log contents must not be read by membership scanning");
		return read(path);
	});
	adapter.list.mockImplementation(async (path) => {
		if (isLog(path)) throw new Error("Log directories must not be traversed");
		return list(path);
	});
	adapter.stat.mockImplementation(async (path) => {
		if (isLog(path)) throw new Error("Log stats must not affect membership");
		return stat(path);
	});
	await fixture.download("a");
	const scan = await fixture.ledger.scan();
	expect(scan.complete).toBe(true);
	if (!scan.complete) throw new Error(scan.reason);
	expect([...scan.paths]).toEqual(["Keep/a.md"]);
	expect(scan.identities.get(keepUrl("a"))).toEqual(["Keep/a.md"]);
});

it.each(["create", "modify", "delete"])("ignores %s events only inside the owned log subtree", async (event) => {
	const logPath = await prepareLog();
	const root = logPath.slice(0, logPath.lastIndexOf("/"));
	const generation = fixture.ledger.generation;
	for (const path of [root, logPath, `${root}/nested/log.md`]) fixture.emit(event, eventFile(path));
	expect(fixture.ledger.generation).toBe(generation);
	fixture.emit(event, eventFile("Keep/nested/_KeepSidianLogs/user.md"));
	expect(fixture.ledger.generation).toBe(generation + 1);
});

it("ignores internal log renames but invalidates both user/log boundary crossings", async () => {
	const logPath = await prepareLog();
	const root = logPath.slice(0, logPath.lastIndexOf("/"));
	const generation = fixture.ledger.generation;
	fixture.emit("rename", eventFile(`${root}/renamed.md`), logPath);
	expect(fixture.ledger.generation).toBe(generation);
	fixture.emit("rename", eventFile(`${root}/user.md`), "Keep/user.md");
	fixture.emit("rename", eventFile("Keep/user.md"), `${root}/user.md`);
	expect(fixture.ledger.generation).toBe(generation + 2);
});

it.each([
	"Keep/_KeepSidianLogs.md",
	"Keep/_KeepSidianLogs-backup/user.txt",
	"Keep/nested/_KeepSidianLogs/user.md",
	"Keep/.hidden/user.bin",
	"Keep/media/user.txt",
])("retains recursive user identity coverage at %s", async (path) => {
	fixture.put(path, noteText("a"));
	const scan = await fixture.ledger.scan();
	expect(scan.complete).toBe(true);
	if (!scan.complete) throw new Error(scan.reason);
	expect(scan.paths.has(path)).toBe(true);
	expect(scan.identities.get(keepUrl("a"))).toEqual([path]);
});

it("uses the actual logger root when the membership scope is the vault root", async () => {
	fixture.plugin.settings.saveLocation = "";
	const logPath = await prepareLog();
	fixture.put("root-note.md", noteText("a"));
	fixture.put("Archive/_KeepSidianLogs/user.txt", noteText("b"));
	const scan = await fixture.ledger.scan();
	expect(scan.complete).toBe(true);
	if (!scan.complete) throw new Error(scan.reason);
	expect(scan.paths.has(logPath)).toBe(false);
	expect(scan.identities.get(keepUrl("a"))).toEqual(["root-note.md"]);
	expect(scan.identities.get(keepUrl("b"))).toEqual(["Archive/_KeepSidianLogs/user.txt"]);
});

it("still rejects a user-file change during a scan that also writes logs", async () => {
	await prepareLog();
	await fixture.ledger.beginReceipts("unstable-user-file");
	fixture.put("Keep/a.md", noteText("a"));
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	const read = fixture.vault.adapter.read.getMockImplementation()!;
	fixture.vault.adapter.read.mockImplementation(async (path) => {
		const content = await read(path);
		if (path === "Keep/a.md") {
			await logSync(fixture.plugin, "Disposable membership test progress", { strict: true });
			fixture.put(path, content + " changed without an event");
		}
		return content;
	});
	expect(await fixture.ledger.finishReceipts("unstable-user-file")).toBe(false);
	expect(await fixture.ledger.records()).toEqual([]);
});
