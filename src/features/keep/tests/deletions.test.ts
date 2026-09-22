jest.mock("obsidian");
jest.mock("@integrations/server/keepDeletions", () => ({
	...jest.requireActual("@integrations/server/keepDeletions"),
	fetchDeletedKeepUrls: jest.fn(),
}));
jest.mock("@app/logging", () => ({ logSync: jest.fn().mockResolvedValue(undefined) }));

import { TFile } from "obsidian";
import type KeepSidianPlugin from "@app/main";
import { buildDeletionPlan, executeReviewedDeletions } from "../deletions";
import { excludeDeletionUploads } from "../deletion-upload-exclusions";
import { fetchDeletedKeepUrls } from "@integrations/server/keepDeletions";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";

const fetchDeleted = jest.mocked(fetchDeletedKeepUrls);
const keepUrl = (id: string) => `https://keep.google.com/#NOTE/${id}`;
const body = (id: string, synced = true) =>
	`---\nGoogleKeepUrl: "${keepUrl(id)}"\n${synced ? 'KeepSidianLastSyncedDate: "2026-09-01T00:00:00.000Z"\n' : ""}---\nLocal text\n`;

function setup() {
	const files = new Map<string, TFile>();
	const contents = new Map<TFile, string>();
	const vault = {
		getMarkdownFiles: jest.fn(() => [...files.values()]),
		getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
		read: jest.fn(async (file: TFile) => contents.get(file) ?? ""),
		trash: jest.fn(async (file: TFile, _system: boolean) => { files.delete(file.path); }),
		delete: jest.fn(),
	};
	const settings = { saveLocation: "Keep", email: "test@example.com", token: "token" };
	const cancel = jest.fn();
	const plugin = { app: { vault }, settings, throwIfSyncCancelled: cancel } as unknown as KeepSidianPlugin;
	const add = (path: string, content: string) => {
		const file = Object.assign(new TFile(), { path, basename: path.split("/").pop()!.replace(/\.md$/, ""), extension: "md" });
		files.set(path, file);
		contents.set(file, content);
		return file;
	};
	return { plugin, vault, settings, files, contents, add, cancel };
}

beforeEach(() => {
	jest.clearAllMocks();
	fetchDeleted.mockReset().mockResolvedValue(new Set([keepUrl("one"), keepUrl("two")]));
});

it("plans only previously synced identities in scope; renamed notes still match", async () => {
	const { plugin, add } = setup();
	add("Keep/Nested/Renamed.md", body("one"));
	add("Keep/Active.md", body("active"));
	add("Keep/Never synced.md", body("two", false));
	add("Keep/Different title.md", "Unrelated local note");
	add("KeepOther/Outside.md", body("two"));
	add("Keep/.hidden/Hidden.md", body("two"));
	add("Keep/_KeepSidianLogs/Log.md", body("two"));
	add("Keep/Copy-conflict-123.md", body("two"));
	const plan = await buildDeletionPlan(plugin);
	expect(plan.entries).toHaveLength(1);
	expect(plan.entries[0]).toMatchObject({
		id: "delete:Keep/Nested/Renamed.md", path: "Keep/Nested/Renamed.md", action: "delete",
		selected: true, selectable: true, selectionLocked: false,
	});
	expect(plan.entries[0].meta?.detail).toContain("Attachments are retained");
});

it("does not guess between duplicate local identities", async () => {
	const { plugin, add } = setup();
	add("Keep/First.md", body("one"));
	add("Keep/Second.md", body("one"));
	expect((await buildDeletionPlan(plugin)).entries).toEqual([]);
});

it("does not request deletion evidence for a vault with no previously synced notes", async () => {
	const { plugin, add } = setup();
	add("Keep/Unrelated.md", body("one", false));
	expect((await buildDeletionPlan(plugin)).entries).toEqual([]);
	expect(fetchDeleted).not.toHaveBeenCalled();
});

it("does not infer deletion from an empty feed or from archive state", async () => {
	const { plugin, add } = setup();
	add("Keep/Archived.md", body("one").replace("---\nLocal", "GoogleKeepArchived: true\n---\nLocal"));
	fetchDeleted.mockResolvedValue(new Set());
	expect((await buildDeletionPlan(plugin)).entries).toEqual([]);
});

