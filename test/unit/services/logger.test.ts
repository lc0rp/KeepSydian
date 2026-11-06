import { appendLog } from "../../../src/services/logger";
import type { AppLike, VaultAdapterLike } from "../../../src/services/paths";

interface MockedVaultAdapter extends VaultAdapterLike {
	exists: jest.Mock<Promise<boolean>, [string]>;
	read: jest.Mock<Promise<string>, [string]>;
	write: jest.Mock<Promise<void>, [string, string]>;
	append?: jest.Mock<Promise<void>, [string, string]>;
}

function createMockApp(
	overrides: Partial<MockedVaultAdapter> = {}
): { app: AppLike; adapter: MockedVaultAdapter } {
	const adapter: MockedVaultAdapter = {
		exists: jest.fn(async (_path: string) => true),
		read: jest.fn(async (_path: string) => ""),
		write: jest.fn(async (_path: string, _data: string) => undefined),
		append: jest.fn(async (_path: string, _data: string) => undefined),
		...overrides,
	};

	const app: AppLike = {
		vault: {
			adapter,
			createFolder: jest.fn(async (_path: string) => undefined),
		},
	};

	return { app, adapter };
}

describe("appendLog", () => {
	it("uses adapter append semantics when available", async () => {
		const { app, adapter } = createMockApp();
		const logPath = "Keep/_KeepSidianLogs/2026-03-05.md";
		const line = "- 00:00 sync started\n";

		await appendLog(app, logPath, line);

		expect(adapter.append).toHaveBeenCalledWith(logPath, line);
		expect(adapter.read).not.toHaveBeenCalled();
		expect(adapter.write).not.toHaveBeenCalled();
	});

	it("falls back to read and write when append is unavailable", async () => {
		const { app, adapter } = createMockApp({
			append: undefined,
			read: jest.fn(async (_path: string) => "existing\n"),
		});
		const logPath = "Keep/_KeepSidianLogs/2026-03-05.md";
		const line = "- 00:01 sync finished\n";

		await appendLog(app, logPath, line);

		expect(adapter.read).toHaveBeenCalledWith(logPath);
		expect(adapter.write).toHaveBeenCalledWith(logPath, "existing\n- 00:01 sync finished\n");
	});

	it("writes only incoming line when log file does not exist", async () => {
		const { app, adapter } = createMockApp({
			append: undefined,
			exists: jest.fn(async (path: string) => !path.endsWith(".md")),
		});
		const logPath = "Keep/_KeepSidianLogs/2026-03-05.md";
		const line = "- 00:02 sync queued\n";

		await appendLog(app, logPath, line);

		expect(adapter.read).not.toHaveBeenCalled();
		expect(adapter.write).toHaveBeenCalledWith(logPath, line);
	});
});
