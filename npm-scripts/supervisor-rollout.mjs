import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const supervisorRolloutAllowed = (base, proposed, labels) =>
  base.supervisor === proposed.supervisor || labels.some(({ name }) => name === "supervisor-rollout-approved");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = JSON.parse(execFileSync("git", ["show", "HEAD^1:release-pins.json"], { encoding: "utf8" }));
  const proposed = JSON.parse(readFileSync("release-pins.json", "utf8"));
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!supervisorRolloutAllowed(base, proposed, event.pull_request?.labels ?? [])) {
    console.error(
      "supervisor rollouts are on hold until the bootstrap release; add the label supervisor-rollout-approved after the owner approves",
    );
    process.exitCode = 1;
  }
}
