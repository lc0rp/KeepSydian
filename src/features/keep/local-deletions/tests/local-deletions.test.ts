import { webcrypto } from "crypto";
import { TextEncoder } from "util";
import * as api from "@integrations/server/keepTrash";
import { LocalDeletionLedger, registerDeletionLedger } from "../ledger";
import { decodeLedger, deletionAccount, LegacyLedgerSchema, sha256 } from "../state";
import { MAX_SCAN_FILE_BYTES } from "../scan";
import { buildLocalDeletionPlan, executeReviewedLocalDeletions, getLocalDeletionProtection, assertNoUnreviewedLocalDeletions } from "../plan";
import { assertDownloadIdentityPresentOrUntracked, stageIdenticalDownloadReceipts } from "../download";
import { createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";
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

async function absent(...ids: string[]) {
	await fixture.download(...ids);
	for (const id of ids) fixture.remove(`Keep/${id}.md`);
	return buildLocalDeletionPlan(fixture.plugin);
}

it("persists only completed account/folder receipts, without bodies or credentials", async () => {
	await fixture.download("a");
	const records = await fixture.ledger.records();
	expect(records).toEqual([expect.objectContaining({ keepUrl: keepUrl("a"), path: "Keep/a.md", revision: REVISION, baseline: "synced" })]);
	const text = fixture.stored.get(METADATA)!;
	for (const secret of ["Fixture body", "fixture@example.com", "fixture-token", "witness", "tombstone"]) expect(text).not.toContain(secret);
	expect(await decodeLedger(text)).toMatchObject({ version: 2, scope: "Keep", records });
	expect(await new LocalDeletionLedger(fixture.plugin, METADATA).records()).toEqual(records);
});

it("does not enroll new uploads, unknown receipts, or abandoned downloads", async () => {
	fixture.put("Keep/a.md", noteText("a"));
	await fixture.ledger.beginReceipts("upload");
	fixture.ledger.stageUpload(keepUrl("a"), "Keep/a.md", REVISION);
	await fixture.ledger.finishReceipts("upload");
	expect(await fixture.ledger.records()).toEqual([]);
	await fixture.ledger.beginReceipts("unknown");
	fixture.ledger.stageDownload({ title: "a", text: noteText("a") }, "Keep/a.md");
	await fixture.ledger.finishReceipts("unknown");
	expect(await fixture.ledger.records()).toEqual([]);
	await fixture.ledger.beginReceipts("abandoned");
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	fixture.ledger.discardReceipts("abandoned");
	expect(await fixture.ledger.records()).toEqual([]);
});

it("keeps prior revisions when a later attempt is abandoned", async () => {
	await fixture.download("a");
	await fixture.ledger.beginReceipts("later");
	fixture.ledger.stageUpload(keepUrl("a"), "Keep/a.md", "keep-v1:" + "b".repeat(64));
	fixture.ledger.discardReceipts("later");
	expect((await fixture.ledger.records())[0].revision).toBe(REVISION);
});

it("enrolls one selected receipt despite unchecked actionable rows", async () => {
	fixture.put("Keep/a.md", noteText("a"));
	fixture.put("Keep/b.md", noteText("b"));
	await fixture.ledger.beginReceipts("partial-selection");
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	await stageIdenticalDownloadReceipts(fixture.plugin,
		[{ title: "b", text: noteText("b"), remote_revision: REVISION }], ["b"],
		[createSyncPlanEntryFixture("merge", "Merge", { id: "b", path: "Keep/b.md", selected: false })]);
	expect(await fixture.ledger.finishReceipts("partial-selection")).toBe(true);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("a")]);
});

it("requires unique in-folder identities for enrollment", async () => {
	fixture.put("Keep/nested/copy.txt", noteText("a"));
	await fixture.download("a");
	expect(await fixture.ledger.records()).toEqual([]);
});

it("ignores unrelated outside copies and unreadable files during membership scans", async () => {
	fixture.put("Other/copy.txt", noteText("a"));
	fixture.put(".obsidian/unreadable.json", "private configuration");
	const read = fixture.vault.adapter.read.getMockImplementation()!;
	fixture.vault.adapter.read.mockImplementation(async (path) => {
		if (path.startsWith("Other/") || path === ".obsidian/unreadable.json") throw new Error("must not be read");
		return read(path);
	});
	await fixture.download("a");
	expect((await fixture.ledger.records())).toHaveLength(1);
	fixture.remove("Keep/a.md");
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toHaveLength(1);
	expect(fixture.stored.get("Other/copy.txt")).toBe(noteText("a"));
});

