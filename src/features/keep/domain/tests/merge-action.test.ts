import * as merge from "../merge";
import {
	DEFAULT_MERGE_ACTION,
	MERGE_ACTION_OPTIONS,
	hasMergeCandidates,
	normalizeMergeAction,
	resolveMergeAction,
} from "../merge-action";
import type { SyncPlan, SyncPlanAction } from "@types";

describe("merge actions", () => {
	afterEach(() => jest.restoreAllMocks());

	it("offers the exact labels and defaults unknown values to saving conflicts", () => {
		expect(MERGE_ACTION_OPTIONS.map((option) => option.label)).toEqual([
			"Merge & save conflicts",
			"Merge & skip conflicts",
			"Merge & overwrite conflicts",
			"Overwrite all, no merge",
		]);
		for (const value of [undefined, null, "", "overwrite", {}, 1]) {
			expect(normalizeMergeAction(value)).toBe(DEFAULT_MERGE_ACTION);
		}
	});

	it.each(MERGE_ACTION_OPTIONS)("accepts $value", ({ value }) => {
		expect(normalizeMergeAction(value)).toBe(value);
	});

	it.each(["download", "upload"])("preserves the default conflict copy behavior for %s", () => {
		const result = resolveMergeAction("shared\ndestination edit", "shared\nsource edit");
		expect(result).toEqual({
			action: "conflict-copy",
			hasConflict: true,
			text: "shared\n<<<<<<< existing\ndestination edit\n=======\nsource edit\n>>>>>>> incoming",
		});
	});

	it("skips the whole conflicting note", () => {
		expect(resolveMergeAction("destination", "source", "merge-skip-conflicts")).toEqual({
			action: "skipped-conflict",
			text: "destination",
			hasConflict: true,
		});
	});

	it("uses the source for a conflicting note when overwrite conflicts is selected", () => {
		expect(resolveMergeAction("destination", "source", "merge-overwrite-conflicts")).toEqual({
			action: "overwrite",
			text: "source",
			hasConflict: true,
		});
	});

	it.each(MERGE_ACTION_OPTIONS.slice(0, 3))("merges a clean addition for $value", ({ value }) => {
		expect(resolveMergeAction("shared", "shared\naddition", value)).toEqual({
			action: "merge",
			text: "shared\naddition",
			hasConflict: false,
		});
	});

	it("bypasses the merge algorithm entirely for overwrite all", () => {
		const spy = jest.spyOn(merge, "mergeNoteText");
		expect(resolveMergeAction("destination\nshared", "shared\nsource", "overwrite-all")).toEqual({
			action: "overwrite",
			text: "shared\nsource",
			hasConflict: false,
		});
		expect(spy).not.toHaveBeenCalled();
	});

	it.each(MERGE_ACTION_OPTIONS)("handles identical text for $value", ({ value }) => {
		const result = resolveMergeAction("same", "same", value);
		expect(result.text).toBe("same");
		expect(result.hasConflict).toBe(false);
	});

	it("treats a conflict-only plan as eligible for the selector", () => {
		const makePlan = (actions: SyncPlanAction[]): SyncPlan => ({
			id: "plan",
			mode: "import",
			stage: "import",
			generatedAt: 0,
			title: "Review",
			counts: {},
			selectedCount: 0,
			actionableCount: 0,
			entries: actions.map((action, index) => ({
				id: String(index),
				mode: "import",
				stage: "import",
				title: "Note",
				path: "Keep/note.md",
				action,
				label: action,
				selectable: true,
				selected: false,
				selectionLocked: false,
			})),
		});
		expect(hasMergeCandidates(makePlan(["conflict-copy"]))).toBe(true);
		expect(hasMergeCandidates(makePlan(["merge"]))).toBe(true);
		expect(hasMergeCandidates(makePlan(["upload", "skipped-conflict-copy"]))).toBe(false);
		expect(hasMergeCandidates(makePlan([]))).toBe(false);
	});
});
