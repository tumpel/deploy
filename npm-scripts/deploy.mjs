#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE = join(ROOT, "packages", "control-plane");
const DASHBOARD = join(ROOT, "packages", "dashboard");
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

const BUILDS = process.env.WORKERS_CI === "1";
const BUILDER_BUCKET = "tumpel-builder-secrets";
const TOFU_VERSION = "1.13.2";

const builderObject = async (accountId, key) => {
  const path = `/accounts/${accountId}/r2/buckets/${BUILDER_BUCKET}/objects/${encodeURIComponent(key)}`;
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    die(
      `GET ${path} returned ${response.status}; the bucket must hold CLOUDFLARE_TOFU_TOKEN, TFSTATE_ACCESS_KEY_ID, TFSTATE_SECRET_ACCESS_KEY and deploy.secrets.json (see doc/deploy.md)`,
    );
  }
  return (await response.text()).trim();
};

const readSettings = async () => {
  if (BUILDS) {
    const accountId =
      process.env.TUMPEL_ACCOUNT_ID || die("TUMPEL_ACCOUNT_ID is not set on the Workers Builds trigger");
    const deploySecrets = JSON.parse(await builderObject(accountId, "deploy.secrets.json"));
    return {
      CLOUDFLARE_API_TOKEN: await builderObject(accountId, "CLOUDFLARE_TOFU_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: accountId,
      TFSTATE_ACCESS_KEY_ID: await builderObject(accountId, "TFSTATE_ACCESS_KEY_ID"),
      TFSTATE_SECRET_ACCESS_KEY: await builderObject(accountId, "TFSTATE_SECRET_ACCESS_KEY"),
      TUMPEL_APPROVER_EMAILS: deploySecrets.TUMPEL_APPROVER_EMAILS,
      TUMPEL_BOOTSTRAP_API_TOKEN: process.env.TUMPEL_BOOTSTRAP_API_TOKEN || deploySecrets.TUMPEL_BOOTSTRAP_API_TOKEN,
    };
  }
  if (!existsSync(ENV_FILE)) {
    die(
      `${ENV_FILE} is missing; decrypt tumpel-tofu-token and tumpel-tfstate-s3 from dotfiles into it (see doc/deploy.md)`,
    );
  }
  return {
    ...Object.fromEntries(
      readFileSync(ENV_FILE, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
    ),
    TUMPEL_BOOTSTRAP_API_TOKEN: process.env.TUMPEL_BOOTSTRAP_API_TOKEN,
  };
};

const settings = await readSettings();
const REQUIRED = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "TFSTATE_ACCESS_KEY_ID",
  "TFSTATE_SECRET_ACCESS_KEY",
  "TUMPEL_APPROVER_EMAILS",
];
const missing = REQUIRED.filter((name) => !settings[name]);
if (missing.length > 0) die(`the deploy settings do not set ${missing.join(", ")} (see doc/deploy.md)`);
const token = settings.CLOUDFLARE_API_TOKEN;
const accountId = settings.CLOUDFLARE_ACCOUNT_ID;

const run = (command, args, { cwd = ROOT, env = {}, baseEnv = process.env, capture = false, input } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...baseEnv, ...env },
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
    cwd: options.cwd ?? PACKAGE,
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
const stageConfig = config.env?.[STAGE] ?? die(`wrangler.jsonc has no env ${STAGE}`);
const workerExists = async (name) => {
  const path = `/accounts/${accountId}/workers/scripts/${name}-${STAGE}/settings`;
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) die(`GET ${path} returned ${response.status}; check the tumpel-tofu token`);
  return true;
};
const otp = (await cfGet(`/accounts/${accountId}/access/identity_providers`)).find(
  (provider) => provider.type === "onetimepin",
);
if (!otp) die("the account has no One-time PIN login method; add it under Zero Trust, Settings, Authentication");

mkdirSync(WORK, { recursive: true });
const dotfilesBootstrapKey = () => {
  const bootstrapKeyFile = join(WORK, "bootstrap-key");
  run("dotfiles-key", ["decrypt", "reader-cloudflare-tofu-token", "-o", bootstrapKeyFile], { capture: true });
  const value = readFileSync(bootstrapKeyFile, "utf8")
    .split("\n")
    .find((line) => line.startsWith("CLOUDFLARE_TOFU_TOKEN="))
    ?.slice("CLOUDFLARE_TOFU_TOKEN=".length)
    .trim();
  rmSync(bootstrapKeyFile);
  return value;
};
const bootstrapKey =
  settings.TUMPEL_BOOTSTRAP_API_TOKEN ||
  (BUILDS ? undefined : dotfilesBootstrapKey()) ||
  die(
    "no bootstrap key: set TUMPEL_BOOTSTRAP_API_TOKEN in the build variables or deploy.secrets.json, or run dotfiles-key unlock",
  );