it("trashes only selected files after a fresh remote check and reports completion", async () => {
	const { plugin, add, vault, files } = setup();
	const first = add("Keep/One.md", body("one"));
	add("Keep/Two.md", body("two"));
	const prepared = await buildDeletionPlan(plugin);
	const callbacks = { onEntrySettled: jest.fn(), reportProgress: jest.fn() };
	await expect(executeReviewedDeletions(plugin, prepared, new Set([prepared.entries[0].id]), callbacks)).resolves.toBe(1);
	expect(fetchDeleted).toHaveBeenCalledTimes(2);
	expect(vault.trash).toHaveBeenCalledTimes(1);
	expect(vault.trash).toHaveBeenCalledWith(first, false);
	expect(vault.delete).not.toHaveBeenCalled();
	expect(files.has("Keep/Two.md")).toBe(true);
	expect(callbacks.onEntrySettled).toHaveBeenCalledWith(prepared.entries[0].id, true);
	expect(callbacks.reportProgress).toHaveBeenCalledTimes(1);
});

it("does nothing for an unchecked deletion and offers it on the next review", async () => {
	const { plugin, add, vault } = setup();
	add("Keep/One.md", body("one"));
	const prepared = await buildDeletionPlan(plugin);
	await expect(executeReviewedDeletions(plugin, prepared, new Set())).resolves.toBe(0);
	expect(fetchDeleted).toHaveBeenCalledTimes(1);
	expect(vault.trash).not.toHaveBeenCalled();
	expect((await buildDeletionPlan(plugin)).entries).toHaveLength(1);
});

it("aborts the entire deletion preflight when a later selected file changed", async () => {
	const { plugin, add, vault, contents } = setup();
	add("Keep/One.md", body("one"));
	const second = add("Keep/Two.md", body("two"));
	const prepared = await buildDeletionPlan(plugin);
	contents.set(second, body("two") + "Edit after review");
	await expect(executeReviewedDeletions(plugin, prepared, new Set(prepared.entries.map((entry) => entry.id)))).rejects.toThrow("changed or moved");
	expect(vault.trash).not.toHaveBeenCalled();
});

it.each(["restored", "network", "account", "folder", "moved", "replaced", "canceled"])(
	"fails closed when the reviewed plan is no longer safe: %s",
	async (change) => {
		const { plugin, add, vault, settings, files, cancel } = setup();
		const file = add("Keep/One.md", body("one"));
		const prepared = await buildDeletionPlan(plugin);
		if (change === "restored") fetchDeleted.mockResolvedValue(new Set());
		if (change === "network") fetchDeleted.mockRejectedValue(new Error("unavailable"));
		if (change === "account") settings.email = "another@example.com";
		if (change === "folder") settings.saveLocation = "Other";
		if (change === "moved") { files.delete(file.path); file.path = "Keep/Moved.md"; files.set(file.path, file); }
		if (change === "replaced") add(file.path, body("one"));
		if (change === "canceled") cancel.mockImplementation(() => { throw new Error("canceled"); });
		await expect(executeReviewedDeletions(plugin, prepared, new Set([prepared.entries[0].id]))).rejects.toThrow();
		expect(vault.trash).not.toHaveBeenCalled();
	}
);

it("never falls back to permanent deletion when trash fails", async () => {
	const { plugin, add, vault } = setup();
	add("Keep/One.md", body("one"));
	const prepared = await buildDeletionPlan(plugin);
	vault.trash.mockRejectedValue(new Error("read-only"));
	const callbacks = { onEntrySettled: jest.fn(), reportProgress: jest.fn() };
	await expect(executeReviewedDeletions(plugin, prepared, new Set([prepared.entries[0].id]), callbacks)).rejects.toThrow("read-only");
	expect(vault.delete).not.toHaveBeenCalled();
	expect(callbacks.onEntrySettled).toHaveBeenCalledWith(prepared.entries[0].id, false);
	expect(callbacks.reportProgress).not.toHaveBeenCalled();
});

it("excludes retained deletions after rename/refresh without renumbering other upload IDs", async () => {
	const { plugin, add } = setup();
	const file = add("Keep/One.md", body("one"));
	const prepared = await buildDeletionPlan(plugin);
	file.path = "Keep/Renamed.md";
	const plan = createPreparedSyncPlanFixture("two-way", "upload", [
		createSyncPlanEntryFixture("upload", "Upload", { id: "upload:0:Keep/Renamed.md", path: file.path }),
		createSyncPlanEntryFixture("upload", "Upload", { id: "upload:1:Keep/Other.md", path: "Keep/Other.md" }),
	]).plan;
	const filtered = excludeDeletionUploads(plan, prepared);
	expect(filtered.entries.map((entry) => entry.id)).toEqual(["upload:1:Keep/Other.md"]);
	expect(filtered).toMatchObject({ selectedCount: 1, actionableCount: 1, counts: { Upload: 1 } });
	expect(plan.entries).toHaveLength(2);
});
