const path = require("node:path");

module.exports = {
	rootDir: path.resolve(__dirname, "../.."),
	testEnvironment: "jsdom",
	testMatch: ["<rootDir>/test/unit/**/*.test.ts"],
	moduleNameMapper: {
		"^main$": "<rootDir>/src/main.ts",
		"^electron$": "<rootDir>/test/mocks/electron.ts",
		"^obsidian$": "<rootDir>/test/mocks/obsidian.ts",
		"^@app/(.*)$": "<rootDir>/src/app/$1",
		"^@ui/(.*)$": "<rootDir>/src/ui/$1",
		"^@features/(.*)$": "<rootDir>/src/features/$1",
		"^@integrations/(.*)$": "<rootDir>/src/integrations/$1",
		"^@services/(.*)$": "<rootDir>/src/services/$1",
		"^@types$": "<rootDir>/src/types/index.ts",
		"^@types/(.*)$": "<rootDir>/src/types/$1",
		"^@schemas/(.*)$": "<rootDir>/src/schemas/$1",
		"^@test-utils/(.*)$": "<rootDir>/test/utils/$1",
	},
	setupFiles: ["<rootDir>/test/setup-env.ts"],
	setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
	transform: {
		"^.+\\.tsx?$": ["ts-jest", { tsconfig: path.join(__dirname, "tsconfig.json") }],
	},
	moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
	cacheDirectory: "<rootDir>/.tmp/jest-cache",
	collectCoverageFrom: ["src/**/*.ts"],
	coverageDirectory: "<rootDir>/.tmp/coverage",
	coverageReporters: ["text", "lcov"],
	verbose: true,
};