it.each(["offline", "watcher", "obsidian"])("proposes %s absence with the same label and selection semantics", async (kind) => {
	await fixture.download("a");
	const file = fixture.files.get("Keep/a.md")!;
	if (kind === "obsidian") await fixture.trash("a");
	else {
		fixture.remove(file.path);
		if (kind === "watcher") fixture.emit("delete", file);
	}
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.candidates).toHaveLength(1);
	expect(plan.entries[0]).toMatchObject({ label: "No longer in sync folder", action: "delete", selectable: true, selected: true, selectionLocked: false });
});

it("detects offline absence after restarting with the same index", async () => {
	await fixture.download("a");
	fixture.remove("Keep/a.md");
	registerDeletionLedger(fixture.plugin, new LocalDeletionLedger(fixture.plugin, METADATA));
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toHaveLength(1);
});

it.each(["Keep/renamed.md", "Keep/nested/a.md", "Keep/.hidden/a.txt", "Keep/a.bin"])("matches an in-folder move to %s without events", async (path) => {
	await fixture.download("a");
	fixture.put(path, noteText("a")); fixture.remove("Keep/a.md");
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toEqual([]);
	expect(await getLocalDeletionProtection(fixture.plugin)).toEqual(new Set());
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
});

it("proposes move-out and leaves the moved-out local file untouched on execution", async () => {
	await fixture.download("a");
	await fixture.plugin.app.vault.rename(fixture.files.get("Keep/a.md")!, "Other/a.md");
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.entries[0].label).toBe("No longer in sync folder");
	const before = fixture.stored.get("Other/a.md");
	expect(await executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.entries[0].id]))).toBe(1);
	expect(fixture.stored.get("Other/a.md")).toBe(before);
	expect(fixture.stored.has("Keep/a.md")).toBe(false);
});

it("uses identity absence even when an unrelated file occupies the old path", async () => {
	const plan = await absent("a");
	fixture.put("Keep/a.md", "Untracked replacement");
	expect(await executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.entries[0].id]))).toBe(1);
	expect(fixture.stored.get("Keep/a.md")).toBe("Untracked replacement");
});

it("ignores optional download filters when deciding folder membership", async () => {
	await fixture.download("a", "b"); fixture.remove("Keep/a.md");
	fixture.plugin.settings.premiumFeatures = { ...fixture.plugin.settings.premiumFeatures, includeNotesTerms: ["no-match"], archivedStatus: "archived-only" };
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.candidates.map((candidate) => candidate.record.keepUrl)).toEqual([keepUrl("a")]);
});

it("preserves non-supporter upload selection locks", async () => {
	await absent("a");
	const plan = await buildLocalDeletionPlan(fixture.plugin, false, "Available to project supporters");
	expect(plan.entries[0]).toMatchObject({ action: "delete", selected: true, selectionLocked: true });
});

it.each(["scope", "account"])("requires a fresh baseline after a %s change and after switching back", async (kind) => {
	const plan = await absent("a");
	const initial = await fixture.ledger.context();
	if (kind === "scope") fixture.plugin.settings.saveLocation = "Other";
	else fixture.plugin.settings.email = "other@example.com";
	await fixture.ledger.refreshContext();
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toEqual([]);
	fixture.plugin.settings.saveLocation = "Keep"; fixture.plugin.settings.email = "fixture@example.com";
	await fixture.ledger.refreshContext();
	expect((await fixture.ledger.context()).generation).not.toBe(initial.generation);
	expect(await fixture.ledger.records()).toEqual([]);
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.entries[0].id]))).rejects.toThrow();
	await fixture.download("a"); fixture.remove("Keep/a.md");
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toHaveLength(1);
});

it("does not adopt a previous folder's index on restart", async () => {
	await fixture.download("a");
	fixture.plugin.settings.saveLocation = "Other";
	const reopened = new LocalDeletionLedger(fixture.plugin, METADATA);
	expect(await reopened.records()).toEqual([]);
	expect(await decodeLedger(fixture.stored.get(METADATA)!)).toMatchObject({ version: 2, scope: "Other", records: [] });
});

