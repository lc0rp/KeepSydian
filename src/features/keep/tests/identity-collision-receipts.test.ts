import { createHash, webcrypto } from "crypto";
import { TextEncoder } from "util";
import * as api from "@integrations/server/keepApi";
import { buildImportSyncPlan, processAndSaveNotes } from "../sync";
import { stageIdenticalDownloadReceipts, StaleDownloadReviewError } from "../local-deletions/download";
import { deletionFixture, keepUrl, REVISION } from "../local-deletions/tests/support";

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
const originalPath = "Keep/Shared.md";
const content = `---\nGoogleKeepUrl: ${keepUrl("original")}\nKeepSidianLastSyncedDate: 2026-09-01T00:00:00.000Z\n---\nSame body`;
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
	fixture.put(originalPath, content);
	jest.spyOn(api, "fetchNotes").mockResolvedValue({
		notes: ["incoming-a", "incoming-b", "original"].map((id) => ({
			id,
			title: "Shared",
			text: "Same body",
			remote_revision: REVISION,
		})),
		total_notes: 3,
	});
});
afterEach(() => {
	fixture.cleanup();
	jest.restoreAllMocks();
});

const prepare = () => buildImportSyncPlan(fixture.plugin, undefined, true, undefined, undefined, { kind: "all" });

it("reviews distinct same-title/body identities as separate creates and enrolls only the matching unchanged note", async () => {
	const built = await prepare();
	expect(built.plan.entries.map((entry) => entry.action)).toEqual(["create", "create", "skipped-identical"]);
	expect(new Set(built.plan.entries.map((entry) => entry.path)).size).toBe(3);
	expect(built.plan.entries[2].path).toBe(originalPath);
	expect(fixture.stored.get(originalPath)).toBe(content);
	expect(fixture.vault.adapter.write).not.toHaveBeenCalled();
	await fixture.ledger.beginReceipts("identity-review");
	await expect(
		stageIdenticalDownloadReceipts(fixture.plugin, built.notes, built.noteEntryIds, built.plan.entries)
	).resolves.toBeUndefined();
	expect(await fixture.ledger.finishReceipts("identity-review")).toBe(true);
	expect(await fixture.ledger.records()).toEqual([
		expect.objectContaining({ keepUrl: keepUrl("original"), path: originalPath, baseline: "synced" }),
	]);
});

it.each(["body", "identity", "missing"])("still rejects a genuinely stale %s after the review", async (change) => {
	const built = await prepare();
	await fixture.ledger.beginReceipts("stale-review");
	if (change === "body") fixture.put(originalPath, content.replace("Same body", "Changed after review"));
	if (change === "identity") fixture.put(originalPath, content.replace(keepUrl("original"), keepUrl("replacement")));
	if (change === "missing") fixture.remove(originalPath);
	await expect(
		stageIdenticalDownloadReceipts(fixture.plugin, built.notes, built.noteEntryIds, built.plan.entries)
	).rejects.toBeInstanceOf(StaleDownloadReviewError);
	fixture.ledger.discardReceipts("stale-review");
	expect(await fixture.ledger.records()).toEqual([]);
	expect(fixture.plugin.settings.keepSidianLastSuccessfulSyncDate).toBe("2026-09-01T00:00:00.000Z");
});

it("keeps both identities when concurrent saves converge on an allocated filename", async () => {
	const suffix = createHash("sha256").update(keepUrl("incoming-a")).digest("hex");
	const notes = [
		{ id: "incoming-a", title: "Shared", text: "First synthetic body", remote_revision: REVISION },
		{ id: "incoming-b", title: `Shared--keep-${suffix}`, text: "Second synthetic body", remote_revision: REVISION },
	];
	jest.mocked(api.fetchNotes).mockResolvedValue({ notes, total_notes: notes.length });
	const built = await prepare();
	expect(built.plan.entries.map((entry) => entry.action)).toEqual(["create", "create"]);
	expect(new Set(built.plan.entries.map((entry) => entry.path)).size).toBe(2);
	await processAndSaveNotes(fixture.plugin, notes);
	expect(fixture.stored.get(originalPath)).toBe(content);
	const saved = [...fixture.stored.entries()].filter(
		([path]) =>
			path.startsWith("Keep/") && !path.includes("/_KeepSidianLogs/") && path.endsWith(".md") && path !== originalPath
	);
	expect(saved).toHaveLength(2);
	for (const note of notes) {
		const matches = saved.filter(([, text]) => text.includes(keepUrl(note.id)));
		expect(matches).toHaveLength(1);
		expect(matches[0][1]).toContain(note.text);
	}
});
