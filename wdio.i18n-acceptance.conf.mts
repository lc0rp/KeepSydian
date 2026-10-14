import { config as desktop } from "./wdio.i18n.conf.mts";

// Mobile mode is Obsidian's Electron emulation, never a native Android/iOS run.
const mobile = process.env.KEEPSIDIAN_I18N_MOBILE === "1";
const widths = process.env.KEEPSIDIAN_I18N_WIDTH
	? [Number(process.env.KEEPSIDIAN_I18N_WIDTH)]
	: mobile
		? [320, 390, 768]
		: [430, 768, 1100];
// The 320px desktop settings probe is a documented open limitation: host navigation
// leaves a 10px content column. Set KEEPSIDIAN_I18N_WIDTH=320 to reproduce it.
export const config: WebdriverIO.Config = {
	...desktop,
	specs: ["./test/specs/i18n-acceptance.e2e.ts"],
	capabilities: widths.flatMap((width) =>
		desktop.capabilities.map((capability) => ({
			...capability,
			"wdio:obsidianOptions": {
				...capability["wdio:obsidianOptions"],
				emulateMobile: mobile,
			},
			"goog:chromeOptions": {
				mobileEmulation: { deviceMetrics: { width, height: 900, pixelRatio: 1, mobile, touch: mobile } },
			},
		}))
	),
};
