#!/usr/bin/env node
/* eslint-env node */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import readline from "readline";
import { incrementPrerelease, parseVersion } from "./release-version.mjs";

const ENV_FILE_PATH = ".env.production";
const DEFAULT_SERVER_SERVICE = "keepsidianserver";
const DEFAULT_SERVER_REGION = "us-central1";
const DEFAULT_SERVER_REPO = resolve(globalThis.process.cwd(), "../KeepSidianServer");

const process = globalThis.process;
const console = globalThis.console;

const run = (file, args = [], options = {}) => {
	return execFileSync(file, args, { stdio: "inherit", ...options });
};

const runCapture = (file, args = [], options = {}) => {
	return execFileSync(file, args, { encoding: "utf8", ...options });
};

const resolvePythonCommand = () => {
	for (const candidate of ["python", "python3"]) {
		try {
			runCapture(candidate, ["--version"], { stdio: "ignore" });
			return candidate;
		} catch {
			// try next
		}
	}

	throw new Error(
		"Python is required for coordinated server release checks, but neither `python` nor `python3` was found."
	);
};

const parseCliArgs = (argv) => {
	const options = {
		dryRun: false,
		releaseType: null,
		channel: null,
		explicitVersion: null,
		serverService: DEFAULT_SERVER_SERVICE,
		serverRegion: DEFAULT_SERVER_REGION,
		serverProject: null,
		serverRepo: DEFAULT_SERVER_REPO,
		skipGithubMonitor: false,
		skipGithubPublish: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const nextValue = () => {
			const value = argv[index + 1];
			if (!value) {
				throw new Error(`Missing value for ${arg}`);
			}
			index += 1;
			return value;
		};

		switch (arg) {
			case "--dry-run":
			case "-n":
				options.dryRun = true;
				break;
			case "--release-type":
			case "--level":
				options.releaseType = nextValue().toLowerCase();
				break;
			case "--channel":
				options.channel = nextValue().toLowerCase();
				break;
			case "--version":
				options.explicitVersion = nextValue();
				break;
			case "--server-service":
				options.serverService = nextValue();
				break;
			case "--server-region":
				options.serverRegion = nextValue();
				break;
			case "--server-project":
				options.serverProject = nextValue();
				break;
			case "--server-repo":
				options.serverRepo = resolve(nextValue());
				break;
			case "--skip-github-monitor":
				options.skipGithubMonitor = true;
				break;
			case "--skip-github-publish":
				options.skipGithubPublish = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (options.releaseType && !["patch", "minor", "major"].includes(options.releaseType)) {
		throw new Error(`Unsupported release type: ${options.releaseType}`);
	}

	if (options.channel && !["alpha", "beta", "none", "stable"].includes(options.channel)) {
		throw new Error(`Unsupported release channel: ${options.channel}`);
	}

	return options;
};

const cliOptions = parseCliArgs(process.argv.slice(2));
const isDryRun = cliOptions.dryRun;
const pythonCommand = resolvePythonCommand();

const ensureGitRepoExists = (cwd, label) => {
	if (!existsSync(cwd)) {
		throw new Error(`${label} path does not exist: ${cwd}`);
	}
};

const ensureCleanGitState = () => {
	const status = runCapture("git", ["status", "--porcelain"]).trim();
	if (status.length > 0) {
		const message = "Git working tree is not clean. Commit, stash, or discard changes before releasing.";
		if (isDryRun) {
			console.warn(`[dry-run] ${message}`);
			return;
		}
		console.error(message);
		process.exit(1);
	}
};

const isPathGitIgnored = (path) => {
	try {
		run("git", ["check-ignore", "-q", "--", path], { stdio: "ignore" });
		return true;
	} catch (error) {
		if (error && error.status === 1) {
			return false;
		}
		throw error;
	}
};

const promptForChoice = async ({ currentVersion, label, choices, question }) => {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	console.log(`Current version: ${currentVersion}`);
	console.log(label);
	choices.forEach((choice, index) => {
		console.log(`  ${index + 1}) ${choice}`);
	});

	const answer = await new Promise((resolveAnswer) => {
		rl.question(question, resolveAnswer);
	});

	rl.close();

	const normalized = String(answer).trim().toLowerCase();
	const selectedIndex = Number.parseInt(normalized, 10);
	if (choices[selectedIndex - 1]) {
		return choices[selectedIndex - 1];
	}
	if (choices.includes(normalized)) {
		return normalized;
	}
	throw new Error(`Invalid selection: ${normalized || "<empty>"}`);
};

const promptReleaseType = async (currentVersion) =>
	await promptForChoice({
		currentVersion,
		label: "Select the type of release:",
		choices: ["patch", "minor", "major"],
		question: "Enter 1, 2, or 3 (or type the release type) > ",
	});

const promptAlphaBetaChoice = async (currentVersion) =>
	await promptForChoice({
		currentVersion,
		label: "Is this an alpha or beta release?",
		choices: ["alpha", "beta", "none"],
		question: "Enter 1, 2, or 3 (or type alpha/beta/none) > ",
	});

const promptServerReleaseDecision = async ({ latestServerTag, reasons }) => {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	console.log(latestServerTag ? `Latest server release: ${latestServerTag}` : "Latest server release: none found");
	console.log("Server inspection indicates a new server release is needed before this plugin release.");
	for (const reason of reasons) {
		console.log(`- ${reason}`);
	}
	console.log("Release server first?");
	console.log("  1) yes");
	console.log("  2) no");

	const answer = await new Promise((resolveAnswer) => {
		rl.question("Enter 1 or 2 (or type yes/no) > ", resolveAnswer);
	});

	rl.close();

	const normalized = String(answer).trim().toLowerCase();
	if (normalized === "1" || normalized === "yes" || normalized === "y") {
		return true;
	}
	if (normalized === "2" || normalized === "no" || normalized === "n") {
		return false;
	}
	throw new Error(`Invalid selection: ${normalized || "<empty>"}`);
};

const bumpBaseVersion = (parsedVersion, releaseType) => {
	switch (releaseType) {
		case "major":
			return `${parsedVersion.major + 1}.0.0`;
		case "minor":
			return `${parsedVersion.major}.${parsedVersion.minor + 1}.0`;
		case "patch":
			return `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch + 1}`;
		default:
			throw new Error(`Unsupported release type: ${releaseType}`);
	}
};

const toVersionTag = (version) => `v${version.split(".").join("-")}`;
const toClientReleaseTag = (version) => `v${version}`;

const getProductionUrlForVersion = (version) =>
	`https://${toVersionTag(version)}---keepsidianserver-i55qr5tvea-uc.a.run.app/`;

const BACKEND_CHECK_PATH = "/subscribe";
const BACKEND_CHECK_TIMEOUT_MS = 10_000;

const resolveReleaseType = async (currentVersion) => {
	if (cliOptions.releaseType) {
		return cliOptions.releaseType;
	}
	return await promptReleaseType(currentVersion);
};

const resolveChannel = async (currentVersion) => {
	if (!cliOptions.channel) {
		return await promptAlphaBetaChoice(currentVersion);
	}
	if (cliOptions.channel === "stable") {
		return "none";
	}
	return cliOptions.channel;
};

const determineNextVersion = async (currentVersion) => {
	if (cliOptions.explicitVersion) {
		parseVersion(cliOptions.explicitVersion);
		return {
			nextVersion: cliOptions.explicitVersion,
			releaseTypeLabel: "explicit version override",
		};
	}

	const parsed = parseVersion(currentVersion);
	const alphaBetaChoice = await resolveChannel(currentVersion);

	if (alphaBetaChoice === "alpha" || alphaBetaChoice === "beta") {
		const sameChannel = parsed.prerelease && parsed.prerelease.channel === alphaBetaChoice;
		if (sameChannel) {
			return {
				nextVersion: incrementPrerelease(parsed),
				releaseTypeLabel: `${alphaBetaChoice} increment`,
			};
		}

		const baseReleaseType = await resolveReleaseType(currentVersion);
		const baseVersion = bumpBaseVersion(parsed, baseReleaseType);
		return {
			nextVersion: `${baseVersion}-${alphaBetaChoice}.1`,
			releaseTypeLabel: `${baseReleaseType} ${alphaBetaChoice}`,
		};
	}

	if (parsed.prerelease) {
		return {
			nextVersion: parsed.baseVersion,
			releaseTypeLabel: "finalize prerelease",
		};
	}

	const baseReleaseType = await resolveReleaseType(currentVersion);
	return {
		nextVersion: bumpBaseVersion(parsed, baseReleaseType),
		releaseTypeLabel: baseReleaseType,
	};
};

const resolveLatestServerTag = (serverRepo) => {
	const code = [
		"import subprocess",
		"from keep.release.cli_tags import select_latest_server_tag",
		"tags = [line.strip() for line in subprocess.run(['git', 'tag', '--list', 'sv*'], capture_output=True, text=True, check=True).stdout.splitlines() if line.strip()]",
		"latest = select_latest_server_tag(tags)",
		"print(latest.original if latest else '')",
	].join("; ");

	const latest = runCapture(pythonCommand, ["-c", code], { cwd: serverRepo }).trim();
	return latest.length > 0 ? latest : null;
};

const inspectServerRepo = (serverRepo) => {
	const latestServerTag = resolveLatestServerTag(serverRepo);
	const reasons = [];

	const dirtyStatus = runCapture("git", ["status", "--porcelain"], { cwd: serverRepo }).trim();
	if (dirtyStatus.length > 0) {
		reasons.push("Server repo has uncommitted changes.");
	}

	if (!latestServerTag) {
		reasons.push("No existing server release tag (`sv...`) was found.");
		return {
			latestServerTag: null,
			releaseNeeded: true,
			reasons,
		};
	}

	const commitsSinceLatest = Number.parseInt(
		runCapture("git", ["rev-list", "--count", `${latestServerTag}..HEAD`], {
			cwd: serverRepo,
		}).trim(),
		10
	);

	if (Number.isFinite(commitsSinceLatest) && commitsSinceLatest > 0) {
		reasons.push(
			`${commitsSinceLatest} committed change${commitsSinceLatest === 1 ? "" : "s"} exist after ${latestServerTag}.`
		);
	}

	return {
		latestServerTag,
		releaseNeeded: reasons.length > 0,
		reasons,
	};
};

const runServerReleaseCommand = (args) => {
	const serverRepo = cliOptions.serverRepo;
	if (!existsSync(serverRepo)) {
		throw new Error(`Server repo not found at ${serverRepo}`);
	}

	if (isDryRun) {
		console.log(`[dry-run] Would run in ${serverRepo}: ${pythonCommand} ${args.join(" ")}`);
		return;
	}

	run(pythonCommand, args, { cwd: serverRepo });
};

const coordinateServerRelease = async () => {
	const inspection = inspectServerRepo(cliOptions.serverRepo);

	if (!inspection.releaseNeeded) {
		console.log(`Using latest server release ${inspection.latestServerTag}.`);
		return inspection.latestServerTag;
	}

	const shouldReleaseServer = await promptServerReleaseDecision({
		latestServerTag: inspection.latestServerTag,
		reasons: inspection.reasons,
	});

	if (!shouldReleaseServer) {
		throw new Error("Aborted because the server repo needs a release before this plugin release can be pinned.");
	}

	const args = [
		"-m",
		"keep.release.cli",
		"--service",
		cliOptions.serverService,
		"--region",
		cliOptions.serverRegion,
		"--source",
		".",
	];

	if (cliOptions.serverProject) {
		args.push("--project", cliOptions.serverProject);
	}
	if (isDryRun) {
		args.push("--dry-run");
	}

	console.log("Running server release flow before plugin tagging...");
	runServerReleaseCommand(args);

	if (isDryRun) {
		return null;
	}

	const latestServerTag = resolveLatestServerTag(cliOptions.serverRepo);
	if (!latestServerTag) {
		throw new Error("Server release completed but no server release tag (`sv...`) could be resolved.");
	}

	console.log(`Server release completed. Latest server release is now ${latestServerTag}.`);
	return latestServerTag;
};

const pinPluginVersionToServerRelease = async (pluginVersion, serverTag) => {
	if (isDryRun && !serverTag) {
		console.log(
			`[dry-run] Would add client tag ${toClientReleaseTag(pluginVersion)} to the latest server release after the server release completes.`
		);
		return;
	}

	const args = [
		"-m",
		"keep.release.cli",
		"clients",
		"--service",
		cliOptions.serverService,
		"--region",
		cliOptions.serverRegion,
		"--server-tag",
		serverTag,
		"--no-prompt",
		"--add",
		toClientReleaseTag(pluginVersion),
	];

	if (cliOptions.serverProject) {
		args.push("--project", cliOptions.serverProject);
	}
	if (isDryRun) {
		args.push("--dry-run");
	}

	console.log(`Pinning plugin tag ${toClientReleaseTag(pluginVersion)} to server release ${serverTag}...`);
	runServerReleaseCommand(args);
};

const checkBackendUrl = async (version, { dryRun = false } = {}) => {
	const baseUrl = getProductionUrlForVersion(version).replace(/\/$/, "");
	const checkUrl = `${baseUrl}${BACKEND_CHECK_PATH}`;

	if (dryRun) {
		console.log(`[dry-run] Would verify backend URL is live: ${checkUrl}`);
		return;
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), BACKEND_CHECK_TIMEOUT_MS);

	try {
		const response = await fetch(checkUrl, {
			method: "GET",
			redirect: "follow",
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`Backend URL check failed: ${checkUrl} returned ${response.status}.`);
		}

		console.log(`Backend URL check passed: ${checkUrl} → ${response.status}`);
	} catch (error) {
		if (error?.name === "AbortError") {
			throw new Error(`Backend URL check timed out after ${BACKEND_CHECK_TIMEOUT_MS}ms: ${checkUrl}`);
		}
		throw new Error(`Backend URL check failed for ${checkUrl}: ${error}`);
	} finally {
		clearTimeout(timeoutId);
	}
};

const updateEnvProduction = (version, { dryRun = false } = {}) => {
	const envContent = readFileSync(ENV_FILE_PATH, "utf8");
	const lineEnding = envContent.includes("\r\n") ? "\r\n" : "\n";
	const url = getProductionUrlForVersion(version);
	const targetLine = `KEEPSIDIAN_SERVER_URL=${url}`;

	if (dryRun) {
		const beforeDisplay =
			envContent.endsWith("\n") || envContent.endsWith("\r\n") ? envContent : `${envContent}${lineEnding}`;
		console.log(`[dry-run] ${ENV_FILE_PATH} before update:\n---\n${beforeDisplay}---`);
	}

	const lines = envContent.split(/\r?\n/);
	const updatedLines = [];
	let activeLineHandled = false;
	let changed = false;

	for (const line of lines) {
		if (!line.trim().startsWith("#") && line.startsWith("KEEPSIDIAN_SERVER_URL=")) {
			if (!activeLineHandled) {
				activeLineHandled = true;
				if (line !== targetLine) {
					changed = true;
				}
				updatedLines.push(targetLine);
			} else {
				changed = true;
			}
			continue;
		}

		updatedLines.push(line);
	}

	if (!activeLineHandled) {
		if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== "") {
			updatedLines.push("");
		}
		updatedLines.push(targetLine);
		changed = true;
	}

	let updatedContent = updatedLines.join(lineEnding);
	if (!updatedContent.endsWith(lineEnding)) {
		updatedContent += lineEnding;
	}

	if (dryRun) {
		console.log(`[dry-run] ${ENV_FILE_PATH} after simulated update:\n---\n${updatedContent}---`);
	}

	if (!changed) {
		const message = `No update needed for ${ENV_FILE_PATH}; already set to ${url}`;
		if (dryRun) {
			console.log(`[dry-run] ${message}`);
		} else {
			console.log(message);
		}
		return { changed: false, url };
	}

	if (dryRun) {
		console.log(`[dry-run] Would update ${ENV_FILE_PATH} with ${targetLine}`);
		return { changed: true, url };
	}

	writeFileSync(ENV_FILE_PATH, updatedContent, "utf8");
	console.log(`Updated KEEPSIDIAN_SERVER_URL to ${url}`);
	return { changed: true, url };
};

