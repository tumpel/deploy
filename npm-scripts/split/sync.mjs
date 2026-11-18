#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { histogram, inWorkingHours, loadLiterals, loadRules, scanRepo } from "./split.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GIT = "/usr/bin/git";
const TARGETS = { backend: "tumpel/control-plane", infra: "tumpel/infra" };
const IDENTITY = { name: "Matthijs van Henten", email: "440737+mvhenten@users.noreply.github.com" };

const git = (cwd, args, env = {}) =>
  execFileSync(GIT, args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, env: { ...process.env, ...env } }).trim();
const succeeds = (cwd, args) => {
  try {
    execFileSync(GIT, args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const refuse = (message) => {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
};

const parseArgs = (argv) => {
  const args = { output: join(homedir(), "development/.tmp/split-sync/run"), maxNew: 200, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--output") args.output = argv[++index];
    else if (flag === "--max-new") args.maxNew = Number(argv[++index]);
    else if (flag === "--dry-run") args.dryRun = true;
    else {
      console.error("usage: sync.mjs [--output dir] [--max-new count] [--dry-run]");
      process.exit(2);
    }
  }
  return args;
};

const nightStamp = (repo) => {
  const newest = Math.max(...git(repo, ["log", "-2", "--format=%ct", "main", "public/main"]).split("\n").map(Number));
  let stamp = Math.max(newest + 60, Math.floor(Date.now() / 1000));
  while (inWorkingHours(stamp, "+0000")) stamp += 600;
  return `${stamp} +0000`;
};

const prepare = async ({ name, slug, output, maxNew, rules, literals }) => {
  const repo = join(output, name);
  const url = `https://github.com/${slug}.git`;
  git(repo, ["remote", "add", "public", url]);
  git(repo, ["fetch", "-q", "public", "main"]);
  git(repo, ["update-ref", "refs/remotes/public/main", "FETCH_HEAD"]);
  const root = git(repo, ["rev-list", "--max-parents=0", "main"]);
  if (!succeeds(repo, ["merge-base", "--is-ancestor", root, "public/main"])) {
    refuse(`${slug}: the split no longer shares its first commit with the public history`);
  }
  const fresh = Number(git(repo, ["rev-list", "--count", "main", "^public/main"]));
  if (fresh > maxNew) {
    refuse(`${slug}: ${fresh} split commits are new, above --max-new ${maxNew}; the split is no longer deterministic`);
  }
  if (succeeds(repo, ["merge-base", "--is-ancestor", "main", "public/main"])) {
    console.log(`${slug}: up to date`);
    return { name, slug, repo, push: false };
  }
  git(repo, ["checkout", "-q", "-B", "sync", "public/main"]);
  const stamp = nightStamp(repo);
  const env = {
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_COMMITTER_DATE: stamp,
  };
  try {
    git(repo, ["merge", "-q", "--no-edit", "-m", "chore(sync): merge history from tumpel main", "main"], env);
  } catch (error) {
    refuse(
      `${slug}: merging the new split commits onto the public history conflicts\n${error.stderr ?? error.message}`,
    );
  }
  const scan = await scanRepo({ repo, rules, literals, isPublic: true });
  const hours = histogram(repo);
  const problems = [
    ...scan.findings.map((finding) => `${finding.scanner} ${finding.rule} in ${finding.path} at ${finding.commit}`),
    ...(scan.trailers ? [`${scan.trailers} Claude trailers`] : []),
    ...(hours.working ? [`${hours.working} commits in Mon-Fri 08:00-22:00`] : []),
  ];
  if (problems.length) refuse(`${slug}: the gate failed\n${problems.join("\n")}`);
  if (!succeeds(repo, ["merge-base", "--is-ancestor", "public/main", "sync"])) {
    refuse(`${slug}: the result is not a fast-forward of the public main`);
  }
  console.log(`${slug}: gate passed, ${fresh} new split commits`);
  return { name, slug, repo, push: true };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.output, { recursive: true });
  const rules = loadRules(join(HERE, "scrub-rules.json"));
  const config = JSON.parse(readFileSync(join(HERE, "split.config.json"), "utf8"));
  const literals = loadLiterals(config.literalsFile);
  const only = Object.keys(TARGETS).flatMap((name) => ["--only", name]);
  execFileSync(process.execPath, [join(HERE, "split.mjs"), "--output", args.output, ...only], { stdio: "inherit" });
  const prepared = [];
  for (const [name, slug] of Object.entries(TARGETS)) {
    prepared.push(await prepare({ name, slug, output: args.output, maxNew: args.maxNew, rules, literals }));
  }
  for (const { slug, repo, push } of prepared) {
    if (!push || args.dryRun) continue;
    git(repo, ["push", "public", "sync:main"]);
    console.log(`${slug}: pushed ${git(repo, ["rev-parse", "--short", "sync"])}`);
  }
};

await main();
