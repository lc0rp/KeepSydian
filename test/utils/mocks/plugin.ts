import type { DataAdapter } from "obsidian";

// Factory for a minimal KeepSidianPlugin-like stub

export interface MockVaultStat {
	ctime?: number;
	mtime?: number;
	size?: number;
}

export interface MockVaultAdapter {
	exists: jest.Mock<Promise<boolean>, [string]>;
	list: jest.Mock<Promise<{ files: string[]; folders: string[] }>, [string]>;
	read: jest.Mock<Promise<string>, [string]>;
	write: jest.Mock<Promise<void>, Parameters<DataAdapter["write"]>>;
	writeBinary: jest.Mock<Promise<void>, [string, ArrayBuffer]>;
	readBinary: jest.Mock<Promise<ArrayBuffer>, [string]>;
	stat: jest.Mock<Promise<MockVaultStat | null>, [string]>;
}

export interface MockApp {
	vault: {
		adapter: MockVaultAdapter;
		createFolder: jest.Mock<Promise<void>, [string]>;
	};
}

export interface MockPluginSettings {
	email: string;
	token: string;
	saveLocation: string;
	[key: string]: unknown;
}

export interface MockPlugin {
	app: MockApp;
	settings: MockPluginSettings;
	saveSettings: jest.Mock<Promise<void>, []>;
}

export function createMockPlugin(overrides?: Partial<MockPlugin>): MockPlugin {
	const adapter: MockVaultAdapter = {
		exists: jest.fn(async (_path: string) => false),
		list: jest.fn(async (_path: string) => ({ files: [], folders: [] })),
		read: jest.fn(async (_path: string) => ""),
		write: jest.fn(async (_path: string, _data: string) => undefined),
		writeBinary: jest.fn(async (_path: string, _data: ArrayBuffer) => undefined),
		readBinary: jest.fn(async (_path: string) => new ArrayBuffer(0)),
		stat: jest.fn(async (_path: string) => ({
			ctime: Date.now(),
			mtime: Date.now(),
		})),
	};

	const createFolder = jest.fn(async (_path: string) => undefined);

	const plugin: MockPlugin = {
		app: {
			vault: { adapter, createFolder },
		},
		settings: {
			email: "user@example.com",
			token: "test-token",
			saveLocation: "Keep",
			keepSidianLastSuccessfulSyncDate: null,
			frontmatterPascalCaseFixApplied: false,
		},
		saveSettings: jest.fn(async () => undefined),
	};

	return {
		...plugin,
		...overrides,
		app: {
			...plugin.app,
			...overrides?.app,
			vault: {
				...plugin.app.vault,
				...overrides?.app?.vault,
				adapter: {
					...adapter,
					...(overrides?.app?.vault?.adapter ?? {}),
				},
				createFolder: overrides?.app?.vault?.createFolder ?? plugin.app.vault.createFolder,
			},
		},
		settings: {
			...plugin.settings,
			...overrides?.settings,
		},
		saveSettings: overrides?.saveSettings ?? plugin.saveSettings,
	};
}
