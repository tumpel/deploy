import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createTestHarness } from "wrangler";

const json = (value, status = 200) => Response.json(value, { status });

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();

export const scenarioServices = async (t) => {
  const repositories = new Map();
  const checks = new Map();
  const releases = new Map();
  const assets = new Map();
  const pulls = [];
  const dispatches = [];
  const requests = [];
  const unexpected = [];
  const operations = [];
  const objects = new Map();
  const readBack = { workers: undefined, supervisors: [] };
  const failures = { release: undefined };
  let dashboard;

  const check = (repository, sha, conclusion) => {
    const runs = checks.get(repository) ?? [];
    runs.unshift({
      id: runs.length + 1,
      name: "checks",
      head_sha: sha,
      head_branch: "main",
      event: "push",
      status: conclusion === "pending" ? "in_progress" : "completed",
      conclusion,
    });
    checks.set(repository, runs);
  };

  const publish = (repository, tag, files) => {
    const published = Object.entries(files).map(([name, bytes]) => {
      const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
      assets.set(url, bytes);
      return { name, browser_download_url: url, state: "uploaded" };
    });
    const release = { draft: false, tag_name: tag, published_at: "2026-01-01T00:00:00Z", assets: published };
    releases.set(`${repository}/${tag}`, release);
    return release;
  };

  const github = async (url, method, body) => {
    if (url.pathname === "/graphql" && method === "POST") {
      const { variables } = JSON.parse(body);
      const pull = pulls.find((entry) => entry.node_id === variables.pull);
      assert.ok(pull);
      pull.auto_merge = { merge_method: "squash" };
      return json({ data: { enablePullRequestAutoMerge: { pullRequest: { number: pull.number } } } });
    }
    const [, repository, action] = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(url.pathname) ?? [];
    const root = repositories.get(repository);
    if (action === "actions/workflows/checks.yml/runs" && method === "GET") {
      const sha = url.searchParams.get("head_sha");
      return json({ workflow_runs: (checks.get(repository) ?? []).filter((run) => run.head_sha === sha) });
    }
    if (action === "actions/runs" && method === "GET")
      return json({ workflow_runs: (checks.get(repository) ?? []).filter((run) => run.conclusion === "success") });
    if (action?.startsWith("commits/") && method === "GET")
      return json({ sha: git(root, "rev-parse", `${action.slice("commits/".length)}^{commit}`) });
    if (action?.startsWith("compare/") && method === "GET") {
      const [base, head] = action.slice("compare/".length).split("...");
      const old = git(root, "rev-parse", base);
      const next = git(root, "rev-parse", head);
      const ancestor = git(root, "merge-base", old, next);
      return json({ status: old === next ? "identical" : ancestor === old ? "ahead" : "diverged" });
    }
    if (action?.startsWith("contents/") && method === "GET") {
      const content = git(root, "show", `${url.searchParams.get("ref")}:${action.slice("contents/".length)}`);
      return json({ content: Buffer.from(content).toString("base64") });
    }
    if (action === "releases" && method === "POST") {
      const { tag, sha, assets: files } = JSON.parse(body);
      if (failures.release === tag) return json({ message: "Release unavailable" }, 503);
      git(root, "tag", tag, sha);
      return json(
        publish(
          repository,
          tag,
          Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")])),
        ),
        201,
      );
    }
    if (action === "releases" && method === "GET")
      return json([...releases].filter(([key]) => key.startsWith(`${repository}/`)).map(([, release]) => release));
    if (action?.startsWith("releases/tags/") && method === "GET") {
      const release = releases.get(`${repository}/${action.slice("releases/tags/".length)}`);
      return release ? json(release) : json({ message: "Release not found" }, 404);
    }
    if ((action === "dispatches" || action?.endsWith("/dispatches")) && method === "POST") {
      dispatches.push({ repository, action, event: JSON.parse(body) });
      return new Response(null, { status: 204 });
    }
    if (action === "pulls" && method === "GET") return json(pulls.filter((pull) => pull.state === "open"));
    if (action === "pulls" && method === "POST") {
      const number = pulls.length + 1;
      const pull = { ...JSON.parse(body), state: "open", number, node_id: `pull-${number}` };
      pulls.push(pull);
      return json(pull, 201);
    }
    assert.fail(`Unexpected GitHub request ${method} ${url}`);
  };

  const r2 = (key, method, headers, body) => {
    const existing = objects.get(key);
    if (method === "GET" || method === "HEAD") {
      if (!existing) return new Response(null, { status: 404 });
      return new Response(method === "GET" ? existing.body : null, { headers: { etag: existing.etag } });
    }
    assert.equal(method, "PUT");
    if (
      (headers["if-none-match"] === "*" && existing) ||
      (headers["if-match"] && headers["if-match"] !== existing?.etag)
    )
      return new Response(null, { status: 412 });
    if (headers["x-amz-checksum-sha256"])
      assert.equal(headers["x-amz-checksum-sha256"], createHash("sha256").update(body).digest("base64"));
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    objects.set(key, { etag, body });
    return new Response(null, { headers: { etag } });
  };

  const wrangler = async (body) => {
    const { cwd, args } = JSON.parse(body);
    const [command, operation] = args;
    if (command === "d1") {
      assert.ok(["migrations", "execute"].includes(operation));
      assert.ok(args.includes("--remote"));
      operations.push(operation);
      return new Response(null, { status: 204 });
    }
    assert.equal(command, "deploy");
    const config = JSON.parse(readFileSync(join(cwd, "wrangler.jsonc"), "utf8"));
    if (config.assets) {
      const api = args.find((arg) => arg.startsWith("API_ORIGIN:")).slice("API_ORIGIN:".length);
      await dashboard?.close();
      dashboard = createTestHarness({
        workers: [
          {
            config: {
              name: config.name,
              main: resolve(cwd, config.main),
              compatibility_date: config.compatibility_date,
              assets: { ...config.assets, directory: resolve(cwd, config.assets.directory) },
              vars: { API_ORIGIN: api },
            },
          },
        ],
      });
      await dashboard.listen();
      operations.push("dashboard");
    } else {
      readBack.workers = args.find((arg) => arg.startsWith("DEPLOYED_COMMIT:")).slice("DEPLOYED_COMMIT:".length);
      operations.push("api");
    }
    return new Response(null, { status: 204 });
  };

  const route = async (url, method, headers, body) => {
    if (url.hostname === "api.github.com") return github(url, method, body);
    if (url.hostname === "github.com" && method === "GET") {
      assert.ok(assets.has(url.href), `Unexpected asset ${url}`);
      return new Response(assets.get(url.href));
    }
    if (url.hostname.endsWith(".r2.cloudflarestorage.com"))
      return r2(decodeURIComponent(url.pathname.slice(1)), method, headers, body);
    if (url.hostname === "api.cloudflare.com") {
      if (url.pathname === "/scenario/wrangler" && method === "POST") return wrangler(body);
      const object = /\/r2\/buckets\/([^/]+)\/objects\/(.*)$/.exec(url.pathname);
      if (object) return r2(`${object[1]}/${decodeURIComponent(object[2])}`, method, headers, body);
      if (url.pathname.includes("/d1/database/") && url.pathname.endsWith("/query") && method === "POST")
        return json({ success: true, result: [{ success: true, results: readBack.supervisors }] });
      if (url.pathname.endsWith("/workers/scripts/tumpel-control-plane-dev/settings") && method === "GET") {
        const bindings = [{ name: "DEPLOYED_COMMIT", type: "plain_text", text: readBack.workers }];
        return json({ success: true, result: { bindings } });
      }
    }
    if (url.hostname === "dev.tumpel.dev" && method === "GET") return dashboard.fetch(url);
    assert.fail(`Unexpected request ${method} ${url}`);
  };

  const server = createServer(async (request, reply) => {
    try {
      const target = new URL(request.url, "http://localhost").searchParams.get("target");
      const url = new URL(target);
      const chunks = [];
      for await (const part of request) chunks.push(part);
      requests.push({ url, method: request.method });
      const response = await route(url, request.method, request.headers, Buffer.concat(chunks));
      reply.writeHead(response.status, Object.fromEntries(response.headers));
      reply.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      unexpected.push(error.message);
      reply.writeHead(500).end(error.message);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await dashboard?.close();
    assert.deepEqual(unexpected, []);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    repositories,
    check,
    publish,
    releases,
    assets,
    pulls,
    dispatches,
    requests,
    operations,
    objects,
    failures,
    dashboard: (path) => dashboard.fetch(`https://dev.tumpel.dev${path}`),
  };
};
