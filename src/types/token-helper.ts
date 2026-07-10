export interface TokenHelperAssetManifest {
	platform: string;
	arch: string;
	url: string;
	sha256: string;
	size?: number;
	fileName?: string;
}

export interface TokenHelperManifest {
	version: string;
	protocolVersions: number[];
	pluginVersionRange: string;
	assets: TokenHelperAssetManifest[];
}
