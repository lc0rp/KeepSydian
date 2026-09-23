import { Notice, type TAbstractFile } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import {
	LocalDeletionLedger, registerDeletionLedger, unregisterDeletionLedger,
	type LocalDeletionIntent,
} from "./ledger";
import { isSafeVaultPath } from "./state";

interface TrackingRuntime { suppressed: number; removals: Set<string>; moves: Set<string>; }
const runtimes = new WeakMap<KeepSidianPlugin, TrackingRuntime>();

function isWithinOperation(path: string, operations: ReadonlySet<string>): boolean {
	return [...operations].some((root) => path === root || path.startsWith(`${root}/`));
}

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
	const runtime: TrackingRuntime = { suppressed: 0, removals: new Set(), moves: new Set() };
	// Keep exact descriptors for restoration, including inherited methods. Invoke
	// bound functions so every forwarded call retains its original Vault receiver.
	const originalDescriptors = {
		trash: Object.getOwnPropertyDescriptor(vault, "trash"),
		delete: Object.getOwnPropertyDescriptor(vault, "delete"),
		rename: Object.getOwnPropertyDescriptor(vault, "rename"),
	};
	// The project does not enable strictBindCallApply; retain the known signatures
	// after bind rather than allowing its untyped return to escape into callbacks.
	const originalTrash = vault.trash.bind(vault) as typeof vault.trash;
	const originalDelete = vault.delete.bind(vault) as typeof vault.delete;
	const originalRename = vault.rename.bind(vault) as typeof vault.rename;
	const restoreHook = (name: keyof typeof originalDescriptors, wrapper: unknown): void => {
		if (vault[name] !== wrapper) return;
		const descriptor = originalDescriptors[name];
		if (descriptor) Object.defineProperty(vault, name, descriptor);
		else Reflect.deleteProperty(vault, name);
	};

	const remove = async (
		file: TAbstractFile,
		witness: "obsidian-trash" | "obsidian-delete",
		operation: () => Promise<void>
	): Promise<void> => {
		const path = file.path;
		if (runtime.suppressed || isWithinOperation(path, runtime.removals) || isWithinOperation(path, runtime.moves)) return operation();
		runtime.removals.add(path);
		let intent: LocalDeletionIntent | undefined;
		try {
			try { intent = await ledger.captureIntent(path); } catch { /* Local deletion remains available; no unsafe witness is manufactured. */ }
			await operation();
			if (intent?.records.length) {
				try { await ledger.confirmIntent(intent, witness); }
				catch { new Notice("KeepSidian: the local removal could not be safely recorded for upload. No Google Keep deletion was authorized."); }
			}
		} finally { runtime.removals.delete(path); }
	};
	const wrappedTrash: typeof vault.trash = async (file, system) => remove(file, "obsidian-trash", () => originalTrash(file, system));
	const wrappedDelete: typeof vault.delete = async (file, force) => remove(file, "obsidian-delete", () => originalDelete(file, force));
	const wrappedRename: typeof vault.rename = async (file, newPath) => {
		const oldPath = file.path;
		const internalTrashMove = runtime.suppressed > 0 || isWithinOperation(oldPath, runtime.removals);
		runtime.moves.add(oldPath);
		try { await originalRename(file, newPath); }
		finally { runtime.moves.delete(oldPath); }
		// An explicit trash implementation may internally rename into .trash.
		// Its outer removal witness, not that internal move, owns the ledger.
		if (!internalTrashMove) {
			try { await ledger.renamed(oldPath, newPath); }
			catch { /* A metadata failure disables outbound deletion, never the move itself. */ }
		}
	};

	try {
		vault.trash = wrappedTrash;
		vault.delete = wrappedDelete;
		vault.rename = wrappedRename;
	} catch {
		restoreHook("trash", wrappedTrash);
		restoreHook("delete", wrappedDelete);
		restoreHook("rename", wrappedRename);
		new Notice("KeepSidian: explicit local deletion tracking is unavailable. No upload deletion will be inferred from missing files.");
		return;
	}
	runtimes.set(plugin, runtime);
	registerDeletionLedger(plugin, ledger);
	plugin.registerEvent(vault.on("create", () => ledger.changed()));
	plugin.registerEvent(vault.on("modify", () => ledger.changed()));
	plugin.registerEvent(vault.on("delete", () => ledger.changed()));
	plugin.registerEvent(vault.on("rename", (file, oldPath) => {
		ledger.changed();
		if (!runtime.suppressed && !isWithinOperation(oldPath, runtime.removals)) {
			void ledger.renamed(oldPath, file.path).catch(() => undefined);
		}
	}));
	plugin.register(() => {
		restoreHook("trash", wrappedTrash);
		restoreHook("delete", wrappedDelete);
		restoreHook("rename", wrappedRename);
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
