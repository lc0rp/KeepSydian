import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import { TFile } from "obsidian";
import * as api from "@integrations/server/keepTrash";
import { LocalDeletionLedger } from "../ledger";
import { decodeLedger, deletionAccount, encodeLedger, isSafeVaultPath } from "../state";
import { MAX_SCAN_FILE_BYTES } from "../scan";
import { buildLocalDeletionPlan, executeReviewedLocalDeletions, getLocalDeletionProtection, assertNoUnreviewedLocalDeletions } from "../plan";
import { assertDownloadIdentityPresentOrUntracked } from "../download";
import { withLocalDeletionTrackingSuppressed } from "../tracking";
import { deletionFixture, keepUrl, METADATA, noteText, REVISION } from "./support";

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
let fixture: Awaited<ReturnType<typeof deletionFixture>>;

beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterAll(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
	if (encoderDescriptor) Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor);
});
beforeEach(async () => {
	fixture = await deletionFixture();
	jest.spyOn(api, "requestKeepTrash").mockImplementation(async (_email, _token, notes, apply) => notes.map((note) => ({
		keep_url: note.keep_url, status: apply ? "trashed" as const : "ready" as const,
	})));
});
afterEach(() => { fixture.cleanup(); jest.restoreAllMocks(); });

async function deleted(...ids: string[]) {
	await fixture.download(...ids);
	for (const id of ids) await fixture.trash(id);
	return buildLocalDeletionPlan(fixture.plugin);
}

it("enrolls only completed acknowledged downloads, without bodies or credentials", async () => {
	await fixture.download("a");
	const records = await fixture.ledger.records();
	expect(records).toEqual([expect.objectContaining({ keepUrl: keepUrl("a"), path: "Keep/a.md", revision: REVISION, state: "present" })]);
	const text = fixture.stored.get(METADATA)!;
	expect(text).not.toContain("Fixture body");
	expect(text).not.toContain("fixture@example.com");
	expect(text).not.toContain("fixture-token");
	expect(await decodeLedger(text)).toEqual(expect.objectContaining({ version: 1, records }));
	const reopened = new LocalDeletionLedger(fixture.plugin, METADATA);
	expect(await reopened.records()).toEqual(records);
});

it("does not enroll a new upload, an unknown revision or an abandoned download", async () => {
	fixture.put("Keep/a.md", noteText("a"));
	await fixture.ledger.beginReceipts("new-upload");
	fixture.ledger.stageUpload(keepUrl("a"), "Keep/a.md", REVISION);
	await fixture.ledger.finishReceipts("new-upload");
	expect(await fixture.ledger.records()).toEqual([]);
	await fixture.ledger.beginReceipts("unknown-revision");
	fixture.ledger.stageDownload({ title: "a", text: noteText("a") }, "Keep/a.md");
	await fixture.ledger.finishReceipts("unknown-revision");
	expect(await fixture.ledger.records()).toEqual([]);
	await fixture.ledger.beginReceipts("abandoned");
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	fixture.ledger.discardReceipts("abandoned");
	expect(await fixture.ledger.records()).toEqual([]);
});

it("does not acknowledge a failed later sync or silently advance its baseline", async () => {
	await fixture.download("a");
	await fixture.ledger.beginReceipts("failed-later");
	fixture.ledger.stageUpload(keepUrl("a"), "Keep/a.md", "keep-v1:" + "b".repeat(64));
	fixture.ledger.discardReceipts("failed-later");
	expect((await fixture.ledger.records())[0].revision).toBe(REVISION);
});

it("requires unique identities in a complete enrollment scan", async () => {
	fixture.put("Outside/copy.txt", noteText("a"));
	await fixture.download("a");
	expect(await fixture.ledger.records()).toEqual([]);
});

it("persists an explicit removal witness and produces one selectable row per deletion", async () => {
	const plan = await deleted("a", "b");
	expect(plan.entries).toHaveLength(2);
	expect(plan.entries.every((entry) => entry.action === "delete" && entry.selectable && entry.selected && !entry.selectionLocked)).toBe(true);
	expect(new Set(plan.entries.map((entry) => entry.id)).size).toBe(2);
	expect((await fixture.ledger.records()).every((record) => record.state === "tombstone" && record.witness === "obsidian-trash")).toBe(true);
	expect(api.requestKeepTrash).toHaveBeenCalledWith("fixture@example.com", "fixture-token", [
		{ keep_url: keepUrl("a"), expected_revision: REVISION }, { keep_url: keepUrl("b"), expected_revision: REVISION },
	]);
});

it("preserves the existing non-supporter upload selection lock", async () => {
	await deleted("a");
	const plan = await buildLocalDeletionPlan(fixture.plugin, false, "Available to project supporters");
	expect(plan.entries[0]).toEqual(expect.objectContaining({ action: "delete", selected: true, selectionLocked: true, selectionLockedReason: "Available to project supporters" }));
});

