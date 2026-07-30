import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	planCompleteIntegration,
	publishIntegrationCas,
} from "../scripts/git-reconcile.mjs";

const roots = [];
const git = (repo, ...args) =>
	execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "conductor-stage2-reconcile-"));
	roots.push(repo);
	spawnSync("git", ["init", "-q", "-b", "main", repo]);
	git(repo, "config", "user.name", "Ambient");
	git(repo, "config", "user.email", "ambient@example.invalid");
	writeFileSync(join(repo, "base"), "base\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	const base = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-qb", "producer");
	writeFileSync(join(repo, "source"), "source\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "source");
	const source = git(repo, "rev-parse", "HEAD");
	const tree = git(repo, "rev-parse", "HEAD^{tree}");
	git(repo, "checkout", "-q", "main");
	return { repo, base, source, tree };
}
process.on("exit", () =>
	roots.forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const d = (c) => c.repeat(64);
const g = (c) => c.repeat(32);

test("synthetic integration commits ignore ambient identity, clock, and timezone", () => {
	const { repo, base, source, tree } = fixture();
	const producers = [
		{
			role_name: "builder",
			task_digest: d("a"),
			report_digest: d("b"),
			source_sha: source,
			tree_sha: tree,
			source_generation: g("c"),
		},
	];
	const first = planCompleteIntegration({
		repository: repo,
		targetSha: base,
		producers,
	});
	git(repo, "config", "user.name", "Different");
	git(repo, "config", "user.email", "different@example.invalid");
	git(repo, "config", "commit.gpgsign", "true");
	const second = planCompleteIntegration({
		repository: repo,
		targetSha: base,
		producers,
	});
	assert.equal(first.finalSha, second.finalSha);
	assert.equal(
		git(
			repo,
			"show",
			"-s",
			"--format=%an <%ae>|%aI|%cn <%ce>|%cI|%B",
			first.finalSha,
		),
		`Herdr Conductor <conductor@local.invalid>|2000-01-01T00:00:00Z|Herdr Conductor <conductor@local.invalid>|2000-01-01T00:00:00Z|Conductor Stage 2 integrate builder ${source}`,
	);
	let preflights = 0;
	const published = publishIntegrationCas({
		repository: repo,
		targetRef: "refs/heads/main",
		expectedTargetSha: base,
		plan: first,
		preflight: () => ({ stable: ++preflights > 0 ? true : true }),
	});
	assert.equal(published.casCount, 1);
	assert.equal(git(repo, "rev-parse", "main"), first.finalSha);
});

test("empty producer selection performs zero CAS", () => {
	const { repo, base } = fixture();
	const plan = planCompleteIntegration({
		repository: repo,
		targetSha: base,
		producers: [],
	});
	assert.deepEqual(
		publishIntegrationCas({
			repository: repo,
			targetRef: "refs/heads/main",
			expectedTargetSha: base,
			plan,
			preflight: () => ({ stable: true }),
		}),
		{ casCount: 0, finalSha: base },
	);
});