const monitorReleaseRun = async (version, { dryRun = false } = {}) => {
	const workflowName = "Release Keepsidian plugin";
	const tag = version;

	if (dryRun) {
		console.log(`[dry-run] Would monitor GitHub Actions workflow "${workflowName}" for ${tag}`);
		return;
	}

	try {
		runCapture("gh", ["--version"]);
	} catch {
		console.warn("GitHub CLI (gh) not available; skipping workflow monitoring.");
		return;
	}

	try {
		const payload = runCapture("gh", [
			"run",
			"list",
			"--workflow",
			workflowName,
			"--branch",
			tag,
			"--limit",
			"1",
			"--json",
			"databaseId,status,conclusion",
		]);
		const runs = JSON.parse(payload);
		const latest = runs[0];

		if (!latest) {
			console.warn(`No GitHub Actions run found for ${tag}.`);
			return;
		}

		if (latest.status === "completed") {
			const conclusion = latest.conclusion || "unknown";
			if (conclusion !== "success") {
				console.error(`Release workflow completed with conclusion: ${conclusion}`);
				process.exit(1);
			}
			console.log(`Release workflow completed: ${conclusion}.`);
			return;
		}

		console.log(`Monitoring GitHub Actions run ${latest.databaseId} for ${tag}...`);
		run("gh", ["run", "watch", String(latest.databaseId), "--exit-status"]);
	} catch {
		console.warn("Unable to monitor GitHub Actions release run; check it manually.");
	}
};

