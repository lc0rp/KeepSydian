export const SUPPORTER_KEY_SECRET_ID = "keepsidian-supporter-key";

export function formatSupporterKeyInput(value: string): string {
	const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
	return compact.match(/.{1,4}/g)?.join("-") ?? "";
}

export function normalizeSupporterKey(value: string): string | null {
	const compact = value.trim().toUpperCase().replace(/[\s-]/g, "");
	if (!/^[A-Z0-9]{16}$/.test(compact)) {
		return null;
	}
	return compact.match(/.{4}/g)?.join("-") ?? null;
}

export function createSupporterKeyIdentity(supporterKey: string): string {
	let h1 = 1779033703;
	let h2 = 3144134277;
	let h3 = 1013904242;
	let h4 = 2773480762;
	for (let index = 0; index < supporterKey.length; index += 1) {
		const code = supporterKey.charCodeAt(index);
		h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
		h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
		h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
		h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
	}
	h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
	h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
	h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
	h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
	return [h1, h2, h3, h4].map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}
