import { createSupporterKeyIdentity, formatSupporterKeyInput, normalizeSupporterKey } from "../supporter-key";

describe("supporter key normalization", () => {
	it("accepts lowercase, spaces, and dashes and returns the canonical format", () => {
		expect(normalizeSupporterKey("abcd efgh-ijkl mn12")).toBe("ABCD-EFGH-IJKL-MN12");
		expect(formatSupporterKeyInput("abcd efgh-ijkl mn12")).toBe("ABCD-EFGH-IJKL-MN12");
	});

	it("does not truncate an oversized key into a valid credential", () => {
		const formatted = formatSupporterKeyInput("ABCD-EFGH-IJKL-MN12-EXTRA");

		expect(formatted).toBe("ABCD-EFGH-IJKL-MN12-EXTR-A");
		expect(normalizeSupporterKey(formatted)).toBeNull();
	});

	it("creates a stable non-raw cache identity that changes with the key", () => {
		const first = createSupporterKeyIdentity("ABCD-EFGH-IJKL-MN12");
		const second = createSupporterKeyIdentity("WXYZ-9876-QRST-5432");

		expect(first).toHaveLength(32);
		expect(first).toBe(createSupporterKeyIdentity("ABCD-EFGH-IJKL-MN12"));
		expect(first).not.toBe(second);
		expect(first).not.toContain("ABCD");
	});
});