const getRepoSlug = () => {
	try {
		const origin = runCapture("git", ["config", "--get", "remote.origin.url"]).trim();
		if (!origin) {
			return null;
		}

		const sshMatch = origin.match(/:(.+?)(?:\.git)?$/);
		if (sshMatch && sshMatch[1]) {
			return sshMatch[1];
		}

		const httpsMatch = origin.match(/github\.com\/(.+?)(?:\.git)?$/);
		if (httpsMatch && httpsMatch[1]) {
			return httpsMatch[1];
		}
	} catch {
		// ignore
	}

	return null;
};

const publishDraftRelease = async (version, { dryRun = false } = {}) => {
	const repo = getRepoSlug() ?? "lc0rp/KeepSidian";
	const isPrerelease = parseVersion(version).prerelease !== null;

	if (dryRun) {
		console.log(`[dry-run] Would publish GitHub release for ${version}`);
		return;
	}

	try {
		runCapture("gh", ["--version"]);
	} catch {
		console.warn("GitHub CLI (gh) not available; skipping release publish.");
		return;
	}

	try {
		const payload = runCapture("gh", ["api", `repos/${repo}/releases?per_page=100`]);
		const releases = JSON.parse(payload);
		const matching = releases.filter((release) => release.tag_name === version);
		const published = matching.find((release) => release.draft === false);
		const draft = matching.find((release) => release.draft === true);

		if (published) {
			console.log(`Release ${version} already published.`);
			return;
		}

		if (!draft) {
			console.warn(`No draft release found for ${version}.`);
			return;
		}

		if (!draft.assets || draft.assets.length === 0) {
			console.error(`Draft release ${version} has no assets; not publishing.`);
			process.exit(1);
		}

		run("gh", [
			"api",
			"-X",
			"PATCH",
			`repos/${repo}/releases/${draft.id}`,
			"-f",
			"draft=false",
			"-f",
			`prerelease=${isPrerelease ? "true" : "false"}`,
			"-f",
			`name=${version}`,
		]);
		console.log(`Published release ${version}.`);
	} catch {
		console.warn("Unable to publish draft release; check it manually.");
	}
};

