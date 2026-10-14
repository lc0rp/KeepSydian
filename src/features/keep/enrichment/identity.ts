/** Release tags are routes within this one trusted service, not new accounts. */
export function enrichmentBackendIdentity(endpoint: string): { service: string } | { endpoint: string } {
	try {
		const url = new URL(endpoint);
		if (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.port &&
			url.pathname === "/" &&
			!url.search &&
			!url.hash &&
			/^(?:s?v\d+-\d+-\d+(?:-(?:alpha|beta)-[0-9a-z-]+)?---)?keepsidianserver-i55qr5tvea-uc\.a\.run\.app$/.test(
				url.hostname
			)
		)
			return { service: "keepsidianserver-i55qr5tvea-uc" };
	} catch {
		// Unrecognized/custom environments retain their exact endpoint boundary.
	}
	return { endpoint };
}
