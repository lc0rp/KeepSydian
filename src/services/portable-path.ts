/** New allocations only; never rename an existing identity to enforce this policy. */
export const portableKey = (value: string): string => value.normalize("NFC").toLowerCase().normalize("NFC");
export function truncateUtf8(value: string, budget: number): string {
	let result = "", bytes = 0;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		if (bytes > budget) break;
		result += character;
	}
	return result;
}
export function portableComponent(value: string, budget = 240): string {
	let safe = Array.from(value.normalize("NFC"), character => {
		const code = character.codePointAt(0)!;
		return code < 32 || (code >= 0xd800 && code <= 0xdfff) || '<>:"/\\|?*#[]^%'.includes(character) ? "_" : character;
	}).join("").trim().replace(/[. ]+$/, "");
	if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
	return truncateUtf8(safe, budget).replace(/[. ]+$/, "") || "Untitled";
}
export function portableFile(stem: string, extension: string, suffix = ""): string {
	return `${portableComponent(stem, 240 - suffix.length - extension.length)}${suffix}${extension}`;
}
export function assertRelativePath(path: string, allowRoot = false): void {
	if ((!path && !allowRoot) || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.includes("\0") ||
		(path && path.split("/").some(part => !part || part === "." || part === "..")))
		throw new Error("Unsafe vault-relative path. Choose a folder inside the vault without dot segments.");
}
export interface PathAdapter {
	exists?: (path: string) => Promise<boolean> | boolean;
	list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
}
export async function equivalentPath(adapter: PathAdapter, candidate: string, known?: Iterable<string>): Promise<string | undefined> {
	const key = portableKey(candidate);
	if (known) for (const path of known) if (portableKey(path) === key) return path;
	if (await adapter.exists?.(candidate)) return candidate;
	if (adapter.list) {
		const directory = candidate.slice(0, Math.max(0, candidate.lastIndexOf("/")));
		if (directory && adapter.exists && !await adapter.exists(directory)) return undefined;
		const entries = await adapter.list(directory);
		return [...entries.files, ...entries.folders].find(path => portableKey(path) === key);
	}
	return undefined;
}
const locks = new WeakMap<object, Map<string, Promise<void>>>();
export async function withPathLock<T>(adapter: object, path: string, operation: () => Promise<T>): Promise<T> {
	const key = portableKey(path), pending = locks.get(adapter) ?? new Map<string, Promise<void>>();
	locks.set(adapter, pending);
	const previous = pending.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>(resolve => { release = resolve; });
	pending.set(key, current);
	await previous;
	try { return await operation(); }
	finally { release(); if (pending.get(key) === current) pending.delete(key); }
}
const reservations = new WeakMap<object, Set<string>>();
export async function reserveSibling(adapter: PathAdapter, original: string, suffix: string): Promise<{ path: string; release(): void }> {
	const split = original.lastIndexOf("/"), directory = original.slice(0, split + 1), name = original.slice(split + 1);
	assertRelativePath(directory.slice(0, -1), true);
	const extension = /\.[a-z0-9]{1,10}$/i.exec(name)?.[0] ?? "";
	const stem = extension ? name.slice(0, -extension.length) : name;
	const claims = reservations.get(adapter) ?? new Set<string>();
	reservations.set(adapter, claims);
	for (let counter = 1; counter <= 1000; counter++) {
		const candidate = directory + portableFile(stem, extension, suffix + (counter === 1 ? "" : `-${counter}`));
		assertRelativePath(candidate);
		const key = portableKey(candidate);
		if (claims.has(key) || await equivalentPath(adapter, candidate)) continue;
		if (claims.has(key)) continue;
		claims.add(key);
		return { path: candidate, release: () => { claims.delete(key); } };
	}
	throw new Error("Unable to allocate a separate filename. Existing files were preserved.");
}
