import { config as desktop } from "./wdio.i18n.conf.mts";

const widths = process.env.KEEPSIDIAN_I18N_WIDTH ? [Number(process.env.KEEPSIDIAN_I18N_WIDTH)] : [320, 430];
if (process.env.KEEPSIDIAN_I18N_MOBILE === "1")
	throw new Error("The settings host boundary comparison requires desktop mode.");

export const config: WebdriverIO.Config = {
	...desktop,
	specs: ["./test/specs/i18n-settings-boundary.e2e.ts"],
	capabilities: widths.flatMap((width) =>
		desktop.capabilities.map((capability) => ({
			...capability,
			"goog:chromeOptions": {
				mobileEmulation: { deviceMetrics: { width, height: 900, pixelRatio: 1, mobile: false, touch: false } },
			},
		}))
	),
};
