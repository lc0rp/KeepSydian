import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";
import { deletionReviewSummary, markDeletionConflict, retainUncheckedDeletions } from "../deletion-review";

function uploadPlan() {
	return createPreparedSyncPlanFixture("push", "upload", ["a", "b"].map((id) => createSyncPlanEntryFixture("delete", "Delete from Google Keep", {
		id: `upload-delete:${id}`, path: `Keep/${id}.md`, stage: "upload", mode: "push", selected: true, selectable: true, selectionLocked: false,
	}))).plan;
}

it("names Google Keep Trash, includes selected and total counts, and never promises permanent deletion", () => {
	const plan = uploadPlan();
	plan.entries[1].selected = false;
	const summary = deletionReviewSummary(plan);
	expect(summary).toContain("1 of 2 local deletions selected");
	expect(summary).toContain("Google Keep Trash, never permanently deleted");
	expect(summary).toContain("Uncheck a deletion");
	expect(summary).not.toContain("deleted from Obsidian");
});

it("uses cancel guidance instead of offering a locked checkbox to non-supporters", () => {
	const plan = uploadPlan();
	for (const entry of plan.entries) entry.selectionLocked = true;
	expect(deletionReviewSummary(plan)).toContain("Existing supporter selection locks apply");
	expect(deletionReviewSummary(plan)).toContain("cancel this plan");
});

it("preserves the existing reverse-direction review wording and recoverable .trash", () => {
	const plan = uploadPlan();
	plan.stage = "import";
	expect(deletionReviewSummary(plan)).toContain("2 notes will be deleted from Obsidian (moved to .trash)");
	expect(deletionReviewSummary(plan)).toContain("Attachments are retained");
});

it("does not silently reselect an unchecked deletion during upload review refresh", () => {
	const previous = uploadPlan();
	previous.entries[0].selected = false;
	const refreshed = uploadPlan();
	refreshed.entries[0].selectionLocked = true;
	const retained = retainUncheckedDeletions(previous, refreshed);
	expect(retained.entries.map((entry) => entry.selected)).toEqual([false, true]);
	expect(retained.selectedCount).toBe(1);
	expect(retained.entries[0].selectionLocked).toBe(true);
	expect(refreshed.entries[0].selected).toBe(true);
});

it("exposes a late deletion conflict without changing its execution identity or handled-count inputs", () => {
	const entry = uploadPlan().entries[0];
	markDeletionConflict(entry);
	expect(entry).toMatchObject({ id: "upload-delete:a", action: "skipped-conflict", label: "Deletion conflict", selected: true, selectable: true });
	expect(entry.meta?.detail).toContain("This note was not trashed");
});
