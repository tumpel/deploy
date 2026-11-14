import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATED = join(ROOT, ".tmp", "proof-tenant");

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
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const assigned = lines.find((line) => /^[A-Z_]+=/.test(line));
    const value = assigned ? assigned.slice(assigned.indexOf("=") + 1) : lines[0];
    if (!value) die(`dotfiles key ${name} is empty`);
    return subscriptionToken(value, `dotfiles key ${name}`, die);
  }
  if (source === "claude-credentials") {
    const path = name || join(homedir(), ".claude", ".credentials.json");
    const token = parseCredentials(path, die).claudeAiOauth?.accessToken;
    if (!token) die(`${path} holds no claudeAiOauth access token`);
    return subscriptionToken(token, path, die);
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

const writeGeneratedFiles = () => {
  mkdirSync(GENERATED, { recursive: true });
  const lines = ["# Proof persona", "", "Answer briefly. Do what the prompt asks and nothing more.", ""];
  for (let index = 1; lines.join("\n").length <= INLINE_CAP + 4096; index += 1) {
    lines.push(`- Note ${index}: padding that sends this file through the presigned upload route.`);
  }
  writeFileSync(join(GENERATED, "CLAUDE.md"), `${lines.join("\n")}\n`);
};

export const proofTenantApply = (credential, die) => {
  writeGeneratedFiles();
  return {
    args: ["config", "apply", PROOF_TENANT_FILE, ...SECRET_SETS.flatMap((name) => ["--rewrite-secrets", name])],
    env: {
      PROOF_CLAUDE_CODE_OAUTH_TOKEN: credential,
      PROOF_REFUSED_KEY: `proof-invalid-${randomBytes(16).toString("hex")}`,
      PROOF_GITHUB_TOKEN: githubToken(die),
    },
  };
};
