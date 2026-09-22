jest.mock("obsidian");

import { App } from "obsidian";
import { SyncProgressModal } from "../SyncProgressModal";
import type { PreparedSyncPlan, RunPreparedSyncPlanResult, SyncPlanRunCallbacks } from "@app/main-sync-flows";
import type { SyncMode, SyncPlanStage } from "@types";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";

function makePlan(mode: SyncMode = "import", stage: SyncPlanStage = "import", action: "merge" | "conflict-copy" | "create" = "merge") {
	return createPreparedSyncPlanFixture(mode, stage, [createSyncPlanEntryFixture(action, action, { id: "entry", mode, stage })]);
}
function setup(prepared: PreparedSyncPlan) {
	const options = {
		buildSyncPlan: jest.fn(async () => prepared),
		runSyncPlan: jest.fn<Promise<RunPreparedSyncPlanResult>, [PreparedSyncPlan, SyncPlanRunCallbacks?]>().mockResolvedValue({}),
		onOpenSyncLog: jest.fn(), getTwoWayGate: () => ({ allowed: true, reasons: [] }),
		getLastSuccessfulDownloadDate: () => undefined, openTwoWaySettings: jest.fn(),
		getCurrentMode: () => prepared.mode, getCurrentPhaseLabel: () => null,
		isSupporterActive: async () => true, renderImportOptions: jest.fn(),
	};
	const modal = new SyncProgressModal(new App(), options);
	modal.onOpen();
	return { modal, options };
}
async function flush() { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }
function selector(modal: SyncProgressModal) { return modal.contentEl.querySelector<HTMLSelectElement>('[data-keepsidian-role="merge-action"]'); }
function button(modal: SyncProgressModal, text: string) {
	const found = Array.from(modal.contentEl.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(text));
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}

it.each<readonly [SyncMode, SyncPlanStage]>([["import", "import"], ["push", "upload"], ["two-way", "import"], ["two-way", "upload"]])("shows the exact choices on the grouping row for %s/%s", async (mode, stage) => {
	const { modal } = setup(makePlan(mode, stage, "conflict-copy"));
	await modal.beginReview(mode);
	const control = selector(modal)!;
	expect(control).not.toBeNull();
	expect(control.value).toBe("merge-save-conflicts");
	expect(Array.from(control.options).map((option) => option.text)).toEqual([
		"Merge & save conflicts", "Merge & skip conflicts", "Merge & overwrite conflicts", "Overwrite all, no merge",
	]);
	expect(control.closest(".keepsidian-sync-plan-counts")).not.toBeNull();
	expect(control.parentElement?.previousElementSibling?.classList.contains("keepsidian-support-spacer")).toBe(true);
	modal.close();
});

it("hides the selector without merge candidates", async () => {
	const { modal } = setup(makePlan("import", "import", "create"));
	await modal.beginReview();
	expect(selector(modal)).toBeNull();
	modal.close();
});

it("retains selection through filtering and refresh", async () => {
	const prepared = makePlan();
	const { modal, options } = setup(prepared);
	await modal.beginReview();
	const control = selector(modal)!;
	control.value = "merge-skip-conflicts";
	control.dispatchEvent(new Event("change"));
	button(modal, "Notes").click();
	await flush();
	expect(selector(modal)?.value).toBe("merge-skip-conflicts");
	options.buildSyncPlan.mockResolvedValue(makePlan());
	button(modal, "Refresh").click();
	await flush();
	expect(selector(modal)?.value).toBe("merge-skip-conflicts");
	modal.close();
});

it("freezes the policy during execution and reports the actual skip outcome", async () => {
	const prepared = makePlan("import", "import", "conflict-copy");
	const { modal, options } = setup(prepared);
	let settle: SyncPlanRunCallbacks | undefined;
	let finish!: (result: RunPreparedSyncPlanResult) => void;
	options.runSyncPlan.mockImplementation(async (_plan, callbacks) => {
		settle = callbacks;
		return await new Promise<RunPreparedSyncPlanResult>((resolve) => { finish = resolve; });
	});
	await modal.beginReview();
	const detached = selector(modal)!;
	detached.value = "merge-skip-conflicts";
	detached.dispatchEvent(new Event("change"));
	button(modal, "Execute").click();
	await flush();
	expect(selector(modal)).toBeNull();
	expect(modal.contentEl.querySelector(".keepsidian-sync-plan-row.is-pending")).not.toBeNull();
	detached.value = "overwrite-all";
	detached.dispatchEvent(new Event("change"));
	expect(prepared.plan.mergeAction).toBe("merge-skip-conflicts");
	settle?.onEntrySettled?.("entry", true, "skipped-conflict");
	await flush();
	expect(modal.contentEl.querySelector(".keepsidian-sync-plan-row-badge")?.textContent).toBe("Skipped conflict");
	finish({});
	await flush();
	expect(selector(modal)).toBeNull();
	modal.close();
});

it("resets a new plan to the safe default", async () => {
	const { modal, options } = setup(makePlan());
	await modal.beginReview();
	const control = selector(modal)!;
	control.value = "overwrite-all";
	control.dispatchEvent(new Event("change"));
	button(modal, "Back").click();
	await flush();
	options.buildSyncPlan.mockResolvedValue(makePlan());
	await modal.beginReview();
	expect(selector(modal)?.value).toBe("merge-save-conflicts");
	modal.close();
});

it("retains custom date bounds and merge policy through refresh and upload review", async () => {
	const { modal, options } = setup(makePlan("two-way"));
	await flush();
	button(modal, "Customize sync").click();
	await flush();
	const custom = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>(".keepsidian-sync-center-scope-button")).find((candidate) => candidate.textContent === "Custom");
	expect(custom).toBeDefined();
	custom!.click();
	await flush();
	for (const [role, value] of [["custom-since-input", "2024-01-02 00:00"], ["custom-until-input", "2024-01-03 12:00"]]) {
		const input = modal.contentEl.querySelector<HTMLInputElement>(`[data-keepsidian-role="${role}"]`)!;
		expect(input).not.toBeNull();
		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	await modal.beginReview("two-way");
	const scope = { kind: "custom-since", since: new Date(2024, 0, 2, 0, 0).toISOString(), until: new Date(2024, 0, 3, 12, 0).toISOString() };
	expect(options.buildSyncPlan).toHaveBeenLastCalledWith("two-way", expect.anything(), scope);
	const control = selector(modal)!;
	control.value = "merge-skip-conflicts";
	control.dispatchEvent(new Event("change"));
	options.buildSyncPlan.mockResolvedValue(makePlan("two-way"));
	button(modal, "Refresh").click();
	await flush();
	expect(options.buildSyncPlan).toHaveBeenLastCalledWith("two-way", expect.anything(), scope);
	expect(selector(modal)?.value).toBe("merge-skip-conflicts");
	options.runSyncPlan.mockResolvedValue({ nextPlan: makePlan("two-way", "upload") });
	button(modal, "Execute").click();
	await flush();
	expect(selector(modal)?.value).toBe("merge-skip-conflicts");
	expect(modal.contentEl.textContent).toContain("Review upload plan");
	modal.close();
});
