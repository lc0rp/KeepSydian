import { browser } from "@wdio/globals";

/** Settings may open in a separate window without the WDIO helper plugin. */
export async function focusVaultWindow(): Promise<void> {
	const platform = (browser.capabilities as { platformName?: string }).platformName;
	if (platform?.toLowerCase() === "android") return;
	for (const handle of await browser.getWindowHandles()) {
		await browser.switchToWindow(handle);
		if (
			await browser.execute(
				() => typeof (window as Window & { wdioObsidianService?: unknown }).wdioObsidianService === "function"
			)
		)
			return;
	}
	throw new Error("The Obsidian vault window is unavailable");
}

/** Route UI assertions to the settings window on hosts that open it separately. */
export async function focusWindowContaining(selector: string): Promise<void> {
	const platform = (browser.capabilities as { platformName?: string }).platformName;
	if (platform?.toLowerCase() === "android") return;
	await browser.waitUntil(async () => {
		for (const handle of await browser.getWindowHandles()) {
			await browser.switchToWindow(handle);
			if (await browser.$(selector).isExisting()) return true;
		}
		return false;
	}, { timeout: 10000, timeoutMsg: `No Obsidian window contains ${selector}` });
}

/** Execute app callbacks in the vault, then restore the window used for UI assertions. */
export function routeAppCommandsToVault(): void {
	browser.overwriteCommand("executeObsidian", async (original, ...args) => {
		const previous = await browser.getWindowHandle();
		await focusVaultWindow();
		try {
			return await original(...args);
		} finally {
			if ((await browser.getWindowHandles()).includes(previous)) await browser.switchToWindow(previous);
		}
	});
}
