import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
const client = z.object({
  version,
  sha,
  protocol: version,
  binaries: z.array(z.object({ architecture: z.enum(["Amd64", "Arm64"]), sha256: digest })).min(1),
});
export const CandidateSchema = z.object({
  candidateId: digest,
  stage: z.string().regex(/^[a-z][a-z0-9]{1,15}$/),
  createdAt: z.int(),
  pins: z.object({ controlPlane: sha, infra: sha, cli: version, supervisor: version }),
  protocol: version,
  clients: z.object({ cli: client, supervisor: client }),
  dashboard: z.object({
    version,
    sha,
    url: z.url().startsWith("https://github.com/tumpel/dashboard/releases/download/"),
    sha256: digest,
    files: z
      .array(
        z.object({
          path: z
            .string()
            .refine((path) => path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..")),
          sha256: digest,
        }),
      )
      .refine((files) => files.some((file) => file.path === "index.html")),
  }),
});
export const ReadinessSchema = z.object({
  candidateId: digest,
  scope: z.literal("TumpelRun"),
  inventoryComplete: z.literal(true),
  stage: z.string(),
  observedAt: z.int(),
  status: z.enum(["Pending", "Ready", "Failed"]),
  supervisors: z.array(z.object({ hostId: z.string(), online: z.boolean(), supervisorVersion: z.string() })),
  consumers: z.array(
    z.object({
      repository: z.enum(["tumpel/cli", "tumpel/supervisor", "tumpel/control-plane"]),
      kind: z.enum(["Cli", "Supervisor", "Mcp"]),
      sha,
      protocol: version,
      status: z.enum(["Pending", "Ready", "Failed"]),
    }),
  ),
});
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const freezeCandidate = (input) => {
  const source = CandidateSchema.omit({ candidateId: true }).parse(input);
  return CandidateSchema.parse({ candidateId: hash(JSON.stringify(source)), ...source });
};
export const checkedCandidate = (input) => {
  const candidate = CandidateSchema.parse(input);
  const { candidateId, ...source } = candidate;
  if (hash(JSON.stringify(source)) !== candidateId)
    throw new Error("Candidate changed after freezing; assemble a new candidate.");
  for (const name of ["cli", "supervisor"]) {
    if (
      candidate.clients[name].version !== candidate.pins[name] ||
      candidate.clients[name].protocol !== candidate.protocol
    )
      throw new Error(`${name} was not built against the candidate protocol; publish a matching client release.`);
  }
  return candidate;
};

export const readCandidate = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);

export const candidateFor = (input, pins, stage) => {
  if (input?.clients === undefined) return undefined;
  const candidate = checkedCandidate(input);
  if (candidate.stage !== stage || Object.entries(candidate.pins).some(([key, value]) => pins[key] !== value))
    throw new Error(
      "Candidate evidence does not match the stage and pins; supply matching evidence before continuing.",
    );
  return candidate;
};

export const exactChecks = async (repository, sha, github, clock = { sleep: setTimeout }) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { workflow_runs: runs } = await github(
      `/repos/${repository}/actions/workflows/checks.yml/runs?head_sha=${sha}&event=push&per_page=100`,
    );
    const [run] = runs
      .filter((run) => run.head_sha === sha && run.head_branch === "main" && run.event === "push")
      .sort((a, b) => b.id - a.id);
    if (run?.status === "completed") {
      if (run.conclusion !== "success")
        throw new Error(`Checks failed for ${repository}@${sha}; fix that exact commit before releasing.`);
      return;
    }
    if (attempt === 9) throw new Error(`Checks timed out after 10 observations for ${repository}@${sha}.`);
    await clock.sleep(1000 * 2 ** attempt);
  }
};

export const verifyManifest = (candidate, manifest) => {
  for (const [kind, name, field] of [
    ["clis", "cli", "cliVersion"],
    ["supervisors", "supervisor", "supervisorVersion"],
  ]) {
    const expected = candidate.clients[name].binaries;
    if (
      !Array.isArray(manifest[kind]) ||
      manifest[kind].length !== expected.length ||
      manifest[kind].some(
        (entry) =>
          entry[field] !== candidate.pins[name] ||
          !expected.some((binary) => binary.architecture === entry.architecture && binary.sha256 === entry.sha256),
      )
    )
      throw new Error(
        `The stage manifest does not serve candidate ${name}; publish and read back the intended clients.`,
      );
  }
};

