import { resolveDownloadDateWindow } from "../download-date-window";
import type { DownloadScope } from "@types";

const end = "2026-06-01T12:00:00.000Z";
const startedAt = Date.parse(end);
const since = "2026-05-01T12:00:00.000Z";
const previous = "2026-04-01T12:00:00.000Z";

describe("download date windows", () => {
	it("defaults the end to the supplied attempt start and overlaps exclusive boundaries", () => {
		const result = resolveDownloadDateWindow(undefined, previous, startedAt);
		expect(result.filters).toEqual({ changed_gt: previous, created_lt: end, updated_lt: end });
		expect(result.checkpoint).toBe("2026-06-01T11:59:59.999Z");
		// A note exactly at the exclusive end must be eligible for the next window.
		const next = resolveDownloadDateWindow(undefined, result.checkpoint, startedAt + 60_000);
		expect(startedAt).toBeGreaterThan(Date.parse(next.filters.changed_gt!));
		expect(startedAt).toBeLessThan(Date.parse(next.filters.updated_lt!));
	});

	it.each([undefined, { kind: "last-sync" }, { kind: "all" }] as Array<DownloadScope | undefined>)(
		"applies an upper bound even with no saved lower bound: %p",
		(scope) => {
			expect(resolveDownloadDateWindow(scope, undefined, startedAt).filters).toEqual({
				created_lt: end,
				updated_lt: end,
			});
		}
	);

	it("all dates ignores an existing lower bound", () => {
		expect(resolveDownloadDateWindow({ kind: "all" }, previous, startedAt).filters.changed_gt).toBeUndefined();
	});

	it.each([undefined, "", "   "])("keeps an omitted custom end dynamic until sync starts (%p)", (until) => {
		const scope: DownloadScope = { kind: "custom-since", since, until };
		const result = resolveDownloadDateWindow(scope, previous, startedAt);
		expect(result.filters).toEqual({ changed_gt: since, created_lt: end, updated_lt: end });
		expect(result.checkpoint).toBeUndefined();
		expect(scope.until).toBe(until);
	});

	it("normalizes explicit timezones and leaves the automatic checkpoint untouched", () => {
		const result = resolveDownloadDateWindow(
			{ kind: "custom-since", since, until: "2026-05-15T08:00:00-04:00" },
			previous,
			startedAt
		);
		expect(result.filters).toEqual({
			changed_gt: since,
			created_lt: "2026-05-15T12:00:00.000Z",
			updated_lt: "2026-05-15T12:00:00.000Z",
		});
		expect(result.checkpoint).toBeUndefined();
	});

	it("does not regress a checkpoint when all dates ends before an existing checkpoint", () => {
		const result = resolveDownloadDateWindow({ kind: "all", until: previous }, since, startedAt);
		expect(result.checkpoint).toBeUndefined();
	});

	it.each([
		{ kind: "custom-since" },
		{ kind: "custom-since", since: "invalid" },
		{ kind: "custom-since", since: "2027-01-01T00:00:00.000Z" },
		{ kind: "custom-since", since, until: "invalid" },
		{ kind: "custom-since", since, until: "2027-01-01T00:00:00.000Z" },
		{ kind: "custom-since", since, until: since },
		{ kind: "custom-since", since, until: previous },
	] as DownloadScope[])("rejects invalid or unordered ranges before fetching: %p", (scope) => {
		expect(() => resolveDownloadDateWindow(scope, previous, startedAt)).toThrow();
	});

	it("rejects an invalid or future automatic lower bound", () => {
		for (const last of ["invalid", "2027-01-01T00:00:00.000Z"]) {
			expect(() => resolveDownloadDateWindow(undefined, last, startedAt)).toThrow("last sync date");
		}
	});
});
