#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";

const REPOSITORY = "tumpel/workflows";
const MOVING_TAG = "v1";
const WORKFLOWS = [".github/workflows/prebuild.yml"];
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

const versionOf = (tag) => tag.slice(1).split(".").map(Number);
const compareTags = (left, right) => {
  const [a, b] = [versionOf(left), versionOf(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};

const die = (message) => {
  console.error(`workflows:publish: ${message}`);
  process.exit(1);
};

const token = process.env.WORKFLOWS_PUBLISH_TOKEN;
if (!token)
  die(
    `WORKFLOWS_PUBLISH_TOKEN is not set; create the repository secret of that name with a token that writes contents and workflows of ${REPOSITORY}`,
  );

const releaseTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (!releaseTag || !RELEASE_TAG.test(releaseTag))
  die(`publish only from a release tag vX.Y.Z; this run is on ${process.env.GITHUB_REF_NAME ?? "(no ref)"}`);

const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
};

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=tumpel release", "-c", "user.email=release@tumpel.dev", ...args], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  });
  if (result.status !== 0)
    die(`git ${args.join(" ")} failed: ${result.stderr.trim()}; check that the token can write ${REPOSITORY}`);
  return result.stdout.trim();
};

const root = process.cwd();
mkdirSync(join(root, ".tmp"), { recursive: true });
const checkout = mkdtempSync(join(root, ".tmp", "workflows-"));
git(root, "clone", "--quiet", `https://github.com/${REPOSITORY}.git`, checkout);

for (const path of WORKFLOWS) {
  mkdirSync(dirname(join(checkout, path)), { recursive: true });
  copyFileSync(join(root, path), join(checkout, path));
}
git(checkout, "add", ...WORKFLOWS);
if (git(checkout, "status", "--porcelain")) git(checkout, "commit", "--quiet", "-m", `release ${releaseTag}`);

const newest = git(checkout, "tag", "--list", "v*.*.*")
  .split("\n")
  .filter((tag) => RELEASE_TAG.test(tag))
  .sort(compareTags)
  .at(-1);
if (newest && compareTags(releaseTag, newest) < 0)
  die(
    `${REPOSITORY} already holds release ${newest}, newer than ${releaseTag}; moving ${MOVING_TAG} back would hand callers an older workflow, so publish from a tag newer than ${newest}`,
  );

const head = git(checkout, "rev-parse", "HEAD");
if (!git(checkout, "tag", "--list", releaseTag)) git(checkout, "tag", releaseTag);
else if (git(checkout, "rev-parse", `refs/tags/${releaseTag}^{commit}`) !== head)
  die(`${REPOSITORY} already tags ${releaseTag} on another commit; release tags are immutable, so tag a new release`);
git(checkout, "tag", "--force", MOVING_TAG);
git(checkout, "push", "--quiet", "origin", "HEAD:refs/heads/main", `refs/tags/${releaseTag}`);
git(checkout, "push", "--quiet", "--force", "origin", `refs/tags/${MOVING_TAG}`);
console.log(`published ${REPOSITORY} ${head} as ${releaseTag} and ${MOVING_TAG}`);
