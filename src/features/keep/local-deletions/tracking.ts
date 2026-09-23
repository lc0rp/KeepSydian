import { Notice, type TAbstractFile } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import {
	LocalDeletionLedger, registerDeletionLedger, unregisterDeletionLedger,
	type LocalDeletionIntent,
} from "./ledger";
import { isSafeVaultPath } from "./state";

interface TrackingRuntime { suppressed: number; deleting: number; moving: number; }
const runtimes = new WeakMap<KeepSidianPlugin, TrackingRuntime>();

/**
 * A filesystem delete event cannot distinguish deletion from an external move.
 * Witness ONLY successful explicit Vault.trash/delete calls. Rename operations
 * are suppressed, and a subsequent complete identity scan is still mandatory.
 * Restore only our own wrappers on unload; do not clobber another plugin's hooks.
 */
export async function initializeLocalDeletionTracking(plugin: KeepSidianPlugin): Promise<void> {
	if (runtimes.has(plugin)) return;
	const vault = plugin.app?.vault;
	if (!vault || !plugin.manifest?.id || typeof plugin.register !== "function" ||
		typeof plugin.registerEvent !== "function" || typeof vault.on !== "function" ||
		typeof vault.trash !== "function" || typeof vault.delete !== "function" || typeof vault.rename !== "function") return;
	const directory = plugin.manifest.dir ?? `${vault.configDir}/plugins/${plugin.manifest.id}`;
	if (!isSafeVaultPath(directory)) return;
	const ledger = new LocalDeletionLedger(plugin, `${directory}/local-deletions-v1.json`);
	await ledger.ready;
	const runtime: TrackingRuntime = { suppressed: 0, deleting: 0, moving: 0 };
	const originalTrash = vault.trash;
	const originalDelete = vault.delete;
	const originalRename = vault.rename;

	const remove = async (
		file: TAbstractFile,
		witness: "obsidian-trash" | "obsidian-delete",
		operation: () => Promise<void>
	): Promise<void> => {
		if (runtime.suppressed || runtime.deleting || runtime.moving) return operation();
		runtime.deleting += 1;
		let intent: LocalDeletionIntent | undefined;
		try {
			try { intent = await ledger.captureIntent(file.path); } catch { /* Local deletion remains available; no unsafe witness is manufactured. */ }
			await operation();
			if (intent?.records.length) {
				try { await ledger.confirmIntent(intent, witness); }
				catch { new Notice("KeepSidian: the local removal could not be safely recorded for upload. No Google Keep deletion was authorized."); }
			}
		} finally { runtime.deleting -= 1; }
	};
	const wrappedTrash: typeof vault.trash = async (file, system) => remove(file, "obsidian-trash", () => originalTrash.call(vault, file, system));
	const wrappedDelete: typeof vault.delete = async (file, force) => remove(file, "obsidian-delete", () => originalDelete.call(vault, file, force));
	const wrappedRename: typeof vault.rename = async (file, newPath) => {
		const oldPath = file.path;
		runtime.moving += 1;
		try { await originalRename.call(vault, file, newPath); }
		finally { runtime.moving -= 1; }
		try { await ledger.renamed(oldPath, newPath); }
		catch { /* A metadata failure disables outbound deletion, never the move itself. */ }
	};

	try {
		vault.trash = wrappedTrash;
		vault.delete = wrappedDelete;
		vault.rename = wrappedRename;
	} catch {
		if (vault.trash === wrappedTrash) vault.trash = originalTrash;
		if (vault.delete === wrappedDelete) vault.delete = originalDelete;
		if (vault.rename === wrappedRename) vault.rename = originalRename;
		return;
	}
	runtimes.set(plugin, runtime);
	registerDeletionLedger(plugin, ledger);
	plugin.registerEvent(vault.on("create", () => ledger.changed()));
	plugin.registerEvent(vault.on("modify", () => ledger.changed()));
	plugin.registerEvent(vault.on("delete", () => ledger.changed()));
	plugin.registerEvent(vault.on("rename", (file, oldPath) => {
		ledger.changed();
		void ledger.renamed(oldPath, file.path).catch(() => undefined);
	}));
	plugin.register(() => {
		if (vault.trash === wrappedTrash) vault.trash = originalTrash;
		if (vault.delete === wrappedDelete) vault.delete = originalDelete;
		if (vault.rename === wrappedRename) vault.rename = originalRename;
		runtimes.delete(plugin);
		unregisterDeletionLedger(plugin);
	});
}

/** Reviewed Keep-to-Obsidian trash must not echo back as an outbound deletion. */
export async function withLocalDeletionTrackingSuppressed<T>(plugin: KeepSidianPlugin, work: () => Promise<T>): Promise<T> {
	const runtime = runtimes.get(plugin);
	if (runtime) runtime.suppressed += 1;
	try { return await work(); }
	finally { if (runtime) runtime.suppressed -= 1; }
}