it.each(["unreadable", "oversize", "malformed", "unstable", "filtered", "missing-root"])("offers no removals for an %s folder scan", async (reason) => {
	await absent("a"); jest.mocked(api.requestKeepTrash).mockClear();
	fixture.put("Keep/check.txt", reason === "malformed" ? "---\nGoogleKeepUrl: invalid\n---\ntext" : "text");
	const read = fixture.vault.adapter.read.getMockImplementation()!;
	if (reason === "unreadable" || reason === "unstable") fixture.vault.adapter.read.mockImplementation(async (path) => {
		if (path === "Keep/check.txt") {
			if (reason === "unreadable") throw new Error("private path must not escape");
			fixture.ledger.changed();
		}
		return read(path);
	});
	if (reason === "oversize") {
		const stat = fixture.vault.adapter.stat.getMockImplementation()!;
		fixture.vault.adapter.stat.mockImplementation(async (path) => path === "Keep/check.txt"
			? { type: "file", size: MAX_SCAN_FILE_BYTES + 1, ctime: 1, mtime: 1 } : stat(path));
	}
	if (reason === "filtered") fixture.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
	if (reason === "missing-root") fixture.folders.delete("Keep");
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.hasBlockingConflicts).toBe(true);
	expect(plan.candidates).toEqual([]);
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
	expect(JSON.stringify(plan.entries)).not.toContain("private path");
});

it("does not commit selected receipts from an incomplete folder scan", async () => {
	await fixture.ledger.beginReceipts("incomplete");
	fixture.put("Keep/a.md", noteText("a"));
	fixture.ledger.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	fixture.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
	expect(await fixture.ledger.finishReceipts("incomplete")).toBe(false);
	expect(await fixture.ledger.records()).toEqual([]);
});

it("rejects corrupt or externally replaced metadata rather than adopting an empty baseline", async () => {
	await absent("a"); fixture.stored.set(METADATA, "{truncated");
	await expect(fixture.ledger.records()).rejects.toThrow();
	await expect(new LocalDeletionLedger(fixture.plugin, METADATA).records()).rejects.toThrow();
	expect((await buildLocalDeletionPlan(fixture.plugin)).hasBlockingConflicts).toBe(true);
});

it("migrates v1 identities conservatively and requires a fresh completed receipt", async () => {
	const ledger = LegacyLedgerSchema.parse({ version: 1, account: await deletionAccount("fixture@example.com"), records: [{
		keepUrl: keepUrl("a"), path: "Keep/a.md", scope: "Keep", revision: REVISION, generation: "old",
		state: "tombstone", witness: "obsidian-trash",
	}] });
	fixture.stored.set(METADATA, JSON.stringify({ ledger, digest: await sha256(JSON.stringify(ledger)) }));
	const migrated = new LocalDeletionLedger(fixture.plugin, METADATA);
	registerDeletionLedger(fixture.plugin, migrated);
	expect((await migrated.records())[0]).toMatchObject({ baseline: "legacy", revision: REVISION });
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toEqual([]);
	expect(await getLocalDeletionProtection(fixture.plugin)).toEqual(new Set([keepUrl("a")]));
	fixture.put("Keep/a.md", noteText("a"));
	await migrated.beginReceipts("fresh");
	migrated.stageDownload({ title: "a", text: noteText("a"), remote_revision: REVISION }, "Keep/a.md");
	expect(await migrated.finishReceipts("fresh")).toBe(true);
	fixture.remove("Keep/a.md");
	expect((await buildLocalDeletionPlan(fixture.plugin)).candidates).toHaveLength(1);
	expect(fixture.stored.get(METADATA)).not.toContain("witness");
});

it("protects unchecked offline removals from reviewed and automatic resurrection", async () => {
	const plan = await absent("a"); plan.entries[0].selected = false;
	expect(await executeReviewedLocalDeletions(fixture.plugin, plan, new Set())).toBe(0);
	expect(await getLocalDeletionProtection(fixture.plugin)).toEqual(new Set([keepUrl("a")]));
	await expect(assertNoUnreviewedLocalDeletions(fixture.plugin)).rejects.toThrow();
	await expect(assertDownloadIdentityPresentOrUntracked(fixture.plugin, { title: "a", text: noteText("a") })).rejects.toThrow();
});