export const readyClients = async (candidate, { read, clock = { now: Date.now, sleep: setTimeout } }) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const input = await read();
    if (input === undefined || input === null)
      throw new Error(
        "Client readiness is missing; collect evidence for this candidate before publishing or deploying.",
      );
    const evidence = ReadinessSchema.parse(input);
    if (
      evidence.candidateId !== candidate.candidateId ||
      evidence.stage !== candidate.stage ||
      evidence.observedAt < candidate.createdAt ||
      evidence.observedAt > clock.now() ||
      clock.now() - evidence.observedAt > 60_000
    )
      throw new Error("Client readiness is missing or stale; collect fresh evidence for this candidate and stage.");
    if (evidence.status === "Failed" || evidence.consumers.some((consumer) => consumer.status === "Failed"))
      throw new Error("A Tumpel-run client failed readiness; fix it before API activation.");
    for (const name of ["cli", "supervisor", "control-plane"]) {
      const wanted = name === "control-plane" ? candidate.pins.controlPlane : candidate.clients[name].sha;
      if (
        !evidence.consumers.some(
          (consumer) =>
            consumer.repository === `tumpel/${name}` &&
            consumer.kind === { cli: "Cli", supervisor: "Supervisor", "control-plane": "Mcp" }[name] &&
            consumer.sha === wanted &&
            consumer.protocol === candidate.protocol,
        )
      )
        throw new Error(
          `Missing Tumpel-run ${name} readiness for the exact candidate; external clients cannot acknowledge it.`,
        );
    }
    if (
      evidence.status === "Ready" &&
      evidence.consumers.every((consumer) => consumer.status === "Ready") &&
      evidence.supervisors.every((host) => !host.online || host.supervisorVersion === candidate.pins.supervisor)
    ) {
      return;
    }
    if (attempt === 9) throw new Error("Client readiness timed out after 10 observations; the API remains unchanged.");
    await clock.sleep(1000 * 2 ** attempt);
  }
};

export const verifyStageClients = async (candidate, manifest, transport = fetch) => {
  verifyManifest(candidate, await manifest());
  const origin = `https://api.${candidate.stage === "prod" ? "" : `${candidate.stage}.`}tumpel.dev`;
  for (const name of ["cli", "supervisor"]) {
    for (const binary of candidate.clients[name].binaries) {
      const response = await transport(
        `${origin}/v1/releases/${name}/${binary.architecture}?candidate=${candidate.candidateId}`,
        { signal: AbortSignal.timeout(30_000), cache: "no-store" },
      );
      if (!response.ok || hash(Buffer.from(await response.arrayBuffer())) !== binary.sha256)
        throw new Error(`The stage ${name} endpoint differs from the candidate release; the API remains unchanged.`);
    }
  }
};

