import type KeepSidianPlugin from "@app/main";
import { LocalDeletionLedger, getDeletionLedger, registerDeletionLedger, unregisterDeletionLedger } from "./ledger";
import { isActiveMembershipPath } from "./scan";
import { deletionScope, isSafeVaultPath } from "./state";

/**
 * The persisted receipt index and a complete folder scan determine membership.
 * Events only invalidate an in-flight inventory. No Vault methods are replaced;
 * offline and other-application removals use exactly the same review path.
 */
export async function initializeLocalDeletionTracking(plugin: KeepSidianPlugin): Promise<void> {
	if (getDeletionLedger(plugin)) return;
	const vault = plugin.app?.vault;
	if (!vault || !plugin.manifest?.id) return;
	const directory = plugin.manifest.dir ?? `${vault.configDir}/plugins/${plugin.manifest.id}`;
	if (!isSafeVaultPath(directory)) return;
	// Keep the original filename so upgrades cannot overlook corrupt/old data.
	const ledger = new LocalDeletionLedger(plugin, `${directory}/local-deletions-v1.json`);
	await ledger.ready;
	registerDeletionLedger(plugin, ledger);
	const changed = (...paths: string[]) => {
		try {
			const scope = deletionScope(plugin.settings.saveLocation);
			if (paths.some((path) => path === scope || isActiveMembershipPath(path, scope, ledger.metadataPath))) ledger.changed();
		} catch { ledger.changed(); }
	};
	if (typeof vault.on === "function" && typeof plugin.registerEvent === "function") {
		plugin.registerEvent(vault.on("create", (file) => changed(file.path)));
		plugin.registerEvent(vault.on("modify", (file) => changed(file.path)));
		plugin.registerEvent(vault.on("delete", (file) => changed(file.path)));
		plugin.registerEvent(vault.on("rename", (file, oldPath) => changed(oldPath, file.path)));
	}
	plugin.register?.(() => unregisterDeletionLedger(plugin));
}

/** Inbound execution retires confirmed identities; events never create removals. */
export async function withLocalDeletionTrackingSuppressed<T>(_plugin: KeepSidianPlugin, work: () => Promise<T>): Promise<T> {
	return work();
}
