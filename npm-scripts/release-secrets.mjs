#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INFRA = join(ROOT, "packages", "control-plane", "infra");
const WORK = join(ROOT, ".tmp", "deploy");
const ENV_FILE = process.env.TUMPEL_CF_ENV ?? join(homedir(), ".config", "tumpel", "cf-env");
const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const REPOSITORY = process.env.TUMPEL_REPOSITORY ?? "mvhenten/tumpel";
const TOFU = join(WORK, "tofu-1.13.2", "tofu");
const SECRETS = {
  CLOUDFLARE_ACCOUNT_ID: "cloudflare_account_id",
  R2_RELEASES_ACCESS_KEY_ID: "r2_releases_access_key_id",
  R2_RELEASES_SECRET_ACCESS_KEY: "r2_releases_secret_access_key",
};

const die = (message) => {
  console.error(`release-secrets: ${message}`);
  process.exit(1);
};

if (!/^[a-z][a-z0-9]{1,15}$/.test(STAGE)) die(`TUMPEL_STAGE ${STAGE} must be 2 to 16 lower-case letters and digits`);
if (!existsSync(ENV_FILE)) die(`${ENV_FILE} is missing; write it as doc/deploy.md describes`);
if (!existsSync(TOFU)) die(`${TOFU} is missing; run npm run deploy:infra once to install OpenTofu`);

const settings = Object.fromEntries(
  readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);
const missing = ["CLOUDFLARE_ACCOUNT_ID", "TFSTATE_ACCESS_KEY_ID", "TFSTATE_SECRET_ACCESS_KEY"].filter(
  (name) => !settings[name],
);
if (missing.length > 0) die(`${ENV_FILE} does not set ${missing.join(", ")}`);

const run = (command, args, { env = process.env, input, capture = false } = {}) => {
  const result = spawnSync(command, args, {
    cwd: INFRA,
    env,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "ignore", "inherit"],
    timeout: 300_000,
  });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.slice(0, 2).join(" ")} exited with ${result.status}`);
  return result.stdout;
};

const tofuEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: settings.TFSTATE_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: settings.TFSTATE_SECRET_ACCESS_KEY,
  TF_DATA_DIR: join(WORK, `tofu-data-${STAGE}`),
  TF_IN_AUTOMATION: "1",
};

run(
  TOFU,
  [
    "init",
    "-input=false",
    `-backend-config=key=tumpel-${STAGE}.tfstate`,
    `-backend-config=endpoints={s3="https://${settings.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"}`,
  ],
  { env: tofuEnv },
);

for (const [secret, output] of Object.entries(SECRETS)) {
  const value = run(TOFU, ["output", "-raw", output], { env: tofuEnv, capture: true });
  if (!value) die(`tofu output ${output} is empty; run npm run deploy:infra for ${STAGE}`);
  run("gh", ["secret", "set", secret, "--repo", REPOSITORY], { input: value });
  console.log(`release-secrets: set ${secret} on ${REPOSITORY} from tofu output ${output}`);
}