const installTofu = async () => {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? die(`no OpenTofu build for ${process.arch}`);
  const dir = join(WORK, `tofu-${TOFU_VERSION}`);
  const binary = join(dir, "tofu");
  if (existsSync(binary)) return binary;
  mkdirSync(dir, { recursive: true });
  const base = `https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}`;
  const archive = `tofu_${TOFU_VERSION}_linux_${arch}.tar.gz`;
  const download = async (name) => {
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) die(`downloading ${name} returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const [tarball, sums] = await Promise.all([download(archive), download(`tofu_${TOFU_VERSION}_SHA256SUMS`)]);
  const expected = sums
    .toString("utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(" ")[0];
  if (!expected || expected !== createHash("sha256").update(tarball).digest("hex")) {
    die(`${archive} does not match its published SHA256 sum`);
  }
  writeFileSync(join(dir, archive), tarball);
  run("tar", ["-xzf", archive, "tofu"], { cwd: dir });
  chmodSync(binary, 0o755);
  return binary;
};
const tofuBinary = await installTofu();

const tofuEnv = {
  CLOUDFLARE_API_TOKEN: token,
  AWS_ACCESS_KEY_ID: settings.TFSTATE_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: settings.TFSTATE_SECRET_ACCESS_KEY,
  TF_DATA_DIR: join(WORK, `tofu-data-${STAGE}`),
  TF_IN_AUTOMATION: "1",
  TF_VAR_stage: STAGE,
  TF_VAR_account_id: accountId,
  TF_VAR_otp_idp_id: otp.id,
  TF_VAR_approver_emails: settings.TUMPEL_APPROVER_EMAILS,
  TF_VAR_bootstrap_api_token: bootstrapKey,
};
const tofu = (args, options = {}) => run(tofuBinary, args, { cwd: INFRA, env: tofuEnv, ...options });

tofu([
  "init",
  "-input=false",
  `-backend-config=key=tumpel-${STAGE}.tfstate`,
  `-backend-config=endpoints={s3="https://${accountId}.r2.cloudflarestorage.com"}`,
]);
const planPath = join(WORK, `tumpel-${STAGE}.tfplan`);
const RETIRED = ["cloudflare_dns_record.app", "cloudflare_workers_route.app", "cloudflare_dns_record.issuer"];
const apply = (extra) => {
  tofu(["plan", "-input=false", `-out=${planPath}`, ...extra]);
  const plan = JSON.parse(tofu(["show", "-json", planPath], { capture: true }));
  const destroyed = (plan.resource_changes ?? []).filter(
    (change) => change.change.actions.includes("delete") && !RETIRED.includes(change.address),
  );
  if (destroyed.length > 0) die(`the plan destroys ${destroyed.map((change) => change.address).join(", ")}; refusing`);
  tofu(["apply", "-input=false", planPath]);
};
const firstDeploys = [
  [config.name, "-exclude=cloudflare_workers_custom_domain.api"],
  [config.name, "-exclude=cloudflare_workers_custom_domain.issuer"],
  ["tumpel-dashboard", "-exclude=cloudflare_workers_custom_domain.app"],
  ["tumpel-dashboard", "-exclude=cloudflare_workers_custom_domain.dashboard"],
];
const excluded = [];
for (const [name, exclusion] of firstDeploys) if (!(await workerExists(name))) excluded.push(exclusion);
apply(excluded);
const outputs = JSON.parse(tofu(["output", "-json"], { capture: true }));
const output = (name) => outputs[name]?.value ?? die(`tofu output ${name} is missing`);

const databaseId = output("d1_database_id");
if (stageConfig.d1_databases[0].database_id !== databaseId) {
  die(
    `set env.${STAGE}.d1_databases[0].database_id in packages/control-plane/wrangler.jsonc to ${databaseId}, commit it, and deploy again`,
  );
}
if (mode === "infra") process.exit(0);

run("npm", ["run", "build", "-w", "@tumpel/dashboard"], {
  env: { VITE_TUMPEL_API_ORIGIN: `https://${output("hostname")}` },
});
wrangler(["deploy"], {
  cwd: DASHBOARD,
  baseEnv: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WRANGLER_CI_"))),
});
wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
const dashboardRedirects = JSON.stringify([`https://${output("dashboard_hostname")}/auth/callback`]);
wrangler([
  "d1",
  "execute",
  "DB",
  "--remote",
  "--yes",
  "--command",
  `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, first_party) VALUES ('tumpel-dashboard', 'the tumpel dashboard', '${dashboardRedirects}', ${Date.now()}, 1) ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, first_party = 1`,
]);
const workerSecrets = output("worker_secrets");
wrangler([
  "deploy",
  "--var",
  `ACCESS_ISSUER:${output("access_issuer")}`,
  "--var",
  `ACCESS_AUD:${output("access_aud")}`,
  "--var",
  `ACCESS_PROOF_COMMON_NAME:${output("proof_common_name")}`,
  "--var",
  `ISSUER_HOSTNAME:${output("issuer_hostname")}`,
  "--var",
  `DASHBOARD_ORIGIN:https://${output("dashboard_hostname")}`,
  "--var",
  `API_ORIGIN:https://${output("hostname")}`,
]);
wrangler(["secret", "bulk"], { input: JSON.stringify(workerSecrets) });
if (excluded.length > 0) apply([]);
console.log(`deploy: https://${output("hostname")} and https://${output("dashboard_hostname")}`);
