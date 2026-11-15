import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { githubToken, loadCredential as loadSubscription } from "./credentials.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PROOF_TENANT_FILE = join(ROOT, "doc", "personas", "proof-tenant.json");
export const INLINE_CAP = 65_536;
export const SECRET_SETS = ["proof", "refused", "ticket-worker"];

export const loadCredential = (die) => loadSubscription("TUMPEL_PROOF_CREDENTIAL", die);

export const proofTenantApply = (credential, die) => {
  return {
    args: ["config", "apply", PROOF_TENANT_FILE],
    env: {
      PROOF_CLAUDE_CODE_OAUTH_TOKEN: credential.token,
      PROOF_CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: credential.expiresAt,
      PROOF_REFUSED_KEY: `proof-invalid-${randomBytes(16).toString("hex")}`,
      PROOF_GITHUB_TOKEN: githubToken(die),
    },
  };
};
