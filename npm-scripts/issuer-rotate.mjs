#!/usr/bin/env node
import { fileURLToPath } from "node:url";

export const ROTATE_PATH = "/v1/issuer-keys/rotate";

export const rotateIssuerKeys = async ({ endpoint, clientId, clientSecret }) => {
  const response = await fetch(`${endpoint}${ROTATE_PATH}`, {
    method: "POST",
    headers: { "cf-access-client-id": clientId, "cf-access-client-secret": clientSecret },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(
      `POST ${endpoint}${ROTATE_PATH} answered ${response.status}: ${text.slice(0, 300)}; check that npm run deploy:infra put the path behind the stage's Access application and that the proof service token is current`,
    );
  }
  return JSON.parse(text);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const endpoint = process.env.TUMPEL_PROOF_ENDPOINT;
  const clientId = process.env.TUMPEL_PROOF_CLIENT_ID;
  const clientSecret = process.env.TUMPEL_PROOF_CLIENT_SECRET;
  if (!endpoint || !clientId || !clientSecret) {
    console.error(
      "issuer:rotate: run it as npm run issuer:rotate, which sets the stage endpoint and its service token",
    );
    process.exit(1);
  }
  const rotation = await rotateIssuerKeys({ endpoint, clientId, clientSecret });
  console.log(JSON.stringify(rotation, null, 2));
  console.error(
    `issuer:rotate: ${rotation.kid} signs from now on; ${rotation.retiring.map((key) => `${key.kid} stays published until ${key.retiresAt}`).join(", ") || "no key retired"}`,
  );
}
