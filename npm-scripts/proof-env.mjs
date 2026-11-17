#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentRelease, downloadRelease } from "./release-download.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INFRA = join(ROOT, "packages", "control-plane", "infra");
const WORK = join(ROOT, ".tmp", "deploy");
const ENV_FILE = process.env.TUMPEL_CF_ENV ?? join(homedir(), ".config", "tumpel", "cf-env");
const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const TOFU = join(WORK, "tofu-1.13.2", "tofu");
const RELEASE_DIR = join(ROOT, ".tmp", "proof-release");
const HOST_ARCHITECTURE = "Amd64";
const LOCAL_ARCHITECTURES = { x64: "Amd64", arm64: "Arm64" };

const die = (message) => {
  console.error(`proof-env: ${message}`);
  process.exit(1);
};

const [command, ...args] = process.argv.slice(2);
if (!command) die("pass the command to run, e.g. npm run proof -- tumpel login --endpoint https://<stage host>");
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

const tofuEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: settings.TFSTATE_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: settings.TFSTATE_SECRET_ACCESS_KEY,
  TF_DATA_DIR: join(WORK, `tofu-data-${STAGE}`),
  TF_IN_AUTOMATION: "1",
};

const tofu = (tofuArgs, capture) => {
  const result = spawnSync(TOFU, tofuArgs, {
    cwd: INFRA,
    env: tofuEnv,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "ignore", "inherit"],
    timeout: 300_000,
  });
  if (result.error) die(`tofu ${tofuArgs[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`tofu ${tofuArgs[0]} exited with ${result.status}`);
  return result.stdout;
};

tofu(
  [
    "init",
    "-input=false",
    `-backend-config=key=tumpel-${STAGE}.tfstate`,
    `-backend-config=endpoints={s3="https://${settings.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"}`,
  ],
  false,
);
const outputs = JSON.parse(tofu(["output", "-json"], true));
const value = (name) =>
  outputs[name]?.value || die(`tofu output ${name} is missing; run npm run deploy:infra for ${STAGE}`);

const endpoint = `https://${value("hostname")}`;

const download = (release, kind, entries, architecture) =>
  downloadRelease({ endpoint, stage: STAGE, release, kind, entries, architecture, dir: RELEASE_DIR }).catch((error) =>
    die(error.message),
  );

const localArchitecture =
  LOCAL_ARCHITECTURES[process.arch] ?? die(`no release CLI for ${process.arch}; set TUMPEL_PROOF_CLI to a local build`);
const release =
  process.env.TUMPEL_PROOF_CLI && process.env.TUMPEL_PROOF_SUPERVISOR
    ? undefined
    : await currentRelease(endpoint, STAGE).catch((error) => die(error.message));
const cli = process.env.TUMPEL_PROOF_CLI || (await download(release, "cli", release.clis, localArchitecture));
const supervisor =
  process.env.TUMPEL_PROOF_SUPERVISOR ||
  (await download(release, "supervisor", release.supervisors, HOST_ARCHITECTURE));

const child = spawnSync(command === "tumpel" ? cli : command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    TUMPEL_PROOF_CLI: cli,
    TUMPEL_PROOF_SUPERVISOR: supervisor,
    TUMPEL_PROOF_CLIENT_ID: value("proof_client_id"),
    TUMPEL_PROOF_CLIENT_SECRET: value("proof_client_secret"),
    TUMPEL_PROOF_ENDPOINT: endpoint,
    TUMPEL_PROOF_ISSUER: `https://${value("issuer_hostname")}`,
  },
});
if (child.error) die(`${command}: ${child.error.message}`);
process.exit(child.status ?? 1);