export const verifyDashboard = async (candidate, transport = fetch) => {
  const api = `https://api.${candidate.stage === "prod" ? "" : `${candidate.stage}.`}tumpel.dev`;
  const origin = `https://${candidate.stage === "prod" ? "" : `${candidate.stage}.`}tumpel.dev`;
  for (const file of candidate.dashboard.files) {
    const path = file.path === "index.html" ? "/" : `/${file.path}`;
    const response = await transport(`${origin}${path}?candidate=${candidate.candidateId}`, {
      redirect: "error",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Dashboard read-back failed (${response.status}); the API remains unchanged.`);
    let bytes = Buffer.from(await response.arrayBuffer());
    if (file.path.endsWith(".html"))
      bytes = Buffer.from(bytes.toString().replace(`<meta name="tumpel-api-origin" content="${api}">`, ""));
    if (hash(bytes) !== file.sha256)
      throw new Error(`Dashboard ${file.path} differs from its tarball; the API remains unchanged.`);
  }
};

export const activateCandidate = async (
  input,
  {
    pins,
    handoff,
    lease,
    prepared,
    github,
    readiness,
    manifest,
    dashboard,
    migrate,
    api,
    active,
    receipt,
    clock = { now: Date.now, sleep: setTimeout },
    transport = fetch,
    notice = console.log,
  },
) => {
  if (input === undefined) {
    notice(
      "::notice::Candidate client evidence is absent; deploying dashboard, migrations and API in the existing order.",
    );
    await dashboard();
    await migrate();
    await api();
    return;
  }
  const candidate = checkedCandidate(input);
  if (
    Object.entries(candidate.pins).some(([key, value]) => pins[key] !== value) ||
    (await handoff()).infra_fingerprint !== candidate.pins.infra
  )
    throw new Error("Pins or infra handoff do not match the candidate; refresh the handoff before code writes.");
  const assertLease = async () => {
    if ((await lease())?.candidateId !== candidate.candidateId)
      throw new Error("Another candidate owns this stage; finish its activation first.");
  };
  await assertLease();
  const published = await prepared();
  if (published.candidateId !== candidate.candidateId)
    throw new Error("Candidate clients were not published; a pin commit cannot authorize API activation.");
  await exactChecks("tumpel/control-plane", candidate.pins.controlPlane, github, clock);
  const readManifest = async () => {
    const served = await manifest();
    if (hash(JSON.stringify(served)) !== hash(JSON.stringify(published.manifest)))
      throw new Error("The stage manifest changed after publication; assemble a new candidate.");
    return served;
  };
  await readyClients(candidate, { read: readiness, clock });
  await verifyStageClients(candidate, readManifest, transport);
  await assertLease();
  if ((await handoff()).infra_fingerprint !== candidate.pins.infra)
    throw new Error("Infra changed before dashboard activation; refresh the handoff.");
  await dashboard();
  await verifyDashboard(candidate, transport);
  await assertLease();
  await readyClients(candidate, { read: readiness, clock });
  await verifyStageClients(candidate, readManifest, transport);
  if ((await handoff()).infra_fingerprint !== candidate.pins.infra)
    throw new Error("Infra changed before migrations; refresh the handoff.");
  await migrate();
  await assertLease();
  if ((await handoff()).infra_fingerprint !== candidate.pins.infra)
    throw new Error("Infra changed during activation; refresh the handoff.");
  await exactChecks("tumpel/control-plane", candidate.pins.controlPlane, github, clock);
  await readyClients(candidate, { read: readiness, clock });
  await verifyStageClients(candidate, readManifest, transport);
  await assertLease();
  if ((await handoff()).infra_fingerprint !== candidate.pins.infra)
    throw new Error("Infra changed before API activation; refresh the handoff.");
  await api();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await active()) === candidate.pins.controlPlane) {
      await receipt({ candidateId: candidate.candidateId, controlPlane: candidate.pins.controlPlane });
      return;
    }
    if (attempt === 9) throw new Error("Worker activation timed out after 10 observations; the stage remains claimed.");
    await clock.sleep(1000 * 2 ** attempt);
  }
};

export const supervisorVersion = (manifest) => {
  const entries = manifest?.supervisors;
  const version = entries?.[0]?.supervisorVersion;
  return version && entries.every((entry) => entry?.supervisorVersion === version) ? version : undefined;
};

const approvalLabel = "supervisor-rollout-approved";

const approvalApi = (path, paginate = false) =>
  JSON.parse(
    execFileSync("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), path], {
      encoding: "utf8",
      timeout: 30_000,
    }),
  );

export const supervisorRolloutAllowed = async (current, proposed, approval, api = approvalApi) => {
  if (proposed && proposed === current) return true;
  if (!proposed || !approval) return false;
  const { repository, eventName, event, requested, triggeringActor, actor } = approval;
  let login;
  if (eventName === "pull_request" && event.action === "labeled" && event.label?.name === approvalLabel) {
    const pages = await api(`repos/${repository}/issues/${event.pull_request.number}/events?per_page=100`, true);
    const latest = pages
      .flat()
      .findLast((entry) => entry.label?.name === approvalLabel && ["labeled", "unlabeled"].includes(entry.event));
    if (
      latest?.event !== "labeled" ||
      latest.actor?.type !== "User" ||
      !latest.actor.id ||
      latest.actor.id !== event.sender?.id ||
      latest.performed_via_github_app
    )
      return false;
    login = latest.actor.login;
  } else if (eventName === "workflow_dispatch" && requested === true && triggeringActor === actor) {
    login = triggeringActor;
  }
  if (!login || login.toLowerCase() === "github-actions" || login.toLowerCase().endsWith("[bot]")) return false;
  const { permission, user } = await api(`repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`);
  return (
    permission === "admin" &&
    user?.type === "User" &&
    user.login === login &&
    (eventName !== "pull_request" || user.id === event.sender.id)
  );
};

export const publishCandidate = async (
  input,
  manifest,
  {
    get,
    put,
    github,
    readiness,
    endpoint,
    clock,
    transport = fetch,
    notice = console.log,
    approval,
    approvalApi,
    skipSuperseded,
  },
) => {
  const previousManifest = await get("current.json");
  if (previousManifest && skipSuperseded?.(previousManifest.value)) return false;
  const candidate = input === undefined ? undefined : checkedCandidate(input);
  if (candidate) {
    await exactChecks("tumpel/control-plane", candidate.pins.controlPlane, github, clock);
    for (const name of ["cli", "supervisor"])
      await exactChecks(`tumpel/${name}`, candidate.clients[name].sha, github, clock);
    verifyManifest(candidate, manifest);
    await readyClients(candidate, { read: readiness, clock });
  }
  if (
    !(await supervisorRolloutAllowed(
      supervisorVersion(previousManifest?.value),
      supervisorVersion(manifest),
      approval,
      approvalApi,
    ))
  )
    throw new Error(
      "Supervisor rollouts are on hold until the bootstrap release. Ask a repository admin to dispatch the release for this stage and ref with supervisor_rollout_approved set to true.",
    );
  if (previousManifest && !previousManifest.etag)
    throw new Error("The live manifest has no ETag. Restore conditional writes before publishing.");
  const manifestConditions = previousManifest ? { "if-match": previousManifest.etag } : { "if-none-match": "*" };
  if (candidate === undefined) {
    notice("::notice::Candidate client evidence is absent; publishing the manifest through the existing release path.");
    await put("current.json", manifest, manifestConditions);
    return true;
  }
  const previous = await get("rollout.json");
  if (
    previous?.value &&
    previous.value.candidateId !== candidate.candidateId &&
    !(await get(`activated/${previous.value.candidateId}.json`))
  )
    throw new Error("Another candidate owns this stage; finish its Worker activation before publishing.");
  const leaseEtag =
    previous?.value?.candidateId === candidate.candidateId
      ? previous.etag
      : await put(
          "rollout.json",
          { candidateId: candidate.candidateId },
          previous ? { "if-match": previous.etag } : { "if-none-match": "*" },
        );
  const restore = async (key, record, etag) => {
    await put(key, record?.value ?? null, { "if-match": etag });
  };
  const manifestEtag = await put("current.json", manifest, manifestConditions).catch(async (error) => {
    const current = await get("current.json");
    if (current && hash(JSON.stringify(current.value)) === hash(JSON.stringify(manifest)))
      await restore("current.json", previousManifest, current.etag);
    await restore("rollout.json", previous, leaseEtag);
    throw error;
  });
  try {
    await verifyStageClients(
      candidate,
      async () => {
        const served = await endpoint();
        if (hash(JSON.stringify(served)) !== hash(JSON.stringify(manifest)))
          throw new Error("Stage manifest read-back differs from publication; keep main pins unchanged.");
        return served;
      },
      transport,
    );
    await put(`prepared/${candidate.candidateId}.json`, { candidateId: candidate.candidateId, manifest });
  } catch (error) {
    await restore("current.json", previousManifest, manifestEtag);
    await restore("rollout.json", previous, leaseEtag);
    throw error;
  }
  return true;
};
