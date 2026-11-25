#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHandoff, readPin } from "./pinned-source.mjs";
import { downloadAsset } from "./release-download.mjs";

const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = join(ROOT, "packages", "dashboard-site");
const ASSETS = join(SITE, "dist");

const die = (message) => {
  console.error(`deploy-dashboard: ${message}`);
  process.exit(1);
};

const token =
  process.env.CLOUDFLARE_TOFU_TOKEN ||
  die("CLOUDFLARE_TOFU_TOKEN is not set; cloudflare-builds-bootstrap sets it on the Workers Builds trigger");
const accountId =
  process.env.TUMPEL_ACCOUNT_ID ||
  die("TUMPEL_ACCOUNT_ID is not set; cloudflare-builds-bootstrap sets it on the Workers Builds trigger");
const { release } = readPin("dashboard");

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: SITE,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WRANGLER_CI_"))),
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 600_000,
  });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status}`);
};

const releasePath = `/repos/tumpel/dashboard/releases/tags/${encodeURIComponent(release)}`;
const response = await fetch(`https://api.github.com${releasePath}`, {
  headers: { accept: "application/vnd.github+json" },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) die(`GET ${releasePath} returned ${response.status}; pin a published release in pins/dashboard.json`);
const asset = (await response.json()).assets.find((each) => /^dashboard-.+\.tgz$/.test(each.name));
if (!asset) die(`tumpel/dashboard ${release} attaches no dashboard-*.tgz; pin a release that does`);
const { path: archive } = await downloadAsset(
  "tumpel/dashboard",
  release,
  asset.name,
  mkdtempSync(join(tmpdir(), "dashboard-release-")),
).catch((error) => die(error.message));

const handoff = await readHandoff({ stage: STAGE, accountId, token }, die);
rmSync(ASSETS, { recursive: true, force: true });
mkdirSync(ASSETS);
run("tar", ["-xzf", archive, "-C", ASSETS, "--strip-components=2", "package/dist"]);
copyFileSync(join(SITE, "_headers"), join(ASSETS, "_headers"));
const index = join(ASSETS, "index.html");
const html = readFileSync(index, "utf8");
if (!html.includes("<head>"))
  die(`${asset.name} has an index.html without <head>; pin a dashboard release that has one`);
writeFileSync(
  index,
  html.replace("<head>", `<head><meta name="tumpel-api-origin" content="https://${handoff.hostname}">`),
);
run(join(ROOT, "node_modules", ".bin", "wrangler"), ["deploy", "--env", STAGE]);
console.log(`deploy-dashboard: dashboard ${release} at https://${handoff.dashboard_hostname}`);
