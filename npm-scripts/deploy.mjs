#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE = join(ROOT, "packages", "control-plane");
const INFRA = join(PACKAGE, "infra");
const WORK = join(ROOT, ".tmp", "deploy");
const ENV_FILE = process.env.TUMPEL_CF_ENV ?? join(homedir(), ".config", "tumpel", "cf-env");
const API = "https://api.cloudflare.com/client/v4";
const MODES = ["all", "infra", "migrate"];
const STAGE = process.env.TUMPEL_STAGE ?? "dev";

const die = (message) => {
  console.error(`deploy: ${message}`);
  process.exit(1);
};

const mode = process.argv[2] ?? "all";
if (!MODES.includes(mode)) die(`unknown mode ${mode}; pass one of ${MODES.join(", ")}`);
if (!/^[a-z][a-z0-9]{1,15}$/.test(STAGE)) die(`TUMPEL_STAGE ${STAGE} must be 2 to 16 lower-case letters and digits`);

if (!existsSync(ENV_FILE)) {
  die(
    `${ENV_FILE} is missing; decrypt tumpel-tofu-token and tumpel-tfstate-s3 from dotfiles into it (see doc/deploy.md)`,
  );
}
const settings = Object.fromEntries(
  readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);
const REQUIRED = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "TFSTATE_ACCESS_KEY_ID",
  "TFSTATE_SECRET_ACCESS_KEY",
  "TUMPEL_APPROVER_EMAILS",
];
const missing = REQUIRED.filter((name) => !settings[name]);
if (missing.length > 0) die(`${ENV_FILE} does not set ${missing.join(", ")} (see doc/deploy.md)`);
const token = settings.CLOUDFLARE_API_TOKEN;
const accountId = settings.CLOUDFLARE_ACCOUNT_ID;

const run = (command, args, { cwd = ROOT, env = {}, capture = false, input } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", "inherit"],
    timeout: 600_000,
  });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result.stdout;
};

const wranglerEnv = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };
const wrangler = (args, options = {}) =>
  run(join(ROOT, "node_modules", ".bin", "wrangler"), [...args, "--env", STAGE], {
    cwd: PACKAGE,
    env: wranglerEnv,
    ...options,
  });

if (mode === "migrate") {
  wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
  process.exit(0);
}

const cfGet = async (path) => {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) die(`GET ${path} returned ${response.status}; check the tumpel-tofu token`);
  return body.result;
};

const config = JSON.parse(readFileSync(join(PACKAGE, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const subdomain = (await cfGet(`/accounts/${accountId}/workers/subdomain`)).subdomain;
const stageConfig = config.env?.[STAGE] ?? die(`wrangler.jsonc has no env ${STAGE}`);
const hostname = `${config.name}-${STAGE}.${subdomain}.workers.dev`;
const otp = (await cfGet(`/accounts/${accountId}/access/identity_providers`)).find(
  (provider) => provider.type === "onetimepin",
);
if (!otp) die("the account has no One-time PIN login method; add it under Zero Trust, Settings, Authentication");

const bootstrapKeyFile = join(WORK, "bootstrap-key");
mkdirSync(WORK, { recursive: true });
run("dotfiles-key", ["decrypt", "reader-cloudflare-tofu-token", "-o", bootstrapKeyFile], { capture: true });
const bootstrapKey = readFileSync(bootstrapKeyFile, "utf8")
  .split("\n")
  .find((line) => line.startsWith("CLOUDFLARE_TOFU_TOKEN="))
  ?.slice("CLOUDFLARE_TOFU_TOKEN=".length)
  .trim();
rmSync(bootstrapKeyFile);
if (!bootstrapKey)
  die("dotfiles secret reader-cloudflare-tofu-token does not set CLOUDFLARE_TOFU_TOKEN; run dotfiles-key unlock");

const tofuEnv = {
  CLOUDFLARE_API_TOKEN: token,
  AWS_ACCESS_KEY_ID: settings.TFSTATE_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: settings.TFSTATE_SECRET_ACCESS_KEY,
  TF_DATA_DIR: join(WORK, `tofu-data-${STAGE}`),
  TF_IN_AUTOMATION: "1",
  TF_VAR_stage: STAGE,
  TF_VAR_account_id: accountId,
  TF_VAR_hostname: hostname,
  TF_VAR_otp_idp_id: otp.id,
  TF_VAR_approver_emails: settings.TUMPEL_APPROVER_EMAILS,
  TF_VAR_bootstrap_api_token: bootstrapKey,
};
const tofu = (args, options = {}) => run("tofu", args, { cwd: INFRA, env: tofuEnv, ...options });

tofu([
  "init",
  "-input=false",
  `-backend-config=key=tumpel-${STAGE}.tfstate`,
  `-backend-config=endpoints={s3="https://${accountId}.r2.cloudflarestorage.com"}`,
]);
const planPath = join(WORK, `tumpel-${STAGE}.tfplan`);
tofu(["plan", "-input=false", `-out=${planPath}`]);
const plan = JSON.parse(tofu(["show", "-json", planPath], { capture: true }));
const destroyed = (plan.resource_changes ?? []).filter((change) => change.change.actions.includes("delete"));
if (destroyed.length > 0) die(`the plan destroys ${destroyed.map((change) => change.address).join(", ")}; refusing`);
tofu(["apply", "-input=false", planPath]);
const outputs = JSON.parse(tofu(["output", "-json"], { capture: true }));
const output = (name) => outputs[name]?.value ?? die(`tofu output ${name} is missing`);

const databaseId = output("d1_database_id");
if (stageConfig.d1_databases[0].database_id !== databaseId) {
  die(
    `set env.${STAGE}.d1_databases[0].database_id in packages/control-plane/wrangler.jsonc to ${databaseId}, commit it, and deploy again`,
  );
}
if (mode === "infra") process.exit(0);

wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
const workerSecrets = output("worker_secrets");
wrangler([
  "deploy",
  "--var",
  `ACCESS_ISSUER:${output("access_issuer")}`,
  "--var",
  `ACCESS_AUD:${output("access_aud")}`,
]);
wrangler(["secret", "bulk"], { input: JSON.stringify(workerSecrets) });
console.log(`deploy: https://${hostname}`);
