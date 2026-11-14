import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PROOF_TENANT_FILE = join(ROOT, "doc", "personas", "proof-tenant.json");
export const INLINE_CAP = 65_536;
export const SECRET_SETS = ["proof", "refused", "ticket-worker"];

const parseCredentials = (path, die) => {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return die(`${path} is not valid JSON; sign in to Claude Code again to rewrite it`);
  }
};

const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const expiry = (value, origin, die) => {
  if (!OFFSET_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    die(
      `${origin} holds an expiry that is not an ISO 8601 date-time with an offset; write the expiry claude setup-token printed`,
    );
  }
  return value;
};

const subscriptionToken = (value, origin, die) => {
  if (!value.startsWith("sk-ant-oat")) {
    die(
      `${origin} is not a Claude Code subscription token; ${PROOF_TENANT_FILE} names a SubscriptionToken, so pass one from claude setup-token`,
    );
  }
  return value;
};

export const loadCredential = (reference, die) => {
  const [source, ...rest] = reference.split(":");
  const name = rest.join(":");
  if (source === "dotfiles") {
    const result = spawnSync(
      "bash",
      ["-o", "pipefail", "-c", 'dotfiles-key decrypt "$1" -o /dev/fd/3 3>&1 1>/dev/null | cat', "decrypt", name],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    if (result.status !== 0) die(`dotfiles-key decrypt ${name} exited ${result.status}; run dotfiles-key unlock`);
    const entries = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const assigned = line.match(/^([A-Z_]+)=(.*)$/);
        return assigned ? { key: assigned[1], value: assigned[2] } : { key: "", value: line };
      });
    const token = entries.find((entry) => entry.key !== "EXPIRES_AT")?.value;
    if (!token) die(`dotfiles key ${name} is empty`);
    const expiresAt = entries.find((entry) => entry.key === "EXPIRES_AT")?.value;
    if (!expiresAt) {
      die(
        `dotfiles key ${name} carries no EXPIRES_AT=<ISO 8601 date-time> line; encrypt it again with the expiry claude setup-token printed`,
      );
    }
    const origin = `dotfiles key ${name}`;
    return { token: subscriptionToken(token, origin, die), expiresAt: expiry(expiresAt, origin, die) };
  }
  if (source === "claude-credentials") {
    const path = name || join(homedir(), ".claude", ".credentials.json");
    const oauth = parseCredentials(path, die).claudeAiOauth;
    if (!oauth?.accessToken) die(`${path} holds no claudeAiOauth access token`);
    if (!Number.isInteger(oauth.expiresAt))
      die(`${path} holds no claudeAiOauth expiresAt; sign in to Claude Code again`);
    return {
      token: subscriptionToken(oauth.accessToken, path, die),
      expiresAt: new Date(oauth.expiresAt).toISOString().replace("Z", "+00:00"),
    };
  }
  return die(`credential source ${reference} must be dotfiles:<key name> or claude-credentials[:<path>]`);
};

const githubToken = (die) => {
  const result = spawnSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.error) die(`gh auth token: ${result.error.message}; install gh and put it on PATH`);
  if (result.status !== 0) die(`gh auth token exited ${result.status}; run gh auth login`);
  const token = result.stdout.trim();
  if (!token) die("gh auth token printed nothing; run gh auth login");
  return token;
};

export const proofTenantApply = (credential, die) => {
  return {
    args: ["config", "apply", PROOF_TENANT_FILE, ...SECRET_SETS.flatMap((name) => ["--rewrite-secrets", name])],
    env: {
      PROOF_CLAUDE_CODE_OAUTH_TOKEN: credential.token,
      PROOF_CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: credential.expiresAt,
      PROOF_REFUSED_KEY: `proof-invalid-${randomBytes(16).toString("hex")}`,
      PROOF_GITHUB_TOKEN: githubToken(die),
    },
  };
};
