import { TFile, type TAbstractFile } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { DEFAULT_SETTINGS } from "../../../../types/keepsidian-plugin-settings";
import { createMockPlugin } from "@test-utils/mocks/plugin";
import { initializeLocalDeletionTracking } from "../tracking";
import { getDeletionLedger } from "../ledger";

export const REVISION = "keep-v1:" + "a".repeat(64);
export const METADATA = ".obsidian/plugins/keepsidian/local-deletions-v1.json";
export const keepUrl = (id: string) => `https://keep.google.com/#NOTE/${id}`;
export const noteText = (id: string) => `---\nGoogleKeepUrl: "${keepUrl(id)}"\nKeepSidianLastSyncedDate: "2026-09-01T00:00:00.000Z"\n---\nFixture body ${id}`;

type Listener = (file: TAbstractFile, oldPath?: string) => void;

/** In-memory adapter only. No real account, filesystem, network or runtime UAT. */
export async function deletionFixture() {
	const mock = createMockPlugin();
	const stored = new Map<string, string>();
	const folders = new Set(["", "Keep", ".obsidian", ".obsidian/plugins", ".obsidian/plugins/keepsidian", ".trash"]);
	const files = new Map<string, TFile>();
	const listeners = new Map<string, Listener[]>();
	const cleanups: Array<() => void> = [];
	const addFolders = (path: string) => {
		const parts = path.split("/");
		for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
	};
	const put = (path: string, text: string) => {
		addFolders(path);
		stored.set(path, text);
		if (!files.has(path)) files.set(path, Object.assign(new TFile(), {
			path, basename: path.split("/").pop()?.replace(/\.[^.]+$/, ""), extension: path.split(".").pop(),
			stat: { size: text.length, mtime: 1, ctime: 1 },
		}));
	};
	const remove = (path: string) => { stored.delete(path); files.delete(path); };
	const emit = (event: string, file: TAbstractFile, oldPath?: string) => {
		for (const listener of listeners.get(event) ?? []) listener(file, oldPath);
	};
	mock.app.vault.adapter.exists.mockImplementation(async (path) => stored.has(path) || folders.has(path));
	mock.app.vault.adapter.read.mockImplementation(async (path) => {
		if (!stored.has(path)) throw new Error("Fixture file absent");
		return stored.get(path)!;
	});
	mock.app.vault.adapter.write.mockImplementation(async (path, content) => { put(path, content); });
	mock.app.vault.adapter.stat.mockImplementation(async (path) => stored.has(path)
		? { type: "file", size: stored.get(path)!.length, mtime: 1, ctime: 1 }
		: folders.has(path) ? { type: "folder", size: 0, mtime: 1, ctime: 1 } : null);
	const isChild = (path: string, parent: string) => path !== parent &&
		(parent ? path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes("/") : !path.includes("/"));
	mock.app.vault.adapter.list.mockImplementation(async (parent) => ({
		files: [...stored.keys()].filter((path) => isChild(path, parent)),
		folders: [...folders].filter((path) => isChild(path, parent)),
	}));
	mock.app.vault.createFolder.mockImplementation(async (path) => { addFolders(`${path}/placeholder`); });
	const vault = Object.assign(mock.app.vault, {
		configDir: ".obsidian",
		getFiles: jest.fn(() => [...files.values()].filter((file) => !file.path.startsWith("."))),
		getMarkdownFiles: jest.fn(() => [...files.values()].filter((file) => file.extension === "md" && !file.path.startsWith("."))),
		getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
		read: jest.fn(async (file: TFile) => mock.app.vault.adapter.read(file.path)),
		on: jest.fn((event: string, listener: Listener) => {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
			return { event, listener };
		}),
		delete: jest.fn(async (file: TAbstractFile, _force?: boolean) => {
			for (const path of [...stored.keys()]) if (path === file.path || path.startsWith(`${file.path}/`)) remove(path);
			emit("delete", file);
		}),
		rename: jest.fn(async (file: TAbstractFile, newPath: string) => {
			const oldPath = file.path;
			for (const path of [...stored.keys()]) {
				if (path !== oldPath && !path.startsWith(`${oldPath}/`)) continue;
				put(newPath + path.slice(oldPath.length), stored.get(path)!);
				remove(path);
			}
			file.path = newPath;
			emit("rename", file, oldPath);
		}),
		trash: jest.fn(async (file: TAbstractFile, _system: boolean) => { remove(file.path); emit("delete", file); }),
	});
	const plugin = Object.assign(mock, {
		manifest: { id: "keepsidian", dir: ".obsidian/plugins/keepsidian" },
		settings: { ...DEFAULT_SETTINGS, email: "fixture@example.com", token: "fixture-token", saveLocation: "Keep",
			frontmatterPascalCaseFixApplied: true, keepSidianLastSuccessfulSyncDate: "2026-09-01T00:00:00.000Z" },
		register: (cleanup: () => void) => { cleanups.push(cleanup); },
		registerEvent: jest.fn(),
		subscriptionService: { isSubscriptionActive: jest.fn().mockResolvedValue(true) },
		throwIfSyncCancelled: jest.fn(),
		requireTwoWaySafeguards: jest.fn().mockResolvedValue({ allowed: true }),
		showTwoWaySafeguardNotice: jest.fn(),
		processedNotes: 0,
	}) as unknown as KeepSidianPlugin;
	await initializeLocalDeletionTracking(plugin);
	const ledger = getDeletionLedger(plugin)!;
	const download = async (...ids: string[]) => {
		await ledger.beginReceipts("fixture-download");
		for (const id of ids) {
			const path = `Keep/${id}.md`;
			put(path, noteText(id));
			ledger.stageDownload({ title: id, text: noteText(id), remote_revision: REVISION }, path);
		}
		if (!await ledger.finishReceipts("fixture-download")) throw new Error("Fixture baseline did not complete");
	};
	const trash = async (id: string) => {
		const file = files.get(`Keep/${id}.md`);
		if (!file) throw new Error("Fixture note absent");
		await plugin.app.vault.trash(file, false);
	};
	return { plugin, vault, stored, folders, files, put, remove, emit, ledger, download, trash,
		cleanup: () => { for (const cleanup of cleanups.reverse()) cleanup(); } };
}
