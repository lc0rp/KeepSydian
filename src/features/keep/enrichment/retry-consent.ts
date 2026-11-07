import type { PreNormalizedNote } from "../domain/note";
// A per-note UI choice, never reconstructed from saved settings or a background run.
const choices = new WeakSet<PreNormalizedNote>();
export function chooseUncertainRetry(note: PreNormalizedNote, enabled: boolean): void {
	if (enabled) choices.add(note);
	else choices.delete(note);
}
export function hasUncertainRetry(note: PreNormalizedNote): boolean {
	return choices.has(note);
}
export function consumeUncertainRetry(note: PreNormalizedNote): boolean {
	const chosen = choices.has(note);
	choices.delete(note);
	return chosen;
}
