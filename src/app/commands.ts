import { t, onUiLanguageChanged } from "../lang/ui";
import type { MessageKey } from "../lang/types";
import type { Command } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { registerRecoveryUatCommands } from "@services/recovery-uat";

export function registerRibbonIcon(plugin: KeepSidianPlugin) {
	const icon = plugin.addRibbonIcon("folder-sync", t("commands.ribbon"), async (_evt: MouseEvent) => {
		plugin.openSyncCenter();
	});
	if (icon) plugin.register(onUiLanguageChanged(() => icon.setAttribute("aria-label", t("commands.ribbon"))));
}

export function registerCommands(plugin: KeepSidianPlugin) {
	const add = (key: MessageKey, options: Omit<Command, "name">) => {
		const label = t(key);
		const command = plugin.addCommand({ ...options, name: label });
		if (!command) return;
		const prefix = command.name.endsWith(label) ? command.name.slice(0, -label.length) : "";
		plugin.register(
			onUiLanguageChanged(() => {
				command.name = prefix + t(key);
			})
		);
	};
	add("commands.syncNow", {
		id: "sync-now",
		callback: async () => {
			plugin.openSyncCenter({ mode: "import", autoStart: true });
		},
	});

	add("commands.openSyncCenter", {
		id: "open-sync-center",
		callback: async () => {
			plugin.openSyncCenter();
		},
	});

	add("commands.twoWaySync", {
		id: "two-way-sync-google-keep",
		callback: async () => {
			plugin.openSyncCenter({ mode: "two-way", autoStart: true });
		},
	});

	add("commands.download", {
		id: "import-google-keep-notes",
		callback: async () => {
			plugin.openSyncCenter({ mode: "import", autoStart: true });
		},
	});

	add("commands.upload", {
		id: "push-google-keep-notes",
		callback: async () => {
			plugin.openSyncCenter({ mode: "push", autoStart: true });
		},
	});

	add("commands.openSyncLog", {
		id: "open-sync-log-file",
		callback: async () => await plugin.openLatestSyncLog(),
	});
}

export function registerRibbonAndCommands(plugin: KeepSidianPlugin) {
	registerRibbonIcon(plugin);
	registerCommands(plugin);
	registerRecoveryUatCommands(plugin);
}
