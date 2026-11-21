#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const BUILDER_BUCKET = "tumpel-builder-secrets";
const HANDOFF_OBJECT = `infra-outputs-${STAGE}.json`;
const HANDOFF_OUTPUTS = [
  "d1_database_id",
  "hostname",
  "dashboard_hostname",
  "issuer_hostname",
  "access_issuer",
  "access_aud",
  "proof_common_name",
  "vapid_public_key",
];
const CONTROL_PLANE = "tumpel-control-plane";
const DASHBOARD = "tumpel-dashboard";
const REPOSITORY = "https://github.com/tumpel/infra.git";
const TOFU_VERSION = "1.13.2";
const RETIRED = ["cloudflare_dns_record.app", "cloudflare_workers_route.app", "cloudflare_dns_record.issuer"];
const BUILD_VARIABLES = [
  "CLOUDFLARE_TOFU_TOKEN",
  "TUMPEL_ACCOUNT_ID",
  "TFSTATE_ACCESS_KEY_ID",
  "TFSTATE_SECRET_ACCESS_KEY",
  "TUMPEL_APPROVER_EMAILS",
  "TUMPEL_BOOTSTRAP_API_TOKEN",
];

const die = (message) => {
  console.error(`deploy-infra: ${message}`);
  process.exit(1);
};

const databaseId = process.argv[2] || die("usage: deploy-infra.mjs <D1 database id>");
if (!/^[a-z][a-z0-9]{1,15}$/.test(STAGE)) die(`TUMPEL_STAGE ${STAGE} must be 2 to 16 lower-case letters and digits`);
const missing = BUILD_VARIABLES.filter((name) => !process.env[name]);
if (missing.length > 0)
  die(
    `the Workers Builds trigger lacks the build variables ${missing.join(", ")}; cloudflare-builds-bootstrap sets them`,
  );
const token = process.env.CLOUDFLARE_TOFU_TOKEN;
const accountId = process.env.TUMPEL_ACCOUNT_ID;

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pin = JSON.parse(readFileSync(join(REPO_ROOT, "release-pins.json"), "utf8")).infra;
if (!pin) die("release-pins.json names no infra");
const ROOT = mkdtempSync(join(tmpdir(), "infra-"));

const run = (command, args, { cwd = ROOT, env = process.env, capture = false, input } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", "inherit"],
    timeout: 600_000,
  });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result.stdout;
};

run("git", ["init", "--quiet"]);
run("git", ["fetch", "--quiet", "--depth", "1", REPOSITORY, pin]);
run("git", ["checkout", "--quiet", "FETCH_HEAD"]);

const cfFetch = (path, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });

const cfGet = async (path) => {
  const response = await cfFetch(path);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) die(`GET ${path} returned ${response.status}; check the tumpel-tofu token`);
  return body.result;
};

const workerExists = async (name) => {
  const path = `/accounts/${accountId}/workers/scripts/${name}-${STAGE}/settings`;
  const response = await cfFetch(path);
  if (response.status === 404) return false;
  if (!response.ok) die(`GET ${path} returned ${response.status}; check the tumpel-tofu token`);
  return true;
};

const writeHandoff = async (handoff) => {
  const path = `/accounts/${accountId}/r2/buckets/${BUILDER_BUCKET}/objects/${encodeURIComponent(HANDOFF_OBJECT)}`;
  const response = await cfFetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(handoff),
  });
  if (!response.ok) die(`PUT ${path} returned ${response.status}; the token needs Workers R2 Storage Write`);
};

const installTofu = async () => {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? die(`no OpenTofu build for ${process.arch}`);
  const dir = mkdtempSync(join(tmpdir(), "tofu-"));
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
  if (!expected || expected !== createHash("sha256").update(tarball).digest("hex"))
    die(`${archive} does not match its published SHA256 sum`);
  writeFileSync(join(dir, archive), tarball);
  run("tar", ["-xzf", archive, "tofu"], { cwd: dir });
  const binary = join(dir, "tofu");
  chmodSync(binary, 0o755);
  return binary;
};

