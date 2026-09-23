import { TFile, type TAbstractFile } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { createMockPlugin } from "@test-utils/mocks/plugin";
import { getDeletionLedger, LocalDeletionLedger } from "../ledger";
import { isSafeVaultPath } from "../state";
import { initializeLocalDeletionTracking } from "../tracking";

const cleanups: Array<() => void> = [];
const cleanup = () => { while (cleanups.length) cleanups.pop()!(); };

beforeEach(() => {
	jest.spyOn(LocalDeletionLedger.prototype, "captureIntent").mockResolvedValue({ account: "fixture", records: [] });
	jest.spyOn(LocalDeletionLedger.prototype, "renamed").mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

function fixture(inherited = false) {
	const mock = createMockPlugin();
	const receivers: unknown[] = [];
	const originals = {
		trash: jest.fn(async function (this: unknown, _file: TAbstractFile, _system: boolean): Promise<void> { receivers.push(this); }),
		delete: jest.fn(async function (this: unknown, _file: TAbstractFile, _force?: boolean): Promise<void> { receivers.push(this); }),
		rename: jest.fn(async function (this: unknown, _file: TAbstractFile, _path: string): Promise<void> { receivers.push(this); }),
	};
	const vault = Object.assign(mock.app.vault, { configDir: ".obsidian", on: jest.fn() });
	if (inherited) Object.setPrototypeOf(vault, originals);
	else Object.assign(vault, originals);
	const plugin = Object.assign(mock, {
		manifest: { id: "keepsidian", dir: ".obsidian/plugins/keepsidian" },
		register: (callback: () => void) => { cleanups.push(callback); },
		registerEvent: jest.fn(),
	}) as unknown as KeepSidianPlugin;
	return { plugin, vault, originals, receivers };
}

it.each([false, true])("forwards all arguments with the Vault receiver and restores exact descriptors (inherited=%s)", async (inherited) => {
	const { plugin, vault, originals, receivers } = fixture(inherited);
	const before = Object.getOwnPropertyDescriptors(vault);
	await initializeLocalDeletionTracking(plugin);
	const file = Object.assign(new TFile(), { path: "Keep/a.md" });
	await plugin.app.vault.trash(file, false);
	await plugin.app.vault.delete(file, true);
	await plugin.app.vault.rename(file, "Other/a.md");
	expect(originals.trash).toHaveBeenCalledWith(file, false);
	expect(originals.delete).toHaveBeenCalledWith(file, true);
	expect(originals.rename).toHaveBeenCalledWith(file, "Other/a.md");
	expect(receivers).toEqual([vault, vault, vault]);
	cleanup();
	expect(Object.getOwnPropertyDescriptors(vault)).toEqual(before);
	expect(plugin.app.vault.trash).toBe(originals.trash);
	expect(plugin.app.vault.delete).toBe(originals.delete);
	expect(plugin.app.vault.rename).toBe(originals.rename);
	expect(getDeletionLedger(plugin)).toBeUndefined();
});

it("leaves a later plugin's replacement hook intact on unload", async () => {
	const { plugin, originals } = fixture();
	await initializeLocalDeletionTracking(plugin);
	const laterTrash = jest.fn(async () => undefined);
	plugin.app.vault.trash = laterTrash;
	cleanup();
	expect(plugin.app.vault.trash).toBe(laterTrash);
	expect(plugin.app.vault.delete).toBe(originals.delete);
	expect(plugin.app.vault.rename).toBe(originals.rename);
});

it("restores earlier wrappers when a later method cannot be replaced", async () => {
	const { plugin, vault } = fixture();
	Object.defineProperty(vault, "rename", { writable: false });
	const before = Object.getOwnPropertyDescriptors(vault);
	await initializeLocalDeletionTracking(plugin);
	expect(Object.getOwnPropertyDescriptors(vault)).toEqual(before);
	expect(getDeletionLedger(plugin)).toBeUndefined();
});

it("propagates a failed removal without confirming a witness or falling back to delete", async () => {
	const { plugin, originals } = fixture();
	const confirm = jest.spyOn(LocalDeletionLedger.prototype, "confirmIntent");
	await initializeLocalDeletionTracking(plugin);
	const error = new Error("fixture removal failed");
	originals.trash.mockRejectedValueOnce(error);
	const file = Object.assign(new TFile(), { path: "Keep/a.md" });
	await expect(plugin.app.vault.trash(file, false)).rejects.toBe(error);
	expect(confirm).not.toHaveBeenCalled();
	expect(originals.delete).not.toHaveBeenCalled();
	await expect(plugin.app.vault.trash(file, false)).resolves.toBeUndefined();
	expect(originals.trash).toHaveBeenCalledTimes(2);
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
