export type DownloadScopeKind = "last-sync" | "all" | "custom-since";

export interface DownloadScope {
	kind: DownloadScopeKind;
	since?: string;
	/** Exclusive upper bound. Omit to use the time the sync attempt starts. */
	until?: string;
}
