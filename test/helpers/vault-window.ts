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
