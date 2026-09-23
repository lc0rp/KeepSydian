import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import { TFile } from "obsidian";
import KeepSidianPlugin from "@app/main";
import KeepSidianEntryPlugin from "../../../../main";
import { getDeletionLedger } from "../ledger";
import { isSafeVaultPath } from "../state";
import { initializeLocalDeletionTracking } from "../tracking";
import { deletionFixture, noteText } from "./support";

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

it("never replaces Vault removal or rename methods and initializes only once", async () => {
	const before = Object.getOwnPropertyDescriptors(fixture.vault);
	expect(jest.isMockFunction(fixture.plugin.app.vault.trash)).toBe(true);
	const ledger = getDeletionLedger(fixture.plugin);
	await initializeLocalDeletionTracking(fixture.plugin);
	expect(getDeletionLedger(fixture.plugin)).toBe(ledger);
	expect(Object.getOwnPropertyDescriptors(fixture.vault)).toEqual(before);
	fixture.cleanup();
	expect(getDeletionLedger(fixture.plugin)).toBeUndefined();
});

it.each(["create", "modify", "delete"])("only in-scope %s events invalidate membership scans", (event) => {
	const before = fixture.ledger.generation;
	fixture.emit(event, Object.assign(new TFile(), { path: "Other/a.md" }));
	fixture.emit(event, Object.assign(new TFile(), { path: ".obsidian/workspace.json" }));
	expect(fixture.ledger.generation).toBe(before);
	fixture.emit(event, Object.assign(new TFile(), { path: "Keep/a.md" }));
	expect(fixture.ledger.generation).toBe(before + 1);
});

it("tracks both sides of rename for scan stability without creating tombstones", async () => {
	await fixture.download("a");
	const before = fixture.ledger.generation;
	await fixture.plugin.app.vault.rename(fixture.files.get("Keep/a.md")!, "Other/a.md");
	expect(fixture.ledger.generation).toBeGreaterThan(before);
	expect((await fixture.ledger.records())[0].baseline).toBe("synced");
	expect(fixture.stored.get("Other/a.md")).toBe(noteText("a"));
});

it("retains the baseline when the native removal fails", async () => {
	await fixture.download("a");
	fixture.vault.trash.mockRejectedValueOnce(new Error("native failure"));
	await expect(fixture.trash("a")).rejects.toThrow("native failure");
	expect(fixture.stored.has("Keep/a.md")).toBe(true);
	expect(fixture.vault.delete).not.toHaveBeenCalled();
	expect(await fixture.ledger.records()).toHaveLength(1);
});

it("persists a fresh epoch before saving changed scope settings, including a return", async () => {
	const save = jest.spyOn(KeepSidianPlugin.prototype, "saveSettings").mockResolvedValue(undefined);
	await fixture.download("a");
	const original = await fixture.ledger.context();
	fixture.plugin.settings.saveLocation = "Other";
	await KeepSidianEntryPlugin.prototype.saveSettings.call(fixture.plugin);
	fixture.plugin.settings.saveLocation = "Keep";
	await KeepSidianEntryPlugin.prototype.saveSettings.call(fixture.plugin);
	expect(save).toHaveBeenCalledTimes(2);
	expect((await fixture.ledger.context()).generation).not.toBe(original.generation);
	expect(await fixture.ledger.records()).toEqual([]);
});

it.each([
	{ path: "Keep/a.md", allowRoot: false, safe: true },
	{ path: "", allowRoot: true, safe: true },
	{ path: "", allowRoot: false, safe: false },
	{ path: "Keep/a\0.md", allowRoot: false, safe: false },
	{ path: "Keep\\a.md", allowRoot: false, safe: false },
	{ path: "../a.md", allowRoot: false, safe: false },
	{ path: "/a.md", allowRoot: false, safe: false },
	{ path: "C:/a.md", allowRoot: false, safe: false },
])("preserves vault path validation case %#", ({ path, allowRoot, safe }) => {
	expect(isSafeVaultPath(path, allowRoot)).toBe(safe);
});
