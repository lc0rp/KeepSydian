import type { AppLike } from "./paths";
import { ensureParentFolderForFile } from "./paths";

export async function appendLog(app: AppLike, logPath: string, line: string): Promise<void> {
	try {
		if (!app?.vault?.adapter) throw new Error("Sync log storage unavailable");
		// Ensure the parent folder exists so write does not fail due to missing directory
		await ensureParentFolderForFile(app, logPath);
		if (typeof app.vault.adapter.append === "function") {
			await app.vault.adapter.append(logPath, line);
			return;
		}
		// Fallback for adapters that do not expose append semantics.
		let existing = "";
		if (await app.vault.adapter.exists(logPath)) {
			existing = await app.vault.adapter.read(logPath);
		}
		await app.vault.adapter.write(logPath, `${existing}${line}`);
	} catch (e) {
		try {
			const isTest =
				typeof process !== "undefined" && (process.env?.NODE_ENV === "test" || !!process.env?.JEST_WORKER_ID);
			if (!isTest) {
				console.error("Failed to append log.");
			}
		} catch {
			/* empty */
		}
		throw e;
	}
}