it("never interprets a raw watcher deletion or an offline disappearance as a tombstone", async () => {
	await fixture.download("a");
	const file = fixture.files.get("Keep/a.md")!;
	fixture.remove(file.path);
	fixture.emit("delete", file);
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.candidates).toEqual([]);
	expect(plan.entries[0].action).toBe("skipped-conflict");
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
	expect((await fixture.ledger.records())[0].state).toBe("present");
});

it.each(["Other/renamed.md", ".hidden/renamed.txt", "Keep/renamed.bin"])("recognizes a move to %s rather than a deletion", async (newPath) => {
	await fixture.download("a");
	await fixture.plugin.app.vault.rename(fixture.files.get("Keep/a.md")!, newPath);
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.candidates).toEqual([]);
	expect(plan.entries).toEqual([]);
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
	expect((await fixture.ledger.records())[0]).toEqual(expect.objectContaining({ path: newPath, state: "present" }));
});

it("scans outside the configured folder even when external moves generate no rename event", async () => {
	await fixture.download("a");
	fixture.put("Other/renamed.txt", noteText("a"));
	fixture.remove("Keep/a.md");
	expect((await buildLocalDeletionPlan(fixture.plugin)).entries).toEqual([]);
	expect(await getLocalDeletionProtection(fixture.plugin)).toEqual(new Set());
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
});

it("does not count filtered notes, changed scopes, occupied paths or untracked notes as deletions", async () => {
	await fixture.download("a");
	fixture.plugin.settings.premiumFeatures = { ...fixture.plugin.settings.premiumFeatures, includeNotesTerms: ["no-match"] };
	expect((await buildLocalDeletionPlan(fixture.plugin)).entries).toEqual([]);
	await fixture.trash("a");
	fixture.put("Keep/a.md", "An unrelated replacement at the original path");
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toEqual([]);
	fixture.remove("Keep/a.md");
	fixture.plugin.settings.saveLocation = "Other";
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toEqual([]);
	fixture.put("Other/new.md", "Untracked");
	await fixture.plugin.app.vault.delete(fixture.files.get("Other/new.md")!);
	expect((await fixture.ledger.records())).toHaveLength(1);
});

it("fails closed when a folder listing is filtered or incomplete", async () => {
	await fixture.download("a");
	fixture.vault.adapter.list.mockImplementation(async () => ({ files: [], folders: [] }));
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.hasBlockingConflicts).toBe(true);
	expect(plan.candidates).toEqual([]);
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
});

it.each(["unreadable", "oversize", "malformed-identity", "unstable"])("fails closed on an %s full scan", async (reason) => {
	await deleted("a");
	jest.mocked(api.requestKeepTrash).mockClear();
	fixture.put("Other/check.txt", reason === "malformed-identity" ? "---\nGoogleKeepUrl: invalid\n---\ntext" : "text");
	const read = fixture.vault.adapter.read.getMockImplementation()!;
	if (reason === "unreadable") fixture.vault.adapter.read.mockImplementation(async (path) => {
		if (path === "Other/check.txt") throw new Error("unreadable");
		return read(path);
	});
	if (reason === "oversize") {
		const stat = fixture.vault.adapter.stat.getMockImplementation()!;
		fixture.vault.adapter.stat.mockImplementation(async (path) => path === "Other/check.txt"
			? { type: "file", size: MAX_SCAN_FILE_BYTES + 1, ctime: 1, mtime: 1 } : stat(path));
	}
	if (reason === "unstable") fixture.vault.adapter.read.mockImplementation(async (path) => {
		if (path === "Other/check.txt") fixture.ledger.changed();
		return read(path);
	});
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.hasBlockingConflicts).toBe(true);
	expect(plan.candidates).toEqual([]);
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
});

it("rejects damaged or externally replaced metadata without adopting an empty baseline", async () => {
	await deleted("a");
	fixture.stored.set(METADATA, "{truncated");
	await expect(fixture.ledger.records()).rejects.toThrow();
	const reopened = new LocalDeletionLedger(fixture.plugin, METADATA);
	await expect(reopened.records()).rejects.toThrow();
	expect((await buildLocalDeletionPlan(fixture.plugin)).hasBlockingConflicts).toBe(true);
});

it("protects unchecked and unverified removals from reviewed and automatic download resurrection", async () => {
	const plan = await deleted("a");
	plan.entries[0].selected = false;
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set())).resolves.toBe(0);
	expect(await getLocalDeletionProtection(fixture.plugin)).toEqual(new Set([keepUrl("a")]));
	await expect(assertNoUnreviewedLocalDeletions(fixture.plugin)).rejects.toThrow("review");
	await expect(assertDownloadIdentityPresentOrUntracked(fixture.plugin, { title: "a", text: noteText("a") })).rejects.toThrow("will not recreate");
	expect((await fixture.ledger.records())[0].state).toBe("tombstone");
});

