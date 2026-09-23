import { Notice } from "obsidian";
import KeepSidianPlugin from "./app/main";
import { initializeLocalDeletionTracking } from "./features/keep/local-deletions/tracking";
import { getDeletionLedger } from "./features/keep/local-deletions/ledger";

/** Install folder membership tracking after settings load and before sync startup. */
export default class KeepSidianEntryPlugin extends KeepSidianPlugin {
	override async loadSettings(): Promise<void> {
		await super.loadSettings();
		await initializeLocalDeletionTracking(this);
	}

	override async saveSettings(): Promise<void> {
		try {
			// Persist invalidation before new account/folder settings. Switching back
			// later must not revive a baseline from an earlier membership epoch.
			await getDeletionLedger(this)?.refreshContext();
		} catch {
			new Notice("KeepSidian: folder membership metadata could not be confirmed. Keep Trash proposals remain disabled until a valid baseline is available.");
		}
		await super.saveSettings();
	}
}
