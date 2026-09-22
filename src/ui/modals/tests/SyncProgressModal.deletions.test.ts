jest.mock("obsidian");

import { App, TFile } from "obsidian";
import { SyncProgressModal } from "../SyncProgressModal";
import type { PreparedSyncPlan, RunPreparedSyncPlanResult, SyncPlanRunCallbacks } from "@app/main-sync-flows";
import { createPreparedSyncPlanFixture, createSyncPlanEntryFixture } from "@test-utils/fixtures/sync-plan";

const deletion = (id: string) => createSyncPlanEntryFixture("delete", "Delete from Obsidian", {
	id: `delete:${id}`, title: id, path: `Keep/${id}.md`, selected: true, selectionLocked: false,
});

function setup(prepared: PreparedSyncPlan) {
	const buildSyncPlan = jest.fn().mockResolvedValue(prepared);
	const runSyncPlan = jest.fn<Promise<RunPreparedSyncPlanResult>, [PreparedSyncPlan, SyncPlanRunCallbacks?]>()
		.mockResolvedValue({});
	const modal = new SyncProgressModal(new App(), {
		buildSyncPlan, runSyncPlan,
		onOpenSyncLog: jest.fn(),
		getTwoWayGate: () => ({ allowed: true, reasons: [] }),
		getLastSuccessfulDownloadDate: () => undefined,
		openTwoWaySettings: jest.fn(),
		getCurrentMode: () => null,
		getCurrentPhaseLabel: () => null,
		isSupporterActive: async () => false,
		renderImportOptions: jest.fn(),
	});
	document.body.appendChild(modal.containerEl);
	return { modal, buildSyncPlan, runSyncPlan };
}

afterEach(() => document.body.replaceChildren());

function button(modal: SyncProgressModal, label: string): HTMLButtonElement {
	const result = Array.from(modal.contentEl.querySelectorAll("button")).find((el) => el.textContent?.includes(label));
	expect(result).toBeTruthy();
	return result!;
}

async function flushUI() {
	for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

it("shows the deletion count and lets non-supporters deselect without unlocking ordinary imports", async () => {
	const prepared = createPreparedSyncPlanFixture("import", "import", [
		deletion("One"), deletion("Two"),
		createSyncPlanEntryFixture("create", "Create", { id: "create", title: "New", selectionLocked: true }),
	]);
	const { modal } = setup(prepared);
	await modal.beginReview();
	expect(button(modal, "Delete 2")).toBeTruthy();
	expect(modal.contentEl.textContent).toContain("2 notes will be deleted from Obsidian");
	expect(modal.contentEl.textContent).toContain("moved to .trash");
	const toggle = modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="Delete from Obsidian: One"]')!;
	expect(toggle.disabled).toBe(false);
	expect(modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="Create: New"]')!.disabled).toBe(true);
	toggle.click();
	await flushUI();
	expect(prepared.plan.entries[0].selected).toBe(false);
	expect(modal.contentEl.textContent).toContain("1 note will be deleted from Obsidian");
	button(modal, "Delete 2").click();
	await flushUI();
	expect(modal.contentEl.querySelectorAll(".keepsidian-sync-plan-row")).toHaveLength(2);
});

it("bulk deselection leaves a deletion-only plan with zero deletions and Execute disabled", async () => {
	const { modal } = setup(createPreparedSyncPlanFixture("import", "import", [deletion("One")]));
	await modal.beginReview();
	modal.contentEl.querySelector<HTMLInputElement>(".keepsidian-sync-plan-select-all input")!.click();
	await flushUI();
	expect(modal.contentEl.textContent).toContain("0 notes will be deleted from Obsidian");
	expect(button(modal, "Execute").disabled).toBe(true);
});

it("counts only successful deletions as Deleted while showing failed rows honestly", async () => {
	const { modal, runSyncPlan } = setup(createPreparedSyncPlanFixture("import", "import", [deletion("One"), deletion("Two")]));
	runSyncPlan.mockImplementation(async (_prepared, callbacks) => {
		callbacks?.onEntrySettled?.("delete:One", true);
		callbacks?.onEntrySettled?.("delete:Two", false);
		return { failed: true };
	});
	await modal.beginReview();
	button(modal, "Execute").click();
	await flushUI();
	expect(button(modal, "Deleted 1/2")).toBeTruthy();
	expect(modal.contentEl.querySelector(".is-failed .keepsidian-sync-plan-row-badge")?.textContent).toBe("Failed");
});

it("preserves a kept deletion through the two-way upload review and Refresh", async () => {
	const deleted = deletion("One");
	deleted.selected = false;
	const prepared = createPreparedSyncPlanFixture("two-way", "import", [deleted,
		createSyncPlanEntryFixture("create", "Create", { id: "create", path: "Keep/New.md" }),
	]);
	const file = Object.assign(new TFile(), { path: deleted.path });
	prepared.deletions = {
		accountEmail: "test@example.com", rootFolder: "Keep", entries: [deleted],
		candidates: [{ entryId: deleted.id, path: deleted.path, keepUrl: "https://keep.google.com/#NOTE/one", content: "", file }],
	};
	const upload = () => createPreparedSyncPlanFixture("two-way", "upload", [
		createSyncPlanEntryFixture("upload", "Upload", { id: "upload:0:Keep/One.md", path: "Keep/One.md", title: "One" }),
		createSyncPlanEntryFixture("upload", "Upload", { id: "upload:1:Keep/New.md", path: "Keep/New.md", title: "New" }),
	]);
	const { modal, buildSyncPlan, runSyncPlan } = setup(prepared);
	runSyncPlan.mockResolvedValue({ nextPlan: upload() });
	await modal.beginReview("two-way");
	button(modal, "Execute").click();
	await flushUI();
	expect(modal.contentEl.querySelectorAll(".keepsidian-sync-plan-row")).toHaveLength(1);
	expect(modal.contentEl.querySelector(".keepsidian-sync-plan-row-title")?.textContent).toBe("New");
	buildSyncPlan.mockResolvedValue(upload());
	file.path = "Keep/Renamed.md";
	button(modal, "Refresh").click();
	await flushUI();
	expect(buildSyncPlan).toHaveBeenLastCalledWith("push", expect.objectContaining({
		protectedPaths: ["Keep/One.md", "Keep/Renamed.md"],
	}));
	expect(modal.contentEl.querySelectorAll(".keepsidian-sync-plan-row")).toHaveLength(1);
	expect(modal.contentEl.querySelector(".keepsidian-sync-plan-row-title")?.textContent).toBe("New");
});
