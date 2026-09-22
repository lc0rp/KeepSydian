import type { MergeAction, SyncPlan } from "@types";
import { MERGE_ACTION_OPTIONS, hasMergeCandidates, normalizeMergeAction } from "@features/keep/domain/merge-action";

/** The owner guards detached controls against changing a running or replaced plan. */
export function renderMergeActionSelector(
	container: HTMLElement,
	plan: SyncPlan,
	onChange: (action: MergeAction) => void,
	disabled = false
): HTMLSelectElement | null {
	if (!hasMergeCandidates(plan)) return null;

	// Reuse the shipped flex spacer and wrapping inline-control styles. A spacer
	// consumes the remaining chip-row width without a fixed desktop-only offset.
	const spacer = container.ownerDocument.createElement("span");
	spacer.className = "keepsidian-sync-plan-merge-spacer keepsidian-support-spacer";
	spacer.setAttribute("aria-hidden", "true");
	container.appendChild(spacer);
	const label = container.ownerDocument.createElement("label");
	label.className = "keepsidian-sync-plan-merge-action keepsidian-support-links keepsidian-support-label";
	const caption = container.ownerDocument.createElement("span");
	caption.textContent = "Merge action:";
	label.appendChild(caption);
	const select = container.ownerDocument.createElement("select");
	select.setAttribute("aria-label", "Merge action");
	select.setAttribute("data-keepsidian-role", "merge-action");
	select.disabled = disabled;
	select.title = plan.stage === "upload"
		? "Uploads use the vault as source. Conflicting notes are saved locally, skipped, or replaced in Keep according to this choice."
		: "Downloads use Keep as source. Conflicting notes are saved separately, skipped, or replaced in the vault according to this choice.";
	for (const option of MERGE_ACTION_OPTIONS) {
		const element = container.ownerDocument.createElement("option");
		element.value = option.value;
		element.textContent = option.label;
		select.appendChild(element);
	}
	select.value = normalizeMergeAction(plan.mergeAction);
	select.addEventListener("change", () => {
		if (!select.disabled) onChange(normalizeMergeAction(select.value));
	});
	label.appendChild(select);
	container.appendChild(label);
	return select;
}