it("applies selected rows only, retires confirmed ones, and repeats idempotently", async () => {
	const plan = await absent("a", "b"); jest.mocked(api.requestKeepTrash).mockClear();
	const selected = new Set([plan.candidates[0].entryId]);
	expect(await executeReviewedLocalDeletions(fixture.plugin, plan, selected)).toBe(1);
	expect(await executeReviewedLocalDeletions(fixture.plugin, plan, selected)).toBe(0);
	expect(api.requestKeepTrash).toHaveBeenCalledTimes(1);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("b")]);
});

it.each(["conflict", "missing", "unverifiable"] as const)("leaves %s remote identities unselectable and unacknowledged", async (status) => {
	await absent("a");
	jest.mocked(api.requestKeepTrash).mockResolvedValue([{ keep_url: keepUrl("a"), status }]);
	const plan = await buildLocalDeletionPlan(fixture.plugin);
	expect(plan.entries[0].selectable).toBe(false);
	expect(plan.hasBlockingConflicts).toBe(true);
	expect(await executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.entries[0].id]))).toBe(0);
	expect(await fixture.ledger.records()).toHaveLength(1);
});

it("surfaces late remote conflicts and preserves the baseline", async () => {
	const plan = await absent("a");
	jest.mocked(api.requestKeepTrash).mockResolvedValue([{ keep_url: keepUrl("a"), status: "conflict" }]);
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.entries[0].id]))).rejects.toThrow();
	expect(plan.entries[0]).toMatchObject({ label: "Deletion conflict", selected: false, selectable: false });
	expect(await fixture.ledger.records()).toHaveLength(1);
});

it("stops partial failures and leaves later rows retryable", async () => {
	const plan = await absent("a", "b", "c");
	jest.mocked(api.requestKeepTrash).mockClear().mockImplementation(async (_email, _token, notes) => notes.map((note) => ({
		keep_url: note.keep_url, status: note.keep_url === keepUrl("b") ? "failed" : "trashed",
	})));
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set(plan.entries.map((entry) => entry.id)))).rejects.toThrow();
	expect(api.requestKeepTrash).toHaveBeenCalledTimes(2);
	expect((await fixture.ledger.records()).map((record) => record.keepUrl)).toEqual([keepUrl("b"), keepUrl("c")]);
});

it("acknowledges already-trashed state safely after a lost response", async () => {
	const plan = await absent("a");
	jest.mocked(api.requestKeepTrash).mockRejectedValueOnce(new Error("lost response"));
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.entries[0].id]))).rejects.toThrow();
	jest.mocked(api.requestKeepTrash).mockResolvedValue([{ keep_url: keepUrl("a"), status: "already_trashed" }]);
	const retry = await buildLocalDeletionPlan(fixture.plugin);
	expect(await executeReviewedLocalDeletions(fixture.plugin, retry, new Set([retry.entries[0].id]))).toBe(1);
	expect(await fixture.ledger.records()).toEqual([]);
});

it.each(["restored", "gate", "metadata", "scope", "account"])("revalidates %s before any selected mutation", async (kind) => {
	const plan = await absent("a"); jest.mocked(api.requestKeepTrash).mockClear();
	if (kind === "restored") fixture.put("Keep/nested/restored.md", noteText("a"));
	if (kind === "gate") jest.mocked(fixture.plugin.requireTwoWaySafeguards).mockResolvedValue({ allowed: false, reasons: [], autoUpgrade: false });
	if (kind === "metadata") fixture.stored.set(METADATA, "invalid");
	if (kind === "scope") fixture.plugin.settings.saveLocation = "Other";
	if (kind === "account") fixture.plugin.settings.email = "other@example.com";
	await expect(executeReviewedLocalDeletions(fixture.plugin, plan, new Set([plan.entries[0].id]))).rejects.toThrow();
	expect(api.requestKeepTrash).not.toHaveBeenCalled();
});

it("retires only confirmed reverse-direction identities without an outbound echo", async () => {
	await fixture.download("a", "b");
	fixture.remove("Keep/a.md"); fixture.put(".trash/a.md", noteText("a"));
	await fixture.ledger.retireRemoteTrash(new Set([keepUrl("a")]));
	expect((await buildLocalDeletionPlan(fixture.plugin)).entries).toEqual([]);
	expect(fixture.stored.has(".trash/a.md")).toBe(true);
});

it("propagates cancellation instead of accepting an empty successful scan", async () => {
	await absent("a");
	jest.mocked(fixture.plugin.throwIfSyncCancelled).mockImplementation(() => { throw new Error("canceled"); });
	await expect(fixture.ledger.scan()).rejects.toThrow("canceled");
});
