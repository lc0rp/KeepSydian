/** Portable filename regressions, including the 40 former audit gaps. */
jest.mock("obsidian");
jest.mock("@services/http", () => ({ httpGetArrayBuffer: jest.fn() }));
jest.mock("@app/logging", () => ({ logSync: jest.fn(async () => {}) }));
import { resolveNoteFileName, resolveCustomSaveLocation } from "@services/note-path-resolver";
import { httpGetArrayBuffer } from "@services/http";
import { reserveConflictPath } from "../io/conflict-path";
import { processAttachments } from "../io/attachments";
import { isSafeVaultPath } from "../local-deletions/state";
import { prepareReviewedUploads, type ReviewedPushNote } from "../push/merge-review";
import type KeepSidianPlugin from "@app/main";
import { findExistingKeepNotePath } from "../domain/noteLookup";
import { normalizeNote } from "../domain/note";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});
afterAll(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor); else Reflect.deleteProperty(globalThis, "crypto");
	if (encoderDescriptor) Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor); else Reflect.deleteProperty(globalThis, "TextEncoder");
});

const timestamp = "2026-10-10T20:00:00.000Z";
const devices = ["CON", "prn", "AuX.txt", "NUL.tar.gz", "COM1", "com9.txt", "LPT1", "lpt9.foo", "COM¹", "COM².txt", "LPT³"];
function windowsProblems(name: string): string[] {
	const problems: string[] = [];
	if (Array.from(name).some(char => char.charCodeAt(0) < 32) || /[<>:"/\\|?*]/.test(name)) problems.push("character");
	if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) problems.push("device");
	if (/[. ]$/.test(name)) problems.push("trailing");
	if (name.length > 255) problems.push("UTF16-length");
	return problems;
}
const leaf = (name: string) => name.slice(name.lastIndexOf("/") + 1);
async function conflict(stem: string) {
	const reservation = await reserveConflictPath({ exists: async () => false }, `Keep/${stem}.md`, timestamp);
	reservation.release(); return leaf(reservation.path);
}
beforeEach(() => {
	jest.mocked(httpGetArrayBuffer).mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
	jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each([...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), ...'<>:"\\|?*'])("download conflict replaces reserved/control character %j", async character => {
	expect(windowsProblems(await conflict(`a${character}b`))).toEqual([]);
});
it.each(devices)("download conflict protects device stem %s", async stem => {
	expect(windowsProblems(await conflict(stem))).toEqual([]);
});
it.each(["tail. ", "a".repeat(300), "😀".repeat(100), "é".repeat(200), "e\u0301".repeat(150)])("download conflict bounds stem %j", async stem => {
	const name = await conflict(stem);
	expect(windowsProblems(name)).toEqual([]);
	expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
	expect(name).not.toContain("\0");
});
it("normal title removes both separators and ordinary Windows punctuation", () => {
	const name = resolveNoteFileName("{title}", { title: 'a<>:"/\\|?*b' });
	expect(windowsProblems(name)).toEqual([]);
	expect(name).not.toContain("/");
});
it("blank-title fallback is a legal component under Windows and POSIX rules", () => {
	const name = resolveNoteFileName("{title}", { title: "" });
	expect(name).toBe("Untitled KeepSidian Note.md");
	expect(windowsProblems(name)).toEqual([]);
});

it.each(devices)("ordinary title should protect Windows device %s", stem => {
	expect(windowsProblems(resolveNoteFileName("{title}", { title: stem }))).toEqual([]);
});
it.each(["a\0b", "a\u0001b", "a\nb"])("ordinary title should remove control %j", title => {
	expect(windowsProblems(resolveNoteFileName("{title}", { title }))).toEqual([]);
});
it.each(["a".repeat(253), "😀".repeat(64)])("ordinary title should fit the final component byte budget (%j)", title => {
	expect(Buffer.byteLength(resolveNoteFileName("{title}", { title }), "utf8")).toBeLessThanOrEqual(255);
});
it.each(["Keep/../outside", "Keep/.", "Keep/\0folder"])("folder resolver should enforce containment for %j", folder => {
	expect(() => resolveCustomSaveLocation(folder, {})).toThrow(/folder|path/i);
});
it.each(["Keep/CON", "Keep/trailing."])("folder resolver should protect Windows segment %s", folder => {
	expect(() => resolveCustomSaveLocation(folder, {})).toThrow(/folder|path/i);
});
it("simultaneous APFS-equivalent Unicode reservations should be distinct", async () => {
	const adapter = { exists: async () => false };
	const claims = await Promise.all(["café", "cafe\u0301"].map(name => reserveConflictPath(adapter, `Keep/${name}.md`, timestamp)));
	try { expect(new Set(claims.map(claim => claim.path.normalize("NFC").toLowerCase())).size).toBe(2); }
	finally { claims.forEach(claim => claim.release()); }
});
it("simultaneous ASCII case variants receive distinct reserved names", async () => {
	const adapter = { exists: async () => false };
	const claims = await Promise.all(["Note", "note"].map(name => reserveConflictPath(adapter, `Keep/${name}.md`, timestamp)));
	try { expect(new Set(claims.map(claim => claim.path.toLowerCase())).size).toBe(2); }
	finally { claims.forEach(claim => claim.release()); }
});
it("ordinary note planning should reserve distinct case-insensitive identities", async () => {
	const app = { vault: { adapter: { exists: async () => false, read: async () => "" } } };
	const index = { pathByKeepUrl: new Map<string, string>(), existingPaths: new Set<string>() };
	const paths = await Promise.all(["Note", "note"].map((title, i) => findExistingKeepNotePath(app, normalizeNote({ id: `synthetic-${i}`, title, text: "synthetic" }), `Keep/${title}.md`, index)));
	expect(new Set(paths.map(name => name!.toLowerCase())).size).toBe(2);
});
it("identity collision fallback should sanitize a reserved device stem", async () => {
	const preferred = "Keep/CON.notes.md";
	const app = { vault: { adapter: { exists: async (name: string) => name === preferred, read: async () => "---\nGoogleKeepUrl: https://keep.google.com/#NOTE/other\n---\nOther content" } } };
	const generated = await findExistingKeepNotePath(app, normalizeNote({ id: "synthetic-new", title: "CON.notes", text: "Synthetic" }), preferred, { pathByKeepUrl: new Map(), existingPaths: new Set([preferred]) });
	expect(generated).not.toBe(preferred);
	expect(windowsProblems(leaf(generated!))).toEqual([]);
});
it("models the ext4 byte limit separately from Windows UTF-16 component limits", () => {
	const name = "😀".repeat(64) + ".md";
	expect(name.length).toBeLessThan(255);
	expect(windowsProblems(name)).toEqual([]);
	expect(Buffer.byteLength(name, "utf8")).toBeGreaterThan(255);
	// A normal case-sensitive, normalization-sensitive directory distinguishes these.
	expect(new Set(["Note", "note", "café", "cafe\u0301"]).size).toBe(4);
});
it("conflict helper rejects unsafe parent components", async () => {
	await expect(reserveConflictPath({ exists: async () => false }, "../outside/note.md", timestamp)).rejects.toThrow(/path/i);
});

async function attachment(name: string, adapter?: Parameters<typeof processAttachments>[0]["vault"]["adapter"]) {
	const writes: string[] = [];
	const result = await processAttachments({ vault: { adapter: adapter ?? { exists: async () => false, writeBinary: async target => { writes.push(target); } } } }, ["https://example.invalid/synthetic"], "Keep", [name]);
	return { result, writes };
}
it.each(["../image.png", "a/b.png", "a\\b.png"])("attachment flattens separator-bearing name %s", async name => {
	const { writes } = await attachment(name);
	expect(writes).toHaveLength(1);
	expect(writes[0].split("/")).toHaveLength(3);
	expect(isSafeVaultPath(writes[0])).toBe(true);
});
it.each([".", ".."])("attachment should reject dot-segment name %s", async name => {
	const { writes } = await attachment(name);
	expect(writes).toHaveLength(1);
	expect(isSafeVaultPath(writes[0])).toBe(true);
});
it.each(['a:b.png', 'a?.png', 'a*.png', 'a"b.png', 'a<b>.png', "CON.png", "a\0b.png", "a\u0001b.png", "image.", "a".repeat(256)])("attachment should have portable component %j", async name => {
	const { writes } = await attachment(name);
	expect(writes).toHaveLength(1);
	expect(windowsProblems(leaf(writes[0]))).toEqual([]);
});
it("distinct media names collapsing to one name should preserve both byte streams", async () => {
	const files = new Map<string, ArrayBuffer>();
	const adapter = { exists: async (name: string) => files.has(name), readBinary: async (name: string) => files.get(name)!, writeBinary: async (name: string, bytes: ArrayBuffer) => { files.set(name, bytes); } };
	jest.mocked(httpGetArrayBuffer).mockResolvedValueOnce(new Uint8Array([1]).buffer).mockResolvedValueOnce(new Uint8Array([2]).buffer);
	await attachment("a#b.png", adapter); await attachment("a[b.png", adapter);
	expect([...files.values()].map(bytes => new Uint8Array(bytes)[0]).sort()).toEqual([1, 2]);
});
it("upload conflict copy should budget its final filename", async () => {
	const writes: string[] = [];
	const original = "shared\nlocal edit";
	const plugin = { app: { vault: { adapter: { exists: async () => false, read: async () => original, write: async (name: string) => { writes.push(name); } }, createFolder: async () => {} } }, throwIfSyncCancelled: () => {} } as unknown as KeepSidianPlugin;
	const note = { fullPath: `Keep/${"a".repeat(240)}.md`, body: original, frontmatter: "", mergeReview: { sourceContent: original, needsMerge: true, remote: { title: "synthetic", text: "shared\nremote edit" } } } as ReviewedPushNote;
	await prepareReviewedUploads(plugin, [note], "merge-save-conflicts");
	expect(writes).toHaveLength(1);
	expect(Buffer.byteLength(leaf(writes[0]), "utf8")).toBeLessThanOrEqual(255);
});
it("generated names remove Obsidian link syntax", async () => {
	expect(await conflict("section#heading[[alias]]^block%%")).not.toMatch(/#|\[\[|\]\]|\^|%%/);
});
