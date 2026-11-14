import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PROOF_TENANT_FILE = join(ROOT, "doc", "personas", "proof-tenant.json");
export const INLINE_CAP = 65_536;
export const SECRET_SETS = ["proof", "refused", "ticket-worker"];

const parseCredentials = (path, die) => {
  if (!existsSync(path)) return die("sign in to Claude Code on this machine first");
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return die(`${path} is not valid JSON; sign in to Claude Code again to rewrite it`);
  }
};

const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const MISSING_EXPIRY =
  "the subscription token has no expiry; leave TUMPEL_PROOF_CREDENTIAL unset to use the host Claude Code credential ~/.claude/.credentials.json, or set TUMPEL_PROOF_CREDENTIAL=dotfiles:<key name> together with TUMPEL_PROOF_CREDENTIAL_EXPIRES_AT=<ISO 8601 date-time with offset>";

const expiry = (value, die) => {
  if (!value) die(MISSING_EXPIRY);
  if (!OFFSET_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    die(
      "TUMPEL_PROOF_CREDENTIAL_EXPIRES_AT is not an ISO 8601 date-time with an offset; pass the expiry claude setup-token printed",
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

const dotfilesToken = (name, die) => {
  const result = spawnSync(
    "bash",
    ["-o", "pipefail", "-c", 'dotfiles-key decrypt "$1" -o /dev/fd/3 3>&1 1>/dev/null | cat', "decrypt", name],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (result.status !== 0) die(`dotfiles-key decrypt ${name} exited ${result.status}; run dotfiles-key unlock`);
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const assigned = lines.find((line) => /^[A-Z_]+=/.test(line));
  const value = assigned ? assigned.slice(assigned.indexOf("=") + 1) : lines[0];
  if (!value) die(`dotfiles key ${name} is empty`);
  return subscriptionToken(value, `dotfiles key ${name}`, die);
};

const hostCredential = (path, die) => {
  const oauth = parseCredentials(path, die).claudeAiOauth;
  if (!oauth?.accessToken) die(`${path} holds no claudeAiOauth access token; sign in to Claude Code again`);
  if (!Number.isInteger(oauth.expiresAt)) die("the subscription token has no expiry; sign in to Claude Code again");
  return {
    token: subscriptionToken(oauth.accessToken, path, die),
    expiresAt: new Date(oauth.expiresAt).toISOString().replace("Z", "+00:00"),
  };
};

export const loadCredential = (die) => {
  const reference = process.env.TUMPEL_PROOF_CREDENTIAL ?? "claude-credentials";
  const [source, ...rest] = reference.split(":");
  const name = rest.join(":");
  if (source === "claude-credentials") {
    return hostCredential(name || join(homedir(), ".claude", ".credentials.json"), die);
  }
  if (source === "dotfiles" && name) {
    const expiresAt = expiry(process.env.TUMPEL_PROOF_CREDENTIAL_EXPIRES_AT, die);
    return { token: dotfilesToken(name, die), expiresAt };
  }
  return die("TUMPEL_PROOF_CREDENTIAL must be claude-credentials[:<path>] or dotfiles:<key name>");
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
