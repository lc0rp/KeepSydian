/** An explicit choice held only in memory. Serialized settings cannot recreate it. */
declare const consentBrand: unique symbol;
export type LegacyTagConsent = { readonly [consentBrand]: true };
type Binding = { namespace: string; sources: Set<string> };
const consents = new WeakMap<LegacyTagConsent, Binding | undefined>();

export function chooseLegacyTags(): LegacyTagConsent {
	const consent = Object.freeze({}) as LegacyTagConsent;
	consents.set(consent, undefined);
	return consent;
}

export function bindLegacyTagConsent(value: unknown, namespace: string, sources: string[]): void {
	if (!value || typeof value !== "object" || !consents.has(value as LegacyTagConsent)) return;
	if (consents.get(value as LegacyTagConsent) === undefined)
		consents.set(value as LegacyTagConsent, { namespace, sources: new Set(sources) });
}

export function permitsLegacyTags(value: unknown, namespace: string, source: string): boolean {
	if (!value || typeof value !== "object") return false;
	const binding = consents.get(value as LegacyTagConsent);
	return binding?.namespace === namespace && binding.sources.has(source);
}
