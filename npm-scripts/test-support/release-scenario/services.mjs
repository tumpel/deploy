import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { buffer } from "node:stream/consumers";
import { createTestHarness } from "wrangler";
import { hash } from "../../rollout.mjs";

export const serve = async (t, git, dir) => {
  const cloud = {
    assets: new Map(),
    releases: new Map(),
    objects: new Map(),
    overrides: new Map(),
    dispatches: [],
    pulls: [],
    operations: [],
  };
  const runs = new Map();
  let worker, active;
  const check = (repo, sha, conclusion) => {
    const list = runs.get(repo) ?? [];
    const status = conclusion === "pending" ? "in_progress" : "completed";
    const run = { id: list.length + 1, head_sha: sha, head_branch: "main", event: "push", status, conclusion };
    runs.set(repo, [{ ...run, name: "checks" }, ...list]);
  };
  const publish = (repo, tag, files) => {
    const assets = files.map(([name, bytes]) => {
      const url = `https://github.com/tumpel/${repo}/releases/download/${tag}/${name}`;
      cloud.assets.set(url, bytes);
      return { name, url, browser_download_url: url, state: "uploaded" };
    });
    const release = { tag_name: tag, draft: false, published_at: "2026-01-01", assets };
    cloud.releases.set(`${repo}/${tag}`, release);
    return release;
  };
  const serveDashboard = (path) => worker.fetch(new URL(path, "https://dev.tumpel.dev"));
  const wrangler = async ({ cwd, args }) => {
    const [command, operation] = args;
    cloud.operations.push(`${command}:${command === "deploy" ? cwd.split("/").at(-1) : operation}`);
    if (command === "d1") return;
    assert.equal(command, "deploy");
    const pin = args.find((arg) => arg.startsWith("DEPLOYED_COMMIT:"));
    if (pin) {
      active = pin.split(":")[1];
      return;
    }
    const config = JSON.parse(readFileSync(join(cwd, "wrangler.jsonc")));
    config.main = resolve(cwd, config.main);
    config.assets.directory = resolve(cwd, config.assets.directory);
    config.vars = { API_ORIGIN: args.find((arg) => arg.startsWith("API_ORIGIN:")).slice(11) };
    await worker?.close();
    worker = createTestHarness({ workers: [{ config }] });
    await worker.listen();
  };
  const github = async ({ pathname, searchParams }, method, input) => {
    if (pathname === "/wrangler") return (await wrangler(input)) ?? null;
    if (pathname === "/graphql") {
      const pull = cloud.pulls.find((pr) => pr.node_id === input.variables.pull);
      pull.auto_merge = { merge_method: "squash" };
      return { data: {} };
    }
    const [, repo, path] = /^\/repos\/tumpel\/([^/]+)\/(.+)$/.exec(pathname);
    const ref = (...args) => git(join(dir, `${repo}.git`), ...args);
    if (path.endsWith("/runs")) {
      const sha = searchParams.get("head_sha");
      const workflow_runs = (runs.get(repo) ?? []).filter((r) =>
        sha ? r.head_sha === sha : r.conclusion === "success",
      );
      return { workflow_runs };
    }
    if (path.startsWith("commits/")) return { sha: ref("rev-parse", path.slice(8)) };
    if (path.startsWith("contents/")) {
      const file = ref("show", `${searchParams.get("ref")}:${path.slice(9)}`);
      return { content: Buffer.from(file).toString("base64") };
    }
    if (path.startsWith("compare/")) {
      const [base, head] = path.slice(8).split("...");
      return { status: base === head ? "identical" : ref("merge-base", base, head) === base ? "ahead" : "diverged" };
    }
    if (path === "releases" && method === "POST") {
      ref("tag", input.tag, input.sha);
      const files = input.files.map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]);
      return publish(repo, input.tag, files);
    }
    if (path === "releases") return [...cloud.releases.values()].filter((r) => r.assets[0].url.includes(`/${repo}/`));
    if (path.startsWith("releases/tags/")) return cloud.releases.get(`${repo}/${path.slice(14)}`);
    if (path === "dispatches") return cloud.dispatches.push(input);
    assert.equal(path, "pulls");
    if (method === "GET") return cloud.pulls;
    cloud.pulls.push({ ...input, node_id: "pull-1", number: 1 });
    return cloud.pulls.at(-1);
  };
  const route = async (url, method, body) => {
    const injected = cloud.overrides.get(`${method} ${url.hostname}${url.pathname}`);
    if (injected) return injected(body);
    if (cloud.assets.has(url.href)) return new Response(cloud.assets.get(url.href));
    if (url.hostname === "api.github.com")
      return Response.json(await github(url, method, body.length && JSON.parse(body)));
    if (url.hostname === "dev.tumpel.dev") return serveDashboard(url.pathname);
    if (url.hostname === "api.dev.tumpel.dev") {
      const manifest = cloud.objects.get("tumpel-releases-dev/current.json");
      const [, , , kind, arch] = url.pathname.split("/");
      if (kind === "current") return new Response(manifest);
      const asset = JSON.parse(manifest)[`${kind}s`].find((entry) => entry.architecture === arch);
      return new Response(cloud.assets.get(asset.downloadUrl));
    }
    if (url.pathname.endsWith("/query"))
      return Response.json({ success: true, result: [{ success: true, results: [] }] });
    const object = /\/buckets\/([^/]+)\/objects\/(.*)/.exec(url.pathname);
    if (object || url.hostname.endsWith(".r2.cloudflarestorage.com")) {
      const key = decodeURIComponent(object ? `${object[1]}/${object[2]}` : url.pathname.slice(1));
      if (method === "PUT") cloud.objects.set(key, body);
      const data = cloud.objects.get(key);
      return data ? new Response(data, { headers: { etag: `"${hash(data)}"` } }) : new Response(null, { status: 404 });
    }
    assert.ok(url.pathname.endsWith("/settings"), `Unexpected ${method} ${url}`);
    const bindings = [{ name: "DEPLOYED_COMMIT", type: "plain_text", text: active }];
    return Response.json({ success: true, result: { bindings } });
  };
  const server = createServer(async (request, reply) => {
    try {
      const target = new URL(request.url, "http://localhost").searchParams.get("target");
      const res = await route(new URL(target), request.method, await buffer(request));
      reply.writeHead(res.status, Object.fromEntries(res.headers)).end(Buffer.from(await res.arrayBuffer()));
    } catch (error) {
      reply.writeHead(500).end(error.message);
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => Promise.all([new Promise((done) => server.close(done)), worker?.close()]));
  return Object.assign(cloud, { url: `http://127.0.0.1:${server.address().port}`, check, publish, serveDashboard });
};
