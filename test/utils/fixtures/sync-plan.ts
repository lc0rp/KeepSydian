import type { SyncMode, SyncPlanAction, SyncPlanEntry } from "@types";
import type { PreparedSyncPlan } from "@app/main-sync-flows";

interface EntryFixtureOverrides extends Partial<SyncPlanEntry> {
	id?: string;
}

export function createSyncPlanEntryFixture(
	action: SyncPlanAction,
	label: string,
	overrides: EntryFixtureOverrides = {}
): SyncPlanEntry {
	return {
		id: overrides.id ?? `entry-${action}-${label}`.toLowerCase().replace(/\s+/g, "-"),
		mode: overrides.mode ?? "import",
		stage: overrides.stage ?? "import",
		title: overrides.title ?? "Test note",
		path: overrides.path ?? "Keep/Test note.md",
		action,
		label,
		selectable: overrides.selectable ?? true,
		selected: overrides.selected ?? true,
		selectionLocked: overrides.selectionLocked ?? false,
		selectionLockedReason: overrides.selectionLockedReason,
		meta: overrides.meta,
	};
}

export function createPreparedSyncPlanFixture(
	mode: SyncMode,
	stage: "import" | "upload",
	entries: SyncPlanEntry[],
	overrides: Partial<PreparedSyncPlan["plan"]> = {}
): PreparedSyncPlan {
	const actionableCount = entries.filter((entry) => entry.selectable).length;
	return {
		mode,
		stage,
		importNotes: [],
		pushNotes: [],
		plan: {
			id: overrides.id ?? `${mode}-${stage}-${entries.length}`,
			mode,
			stage,
			generatedAt: overrides.generatedAt ?? Date.now(),
			title:
				overrides.title ??
				(stage === "import" ? "Review download plan" : "Review upload plan"),
			entries,
			counts:
				overrides.counts ??
				entries.reduce<Record<string, number>>((acc, entry) => {
					acc[entry.label] = (acc[entry.label] ?? 0) + 1;
					return acc;
				}, {}),
			selectedCount: overrides.selectedCount ?? actionableCount,
			actionableCount: overrides.actionableCount ?? actionableCount,
		},
	};
}

export function createLargeSyncPlanFixture(): PreparedSyncPlan {
	const entries: SyncPlanEntry[] = [];
	for (let index = 1; index <= 6; index += 1) {
		entries.push(
			createSyncPlanEntryFixture("create", "Create", {
				id: `create-${index}`,
				title: `Create note ${index}`,
				path: `Keep/Create note ${index}.md`,
			})
		);
	}
	for (let index = 1; index <= 3; index += 1) {
		entries.push(
			createSyncPlanEntryFixture("merge", "Merge", {
				id: `merge-${index}`,
				title: `Merge note ${index}`,
				path: `Keep/Merge note ${index}.md`,
			})
		);
	}
	entries.push(
		createSyncPlanEntryFixture("conflict-copy", "Conflict copy", {
			id: "conflict-1",
			title: "Conflict note",
			path: "Keep/Conflict note.md",
		})
	);
	entries.push(
		createSyncPlanEntryFixture("skipped-identical", "Skipped: identical", {
			id: "skip-1",
			title: "Skipped note",
			path: "Keep/Skipped note.md",
			selectable: false,
			selected: false,
		})
	);
	return createPreparedSyncPlanFixture("import", "import", entries);
}
