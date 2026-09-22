import type { DownloadScope } from "@types";

const INPUT_FORMAT = "YYYY-MM-DD HH:MM";
const INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))$/;
let rangeSequence = 0;

interface ParsedInput {
	iso?: string;
	error?: string;
}

function parseInput(value: string, field: "start" | "end", now: number): ParsedInput {
	const trimmed = value.trim();
	const name = field === "start" ? "custom date" : "custom end date";
	if (!trimmed) return { error: `Choose a ${name}.` };
	const match = trimmed.match(INPUT_PATTERN);
	if (!match) return { error: `Choose a valid ${name}.` };
	const [, yearText, monthText, dayText, hourText, minuteText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
	if (
		!Number.isFinite(parsed.getTime()) ||
		parsed.getFullYear() !== year ||
		parsed.getMonth() !== month - 1 ||
		parsed.getDate() !== day ||
		parsed.getHours() !== hour ||
		parsed.getMinutes() !== minute
	) {
		return { error: `Choose a valid ${name}.` };
	}
	if (parsed.getTime() > now) {
		return { error: field === "start" ? "Custom date must be in the past." : "Custom end date must be in the past." };
	}
	return { iso: parsed.toISOString() };
}

export function parseCustomScopeRange(
	since: string,
	until: string,
	now = Date.now()
): { scope: DownloadScope; startError?: string; endError?: string } {
	const start = parseInput(since, "start", now);
	const end = until.trim() ? parseInput(until, "end", now) : {};
	const endError =
		start.iso && end.iso && Date.parse(start.iso) >= Date.parse(end.iso)
			? "End date must be after the start date."
			: end.error;
	return {
		scope: { kind: "custom-since", since: start.iso, ...(end.iso ? { until: end.iso } : {}) },
		startError: start.error,
		endError,
	};
}

interface DateRangeInputState {
	since: string;
	until: string;
	disabled: boolean;
}

/** Keep the inputs mounted when moving focus between them. */
export function renderCustomScopeInputs(
	containerEl: HTMLElement,
	state: DateRangeInputState,
	onChange: (value: { since: string; until: string }) => void
): void {
	const rangeId = `keepsidian-date-range-${++rangeSequence}`;
	const createField = (field: "start" | "end", value: string) => {
		const wrap = containerEl.createEl("label", { cls: "keepsidian-sync-center-scope-input-wrap" });
		wrap.createEl("span", {
			text: field === "start" ? "Start:" : "End:",
			cls: "keepsidian-sync-center-scope-input-label",
		});
		const input = wrap.createEl("input", { cls: "keepsidian-sync-center-scope-input" });
		input.type = "text";
		input.value = value;
		input.placeholder = field === "start" ? INPUT_FORMAT : "Now (at sync start)";
		input.autocomplete = "off";
		input.disabled = state.disabled;
		input.setAttribute("aria-label", `Custom ${field} date (${INPUT_FORMAT})`);
		input.setAttribute("data-keepsidian-role", field === "start" ? "custom-since-input" : "custom-until-input");
		const helper = containerEl.createEl("div", { cls: "keepsidian-sync-center-scope-helper" });
		helper.id = `${rangeId}-${field}-help`;
		input.setAttribute("aria-describedby", helper.id);
		return { input, helper };
	};
	const start = createField("start", state.since);
	const end = createField("end", state.until);
	const syncHelpers = () => {
		const parsed = parseCustomScopeRange(start.input.value, end.input.value);
		start.helper.textContent =
			parsed.startError ?? `Use ${INPUT_FORMAT}. Notes changed after this date will be included.`;
		end.helper.textContent =
			parsed.endError ??
			`Use ${INPUT_FORMAT}. Notes changed before this date will be included. Leave blank to use the time sync starts.`;
		start.helper.classList.toggle("is-warning", Boolean(parsed.startError));
		end.helper.classList.toggle("is-warning", Boolean(parsed.endError));
		start.input.setAttribute("aria-invalid", String(Boolean(parsed.startError)));
		end.input.setAttribute("aria-invalid", String(Boolean(parsed.endError)));
	};
	const changed = () => {
		onChange({ since: start.input.value, until: end.input.value });
		syncHelpers();
	};
	for (const { input } of [start, end]) {
		input.addEventListener("input", changed);
		input.addEventListener("change", changed);
	}
	syncHelpers();
}
