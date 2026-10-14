import { reserveSibling, type PathAdapter } from "@services/portable-path";
import { CONFLICT_FILE_SUFFIX } from "../constants";

export function reserveConflictPath(adapter: PathAdapter, original: string, timestamp: string): Promise<{ path: string; release(): void }> {
	return reserveSibling(adapter, original, `${CONFLICT_FILE_SUFFIX}${timestamp.replace(/:/g, "-")}`);
}
