#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { PersonaSchema, StartedSessionSchema } from "@tumpel/api/schemas";
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

const IssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  url: z.url(),
});

const PullRequestsSchema = z.array(z.object({ url: z.url() }));

const PROMPT = ({
  owner,
  repo,
  issue,
  branch,
}) => `Work GitHub issue #${issue.number} of ${owner}/${repo}: ${issue.title}
${issue.url}

${issue.body}

The repository is cloned in your working directory at its default branch. Create the branch ${branch} from it and make the change the issue asks for, in one or more commits with conventional commit subjects. Push the branch to origin and open a draft pull request with gh pr create --draft --head ${branch}. Its title is a conventional commit subject, and its body is four short lines: what, why, how, and "Closes ${issue.url}". Print the pull request URL as the last line of your reply, then stop.`;

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

const slug = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

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
  const [, owner, repo] = args.issueUrl.match(ISSUE_URL);
  const env = args.endpoint ? { ...process.env, TUMPEL_ENDPOINT: args.endpoint } : process.env;

  const issue = parsed(
    IssueSchema,
    capture("gh", ["issue", "view", args.issueUrl, "--json", "number,title,body,url"], process.env),
    `gh issue view ${args.issueUrl}`,
  );
  const personas = parsed(PersonaSchema.array(), capture(TUMPEL, ["persona", "list"], env), "tumpel persona list");
  const persona = personas.find((candidate) => candidate.name === args.persona);
  if (!persona) {
    die(
      `the tenant has no persona ${args.persona}; it has ${personas.map((held) => held.name).join(", ")}. Add it with tumpel config apply`,
    );
  }

  const branch = `ticket/${issue.number}-${slug(issue.title)}`;
  const started = parsed(
    StartedSessionSchema,
    capture(
      TUMPEL,
      [
        "session",
        "start",
        "--repository",
        `https://github.com/${owner}/${repo}.git`,
        "--model",
        args.model,
        "--persona-id",
        persona.personaId,
        "--prompt",
        PROMPT({ owner, repo, issue, branch }),
      ],
      env,
    ),
    "tumpel session start",
  );
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
