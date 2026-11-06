import { build } from "esbuild";
import { buildOptions } from "../../esbuild.config.mjs";
import { offlineBanner } from "./legacy-e2e.mjs";

await build({
	...buildOptions,
	banner: { js: buildOptions.banner.js + offlineBanner() },
	define: {
		...buildOptions.define,
		"process.env.KEEPSIDIAN_ACCESS_V1": JSON.stringify("false"),
		"process.env.KEEPSIDIAN_SERVER_URL": JSON.stringify("http://127.0.0.1:1"),
	},
});
