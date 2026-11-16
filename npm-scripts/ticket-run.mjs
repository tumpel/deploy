#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { PersonaSchema, StartedSessionFromIssueSchema } from "@tumpel/schemas";
import { z } from "zod";

const TUMPEL = process.env.TUMPEL_BIN ?? "tumpel";

const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/;

const ArgsSchema = z.object({
  issueUrl: z.string().regex(ISSUE_URL, "pass a GitHub issue URL such as https://github.com/acme/app/issues/12"),
  persona: z.string().min(1, "pass --persona <name>, a persona tumpel persona list shows"),
  endpoint: z.url().optional(),
  model: z
    .string({ error: "pass --model <name>, the model the session runs" })
    .min(1, "pass --model <name>, the model the session runs"),
});

const PullRequestsSchema = z.array(z.object({ url: z.url() }));

const die = (message) => {
  console.error(`ticket: ${message}`);
  process.exit(1);
};

const parsed = (schema, value, what) => {
  const result = schema.safeParse(value);
  if (!result.success) die(`${what} is not valid: ${z.prettifyError(result.error)}`);
  return result.data;
};

const capture = (command, args, env) => {
  const result = spawnSync(command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}; install ${command} and put it on PATH`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  return JSON.parse(result.stdout);
};

const follow = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(TUMPEL, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (error) =>
      die(`${TUMPEL} transcript read: ${error.message}; set TUMPEL_BIN or put tumpel on PATH`),
    );
    child.on("close", (code) => resolve(code ?? 1));
  });

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      persona: { type: "string" },
      endpoint: { type: "string" },
      model: { type: "string" },
    },
  });
  const args = parsed(
    ArgsSchema,
    { issueUrl: positionals[0], persona: values.persona, endpoint: values.endpoint, model: values.model },
    "npm run ticket -- <issue url> --persona <name> --model <name> [--endpoint <url>]",
  );
  const [, owner, repo, issueNumber] = args.issueUrl.match(ISSUE_URL);
  const env = args.endpoint ? { ...process.env, TUMPEL_ENDPOINT: args.endpoint } : process.env;

  const personas = parsed(PersonaSchema.array(), capture(TUMPEL, ["persona", "list"], env), "tumpel persona list");
  const persona = personas.find((candidate) => candidate.name === args.persona);
  if (!persona) {
    die(
      `persona ${args.persona} not found; apply your tenant config first (the proof applies doc/personas/proof-tenant.json for the proof tenant)`,
    );
  }

  const started = parsed(
    StartedSessionFromIssueSchema,
    capture(
      TUMPEL,
      [
        "session",
        "start-from-issue",
        "--owner",
        owner,
        "--name",
        repo,
        "--issue-number",
        issueNumber,
        "--model",
        args.model,
        "--persona-id",
        persona.personaId,
      ],
      env,
    ),
    "tumpel session start-from-issue",
  );
  const { branch } = started.issue;
  const { turnId } = started.turn;
  console.error(`ticket: session ${started.session.sessionId}, turn ${turnId}, branch ${branch}`);

  const code = await follow(["transcript", "read", turnId, "--follow"], env);
  if (code !== 0) process.exit(code);
  const [pull] = parsed(
    PullRequestsSchema,
    capture("gh", ["pr", "list", "--repo", `${owner}/${repo}`, "--head", branch, "--json", "url"], process.env),
    "gh pr list",
  );
  if (!pull)
    die(`turn ${turnId} completed without a pull request on ${branch}; read it with tumpel transcript read ${turnId}`);
  console.log(pull.url);
};

await main();