const getReleaseCommitMessage = (version) => `chore(release): ${version}`;

const stageTrackedReleaseChanges = ({ dryRun = false } = {}) => {
	if (dryRun) {
		console.log("[dry-run] Would stage tracked release changes (git add -u)");
		return;
	}

	run("git", ["add", "-u"]);
};

const createReleaseCommit = (version, { dryRun = false } = {}) => {
	const message = getReleaseCommitMessage(version);

	if (dryRun) {
		console.log(`[dry-run] Would create release commit: ${message}`);
		return;
	}

	stageTrackedReleaseChanges();

	try {
		run("git", ["diff", "--cached", "--quiet"], { stdio: "ignore" });
		throw new Error("No tracked release changes were staged for commit.");
	} catch (error) {
		if (error?.status !== 1) {
			throw error;
		}
	}

	run("git", ["commit", "-m", message]);
};

const main = async () => {
	if (isDryRun) {
		console.log("Running release script in dry-run mode. No commands will be executed.");
	}

	ensureCleanGitState();
	ensureGitRepoExists(cliOptions.serverRepo, "Server repo");

	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const currentVersion = pkg.version;
	const { nextVersion, releaseTypeLabel } = await determineNextVersion(currentVersion);

	console.log(`Preparing release for version ${nextVersion} (${releaseTypeLabel}).`);

	const targetServerTag = await coordinateServerRelease();
	await pinPluginVersionToServerRelease(nextVersion, targetServerTag);

	const { changed: envChanged } = updateEnvProduction(nextVersion, { dryRun: isDryRun });
	await checkBackendUrl(nextVersion, { dryRun: isDryRun });

	if (isDryRun) {
		console.log("[dry-run] Would run: npm run build");
	} else {
		console.log("Running production build...");
		run("npm", ["run", "build"]);
	}

	if (envChanged) {
		if (isDryRun) {
			console.log(`[dry-run] Skipping staging ${ENV_FILE_PATH} (file is ignored; no git changes made)`);
		} else {
			if (isPathGitIgnored(ENV_FILE_PATH)) {
				console.log(`${ENV_FILE_PATH} is gitignored; skipping staging.`);
			} else {
				console.log(`Staging ${ENV_FILE_PATH}...`);
				run("git", ["add", ENV_FILE_PATH]);
			}
		}
	} else if (!isDryRun) {
		console.log(`No changes detected in ${ENV_FILE_PATH}; skipping staging.`);
	}

	if (isDryRun) {
		console.log(`[dry-run] Would bump version via npm version ${nextVersion} --force --no-git-tag-version`);
	} else {
		console.log(`Bumping version to ${nextVersion}...`);
		run("npm", ["version", nextVersion, "--force", "--no-git-tag-version"]);
	}

	const updatedVersion = isDryRun ? nextVersion : JSON.parse(readFileSync("package.json", "utf8")).version;
	console.log(`Version updated: ${currentVersion} → ${updatedVersion}`);

	if (isDryRun) {
		createReleaseCommit(updatedVersion, { dryRun: true });
		console.log(`[dry-run] Would tag release ${updatedVersion} after creating the release commit`);
	} else {
		console.log(`Creating release commit for ${updatedVersion}...`);
		createReleaseCommit(updatedVersion);
		console.log(`Tagging release ${updatedVersion}...`);
		run("git", ["tag", "-a", updatedVersion, "-m", updatedVersion]);
	}

	if (isDryRun) {
		console.log("[dry-run] Would push the release commit and tag to remote (git push --follow-tags)");
	} else {
		console.log("Pushing release commit and tag to remote...");
		run("git", ["push", "--follow-tags"]);
	}

	if (!cliOptions.skipGithubMonitor) {
		await monitorReleaseRun(updatedVersion, { dryRun: isDryRun });
	}
	if (!cliOptions.skipGithubPublish) {
		await publishDraftRelease(updatedVersion, { dryRun: isDryRun });
	}

	console.log("Release process completed successfully.");
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
