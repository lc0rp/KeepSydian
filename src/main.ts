import KeepSidianPlugin from "./app/main";
import { initializeLocalDeletionTracking } from "./features/keep/local-deletions/tracking";

/** Install vault lifecycle tracking after settings load and before sync startup. */
export default class KeepSidianEntryPlugin extends KeepSidianPlugin {
	override async loadSettings(): Promise<void> {
		await super.loadSettings();
		await initializeLocalDeletionTracking(this);
	}
}