it("applies only selected rows, retires only confirmed ones, and is idempotent", async () => {
	const plan = await deleted("a", "b");
	jest.mocked(api.requestKeepTrash).mockClear();
	const selected = new Set([plan.candidates[0].entryId]);
	expect(await executeReviewedLocalDeletions(fixture.plugin, plan, selected)).toBe(1);
	expect(await executeReviewedLocalDeletions(fixture.plugin, plan, selected)).toBe(0);
	expect(api.requestKeepTrash).toHaveBeenCalledTimes(1);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("b")]);
});

it.each(["conflict", "missing", "unverifiable"] as const)("shows %s without trash eligibility during remote preview", async (status) => {
	await fixture.download("a"); await fixture.trash("a");
	jest.mocked(api.requestKeepTrash).mockResolvedValue([{ keep_url: keepUrl("a"), status }]);
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.entries[0]).toEqual(expect.objectContaining({ action: "skipped-conflict", selectable: false, selected: false }));
	expect(plan.hasBlockingConflicts).toBe(true);
});

it("turns a remote change after review into a visible conflict and does not retire it", async () => {
	const plan = await deleted("a");
	jest.mocked(api.requestKeepTrash).mockResolvedValue([{ keep_url: keepUrl("a"), status: "conflict" }]);
	const settled = jest.fn();
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.candidates[0].entryId]), { onEntrySettled: settled })).rejects.toThrow("changed");
	expect(settled).toHaveBeenCalledWith(plan.candidates[0].entryId, false, "skipped-conflict");
	expect((await fixture.ledger.records())).toHaveLength(1);
});

it("stops partial failures and leaves later rows retryable without acknowledging them", async () => {
	const plan = await deleted("a", "b", "c");
	jest.mocked(api.requestKeepTrash).mockClear().mockImplementation(async (_email, _token, notes) => [{
		keep_url: notes[0].keep_url, status: notes[0].keep_url === keepUrl("b") ? "failed" : "trashed",
	}]);
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set(plan.candidates.map((candidate) => candidate.entryId)))).rejects.toThrow();
	expect(api.requestKeepTrash).toHaveBeenCalledTimes(2);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("b"), keepUrl("c")]);
});

it.each(["account", "scope", "restored", "gate", "metadata"])("revalidates %s before any selected trash mutation", async (change) => {
	const plan = await deleted("a");
	jest.mocked(api.requestKeepTrash).mockClear();
	if (change === "account") fixture.plugin.settings.email = "other@example.com";
	if (change === "scope") fixture.plugin.settings.saveLocation = "Other";
	if (change === "restored") fixture.put("Elsewhere/restored.md", noteText("a"));
	if (change === "gate") {
		const gate = await fixture.plugin.requireTwoWaySafeguards();
		jest.mocked(fixture.plugin.requireTwoWaySafeguards).mockResolvedValue({ ...gate, allowed: false, reasons: [] });
	}
	if (change === "metadata") fixture.stored.set(METADATA, "corrupt");
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.candidates[0].entryId]))).rejects.toThrow();
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
});

it("does not echo reviewed inbound .trash operations as outbound local deletion witnesses", async () => {
	await fixture.download("a");
	await withLocalDeletionTrackingSuppressed(fixture.plugin, () => fixture.trash("a"));
	expect((await fixture.ledger.records())[0].state).toBe("present");
	await fixture.ledger.retireRemoteTrash(new Set([keepUrl("a")]));
	expect(await fixture.ledger.records()).toEqual([]);
});

it("rejects unsafe paths, checksum changes, duplicate identities and account reuse", async () => {
	for (const path of ["/absolute", "C:/absolute", "../escape", "a/../b", "a\\b", "a//b"]) expect(isSafeVaultPath(path)).toBe(false);
	await fixture.download("a");
	const state = await decodeLedger(fixture.stored.get(METADATA)!);
	await expect(encodeLedger({ ...state, records: [...state.records, ...state.records] })).rejects.toThrow();
	await expect(decodeLedger(fixture.stored.get(METADATA)!.replace("Keep/a.md", "Keep/b.md"))).rejects.toThrow();
	expect(await deletionAccount("fixture@example.com")).not.toBe(await deletionAccount("other@example.com"));
	fixture.plugin.settings.email = "other@example.com";
	expect(await fixture.ledger.records()).toEqual([]);
});

it("preserves cancellation rather than treating it as an empty successful scan", async () => {
	await fixture.download("a");
	jest.mocked(fixture.plugin.throwIfSyncCancelled).mockImplementation(() => { throw new Error("fixture canceled"); });
	await expect(fixture.ledger.scan()).rejects.toThrow("fixture canceled");
});

it("ignores untracked explicit removals rather than generating new tombstones", async () => {
	fixture.put("Keep/new.md", "untracked new note");
	await fixture.plugin.app.vault.delete(Object.assign(new TFile(), { path: "Keep/new.md" }));
	expect(await fixture.ledger.records()).toEqual([]);
});