const otp = (await cfGet(`/accounts/${accountId}/access/identity_providers`)).find(
  (provider) => provider.type === "onetimepin",
);
if (!otp) die("the account has no One-time PIN login method; add it under Zero Trust, Settings, Authentication");

const tofuBinary = await installTofu();
const tofuEnv = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: token,
  AWS_ACCESS_KEY_ID: process.env.TFSTATE_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.TFSTATE_SECRET_ACCESS_KEY,
  TF_DATA_DIR: join(ROOT, ".terraform"),
  TF_IN_AUTOMATION: "1",
  TF_VAR_stage: STAGE,
  TF_VAR_account_id: accountId,
  TF_VAR_otp_idp_id: otp.id,
  TF_VAR_approver_emails: process.env.TUMPEL_APPROVER_EMAILS,
  TF_VAR_bootstrap_api_token: process.env.TUMPEL_BOOTSTRAP_API_TOKEN,
};
const tofu = (args, options = {}) => run(tofuBinary, args, { env: tofuEnv, ...options });
const wranglerEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WRANGLER_CI_"))),
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: accountId,
};

tofu([
  "init",
  "-input=false",
  `-backend-config=key=tumpel-${STAGE}.tfstate`,
  `-backend-config=endpoints={s3="https://${accountId}.r2.cloudflarestorage.com"}`,
]);

const planPath = join(ROOT, `tumpel-${STAGE}.tfplan`);
const firstDeploys = [
  [CONTROL_PLANE, "-exclude=cloudflare_workers_custom_domain.api"],
  [CONTROL_PLANE, "-exclude=cloudflare_workers_custom_domain.issuer"],
  [DASHBOARD, "-exclude=cloudflare_workers_custom_domain.app"],
  [DASHBOARD, "-exclude=cloudflare_workers_custom_domain.dashboard"],
];
const excluded = [];
for (const [name, exclusion] of firstDeploys) if (!(await workerExists(name))) excluded.push(exclusion);
if (excluded.length > 0)
  console.log(`deploy-infra: a Worker of ${STAGE} is missing, so its custom domains wait for the next infra build`);

tofu(["plan", "-input=false", `-out=${planPath}`, ...excluded]);
const plan = JSON.parse(tofu(["show", "-json", planPath], { capture: true }));
const destroyed = (plan.resource_changes ?? []).filter(
  (change) => change.change.actions.includes("delete") && !RETIRED.includes(change.address),
);
if (destroyed.length > 0) die(`the plan destroys ${destroyed.map((change) => change.address).join(", ")}; refusing`);
tofu(["apply", "-input=false", planPath]);

const outputs = JSON.parse(tofu(["output", "-json"], { capture: true }));
const output = (name) => outputs[name]?.value ?? die(`tofu output ${name} is missing`);
const handoff = {
  ...Object.fromEntries(HANDOFF_OUTPUTS.map((name) => [name, output(name)])),
  infra_fingerprint: pin,
};
if (handoff.d1_database_id !== databaseId)
  die(`the infra of ${STAGE} names D1 database ${handoff.d1_database_id}, not ${databaseId}`);

if (await workerExists(CONTROL_PLANE)) {
  run(join(REPO_ROOT, "node_modules", ".bin", "wrangler"), ["secret", "bulk", "--name", `${CONTROL_PLANE}-${STAGE}`], {
    env: wranglerEnv,
    input: JSON.stringify(output("worker_secrets")),
  });
} else {
  console.log(`deploy-infra: ${CONTROL_PLANE}-${STAGE} is missing, so its secrets wait for the next infra build`);
}
await writeHandoff(handoff);
console.log(`deploy-infra: applied tumpel/infra ${pin} and wrote ${BUILDER_BUCKET}/${HANDOFF_OBJECT}`);
