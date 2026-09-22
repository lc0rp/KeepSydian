import { parseCustomScopeRange } from "../sync-date-range";

const now = new Date(2026, 5, 1, 12, 0, 0, 0).getTime();
const start = "2024-02-28 09:30";

describe("custom sync date range inputs", () => {
	it("converts both local timestamps to ISO and accepts a leap day", () => {
		expect(parseCustomScopeRange(start, "2024-02-29 10:45", now)).toEqual({
			scope: {
				kind: "custom-since",
				since: new Date(2024, 1, 28, 9, 30, 0, 0).toISOString(),
				until: new Date(2024, 1, 29, 10, 45, 0, 0).toISOString(),
			},
			startError: undefined,
			endError: undefined,
		});
	});

	it.each(["", "   "])("leaves the default end unresolved when blank: %p", (end) => {
		const result = parseCustomScopeRange(start, end, now);
		expect(result.endError).toBeUndefined();
		expect(result.scope).not.toHaveProperty("until");
	});

	it.each(["2025-02-29 10:00", "2024-04-31 10:00", "2024-13-01 10:00", "2024-03-01 24:00", "invalid"])(
		"rejects invalid end dates without JS date rollover: %s",
		(end) => {
			expect(parseCustomScopeRange(start, end, now).endError).toBe("Choose a valid custom end date.");
		}
	);

	it.each([start, "2024-02-27 09:30"])("requires the end to follow the start: %s", (end) => {
		expect(parseCustomScopeRange(start, end, now).endError).toBe("End date must be after the start date.");
	});

	it("rejects future start and end values", () => {
		expect(parseCustomScopeRange("2027-01-01 09:30", "", now).startError).toBe("Custom date must be in the past.");
		expect(parseCustomScopeRange(start, "2027-01-01 09:30", now).endError).toBe("Custom end date must be in the past.");
	});

	it("still requires a start date", () => {
		expect(parseCustomScopeRange("", "2024-03-01 09:30", now).startError).toBe("Choose a custom date.");
	});
});
