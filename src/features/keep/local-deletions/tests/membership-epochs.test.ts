import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import KeepSidianPlugin from "@app/main";
import KeepSidianEntryPlugin from "../../../../main";
import { getDeletionLedger, unregisterDeletionLedger } from "../ledger";
import { initializeLocalDeletionTracking } from "../tracking";
import { decodeLedger } from "../state";
import { deletionFixture, METADATA, noteText, REVISION } from "./support";

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

it("does not manufacture a metadata path when both directory sources are unavailable", async () => {
	unregisterDeletionLedger(fixture.plugin);
	Object.assign(fixture.plugin.manifest, { dir: undefined });
	Object.assign(fixture.vault, { configDir: undefined });
	fixture.vault.adapter.exists.mockClear();
	await initializeLocalDeletionTracking(fixture.plugin);
	expect(getDeletionLedger(fixture.plugin)).toBeUndefined();
	expect(fixture.vault.adapter.exists).not.toHaveBeenCalled();
});

it("records account clearing as a new epoch before settings persistence", async () => {
	jest.spyOn(KeepSidianPlugin.prototype, "saveSettings").mockResolvedValue(undefined);
	await fixture.download("a");
	const original = await fixture.ledger.context();
	fixture.plugin.settings.email = "";
	await KeepSidianEntryPlugin.prototype.saveSettings.call(fixture.plugin);
	fixture.plugin.settings.email = "fixture@example.com";
	await KeepSidianEntryPlugin.prototype.saveSettings.call(fixture.plugin);
	expect((await fixture.ledger.context()).generation).not.toBe(original.generation);
	expect(await fixture.ledger.records()).toEqual([]);
});

it("rejects the old receipt session after a folder change and return", async () => {
	await fixture.ledger.beginReceipts("old-attempt");
	fixture.put("Keep/a.md", noteText("a"));
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	fixture.plugin.settings.saveLocation = "Other";
	await fixture.ledger.refreshContext();
	fixture.plugin.settings.saveLocation = "Keep";
	await fixture.ledger.refreshContext();
	await expect(fixture.ledger.finishReceipts("old-attempt")).rejects.toThrow("changed");
	await expect(fixture.ledger.beginReceipts("old-attempt")).rejects.toThrow("changed");
	expect(await fixture.ledger.records()).toEqual([]);
	await fixture.ledger.beginReceipts("new-attempt");
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	expect(await fixture.ledger.finishReceipts("new-attempt")).toBe(true);
	expect(await fixture.ledger.records()).toHaveLength(1);
});

it("rejects a folder change during identity reading even without a vault event", async () => {
	await fixture.download("a");
	const read = fixture.vault.adapter.read.getMockImplementation()!;
	fixture.vault.adapter.read.mockImplementation(async (path) => {
		if (path === "Keep/a.md") fixture.plugin.settings.saveLocation = "Other";
		return read(path);
	});
	expect(await fixture.ledger.scan()).toMatchObject({ complete: false });
	expect(await fixture.ledger.records()).toEqual([]);
});

it("does not publish a baseline when membership changes during its write", async () => {
	await fixture.ledger.beginReceipts("raced");
	const previous = fixture.stored.get(METADATA)!;
	fixture.put("Keep/a.md", noteText("a"));
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	const write = fixture.vault.adapter.write.getMockImplementation()!;
	fixture.vault.adapter.write.mockImplementation(async (path, content) => {
		await write(path, content);
		if (path === METADATA && content !== previous) fixture.ledger.changed();
	});
	await expect(fixture.ledger.finishReceipts("raced")).rejects.toThrow("No baseline or checkpoint");
	expect(await decodeLedger(fixture.stored.get(METADATA)!)).toMatchObject({ records: [] });
	await expect(fixture.ledger.records()).rejects.toThrow();
});
