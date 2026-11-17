import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "npm-scripts", "prebuild.mjs");
mkdirSync(join(ROOT, ".tmp"), { recursive: true });
const DIR = mkdtempSync(join(ROOT, ".tmp", "prebuild-test-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const fixture = (name, devcontainer) => {
  const root = join(DIR, name, "root");
  const workspace = join(root, "root", "workspace");
  write(
    join(root, "etc", "tumpel", "guest.json"),
    JSON.stringify({ environment: { PATH: "/usr/bin:/bin", HOME: join(root, "root"), LANG: "C.UTF-8" } }),
  );
  write(join(root, "etc", "base.txt"), "base\n");
  write(join(root, "usr", "lib", "keep"), "keep\n");
  write(join(root, "usr", "lib", "gone", "nested", "file"), "gone\n");
  write(join(root, "usr", "share", "doc", "nested", "file"), "doc\n");
  write(join(root, "tmp", "scratch"), "scratch\n");
  write(join(workspace, "package.json"), "{}\n");
  if (devcontainer !== null) write(join(workspace, ".devcontainer", "devcontainer.json"), devcontainer(root));
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", [
    "-C",
    workspace,
    "remote",
    "add",
    "origin",
    "https://x-access-token:s3cret@github.com/acme/app.git",
  ]);
  execFileSync("git", ["-C", workspace, "config", "includeIf.gitdir:/github/workspace/.git.path", "/runner/creds"]);
  return { root, out: join(DIR, name, "out") };
};

const RUNNER_ENV = { ...process.env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-secret" };

const prebuild = (root, out, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, "build", out], {
    env: { ...RUNNER_ENV, TUMPEL_PREBUILD_ROOT: root, ...env },
    encoding: "utf8",
    timeout: 20000,
  });

test("the layer holds the workspace, the changed base paths and a whiteout for each removed path", () => {
  const { root, out } = fixture(
    "build",
    (root) => `{
  // comments and trailing commas are JSON with comments
  "name": "fixture",
  "containerEnv": { "FIXTURE": "${root}", "PATH": "\${containerEnv:PATH}:/extra", },
  "onCreateCommand": "mkdir -p node_modules/a && echo 'on-create, ]' >> order && env > env.txt",
  "updateContentCommand": ["sh", "-c", "echo update-content >> order"],
  "postCreateCommand": {
    "tool": "mkdir -p $FIXTURE/usr/local/bin && echo tool > $FIXTURE/usr/local/bin/tool",
    "prune": ["sh", "-c", "rm -r $FIXTURE/usr/lib/gone $FIXTURE/tmp/scratch && echo post-create >> order"],
    "replace": "rm -r $FIXTURE/usr/share/doc && echo doc > $FIXTURE/usr/share/doc",
  },
}
`,
  );
  const result = prebuild(root, out);
  assert.equal(result.status, 0, result.stderr);
  const workspace = join(root, "root", "workspace");
  assert.equal(readFileSync(join(workspace, "order"), "utf8"), "on-create, ]\nupdate-content\npost-create\n");
  const env = readFileSync(join(workspace, "env.txt"), "utf8").split("\n");
  assert.ok(env.includes("PATH=/usr/bin:/bin:/extra"), env.join(", "));
  assert.ok(env.includes(`FIXTURE=${root}`), env.join(", "));
  assert.ok(!env.some((line) => line.startsWith("ACTIONS_ID_TOKEN_REQUEST_TOKEN=")), "the runner's token leaked");
  const layer = join(out, "layer.tar");
  const entries = execFileSync("tar", ["-tf", layer], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/, ""));
  for (const path of [
    "root/workspace",
    "root/workspace/package.json",
    "root/workspace/.devcontainer/devcontainer.json",
    "root/workspace/.git/HEAD",
    "root/workspace/node_modules/a",
    "root/workspace/order",
    "usr/local/bin/tool",
    "usr/lib/.wh.gone",
    "usr/share/doc",
  ])
    assert.ok(entries.includes(path), `${path} is missing from ${entries.join(", ")}`);
  for (const path of [
    "etc/base.txt",
    "usr/lib/keep",
    "usr/lib/gone/nested/.wh.file",
    "tmp/.wh.scratch",
    "usr/share/doc/.wh.nested",
    "usr/share/.wh.doc",
  ])
    assert.ok(!entries.includes(path), `${path} is in the layer`);
  const config = execFileSync("tar", ["-xOf", layer, "root/workspace/.git/config"], { encoding: "utf8" });
  assert.match(config, /url = https:\/\/github\.com\/acme\/app\.git/);
  assert.doesNotMatch(config, /s3cret|includeIf|creds/);
  const bytes = readFileSync(layer);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "layer.json"), "utf8")), {
    mediaType: "application/vnd.oci.image.layer.v1.tar",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  });
});

test("a repository without devcontainer.json runs npm ci for its npm lockfile and nothing else", () => {
  const { root, out } = fixture("default", null);
  const workspace = join(root, "root", "workspace");
  const bin = join(root, "usr", "local", "bin");
  write(join(bin, "npm"), `#!/bin/sh\necho "$@" >> ${join(workspace, "npm-args")}\n`);
  execFileSync("chmod", ["+x", join(bin, "npm")]);
  write(
    join(root, "etc", "tumpel", "guest.json"),
    JSON.stringify({ environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "root"), LANG: "C.UTF-8" } }),
  );
  write(join(workspace, "package-lock.json"), "{}\n");
  write(join(workspace, "npm-shrinkwrap.json"), "{}\n");
  write(join(workspace, "Cargo.toml"), "[package]\n");
  const result = prebuild(root, out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(workspace, "npm-args"), "utf8"), "ci\n");
  assert.match(result.stdout, /runs the default: {"onCreateCommand":"npm ci"}/);
});

test("a repository without devcontainer.json or an npm lockfile runs no command, and a failing npm ci names the default config's fix", () => {
  const bare = fixture("bare", null);
  const ran = prebuild(bare.root, bare.out);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /runs the default: {}/);
  const failing = fixture("failing", null);
  const workspace = join(failing.root, "root", "workspace");
  const bin = join(failing.root, "usr", "local", "bin");
  write(join(bin, "npm"), "#!/bin/sh\nexit 3\n");
  execFileSync("chmod", ["+x", join(bin, "npm")]);
  write(
    join(failing.root, "etc", "tumpel", "guest.json"),
    JSON.stringify({
      environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(failing.root, "root"), LANG: "C.UTF-8" },
    }),
  );
  write(join(workspace, "package-lock.json"), "{}\n");
  const result = prebuild(failing.root, failing.out);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /BuildFailed: onCreateCommand exited with 3; fix what it names in package\.json or the npm lockfile/,
  );
});

test("run in a box without guest.json takes the environment tumpel-guest starts it with", () => {
  const { root } = fixture("box", () => '{ "onCreateCommand": "env > env.txt" }\n');
  rmSync(join(root, "etc", "tumpel"), { recursive: true });
  const layerBin = "/opt/harness/claude-code/2.1.0/bin";
  const result = spawnSync(process.execPath, [SCRIPT, "run"], {
    env: {
      PATH: `${layerBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: join(root, "root"),
      LANG: "C.UTF-8",
      TUMPEL_PREBUILD_ROOT: root,
    },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  const env = readFileSync(join(root, "root", "workspace", "env.txt"), "utf8").split("\n");
  assert.ok(env.includes(`PATH=${layerBin}:${dirname(process.execPath)}:/usr/bin:/bin`), env.join(", "));
  assert.ok(!env.some((line) => line.startsWith("TUMPEL_PREBUILD_ROOT=")), env.join(", "));
});

test("features are refused with a named failure", () => {
  const { root, out } = fixture("features", () => '{ "features": { "ghcr.io/devcontainers/features/node:1": {} } }\n');
  const result = prebuild(root, out);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PrebuildFeaturesUnsupported/);
});

test("a symlinked workspace is refused as no checkout", () => {
  const { root, out } = fixture("symlink", () => '{ "onCreateCommand": "true" }\n');
  const workspace = join(root, "root", "workspace");
  const elsewhere = join(DIR, "symlink", "elsewhere");
  execFileSync("mv", [workspace, elsewhere]);
  symlinkSync(elsewhere, workspace);
  const result = prebuild(root, out);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NoCheckout/);
});

test("a command past the budget is killed with every process it started", () => {
  const { root, out } = fixture("budget", () => '{ "onCreateCommand": "sleep 60 & sleep 60" }\n');
  const result = prebuild(root, out, { TUMPEL_PREBUILD_SECONDS: "1" });
  assert.equal(result.error, undefined, "the background sleep held the output open");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /build budget/);
});

const uploadWith = async (name, env) => {
  const out = join(DIR, name);
  const layer = Buffer.from("layer bytes");
  const digest = createHash("sha256").update(layer).digest("hex");
  write(join(out, "layer.tar"), layer);
  write(join(out, "layer.json"), JSON.stringify({ sha256: digest, sizeBytes: layer.length }));
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, origin);
      seen.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/token") {
        assert.equal(request.headers.authorization, "bearer runner-secret");
        assert.equal(url.searchParams.get("audience"), origin);
        return response.end(JSON.stringify({ value: "job-token" }));
      }
      if (url.pathname === "/put") {
        assert.equal(request.headers["x-amz-checksum-sha256"], Buffer.from(digest, "hex").toString("base64"));
        assert.equal(request.headers["content-length"], String(layer.length));
        assert.deepEqual(body, layer);
        return response.end();
      }
      assert.equal(request.headers.authorization, "Bearer job-token");
      if (url.pathname === "/v1/prebuilds/p1/uploads") {
        assert.deepEqual(JSON.parse(body), { tenantId: "t1", layerDigest: digest, layerSizeBytes: layer.length });
        const expires = new Date(Date.now() + 60000).toISOString();
        return response.end(
          JSON.stringify({
            prebuildId: "p1",
            tenantId: "t1",
            sha256: digest,
            url: `${origin}/put`,
            uploadExpiresAt: expires,
          }),
        );
      }
      assert.deepEqual(JSON.parse(body), { tenantId: "t1" });
      response.end("{}");
    });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [SCRIPT, "upload", out, origin, "t1", "p1"], {
    env: env(origin),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((exited) => child.on("exit", exited));
  server.close();
  assert.equal(code, 0, stderr);
  return seen;
};

test("the upload exchanges the job token, puts the layer and completes the prebuild", async () => {
  const seen = await uploadWith("upload", (origin) => ({
    ...RUNNER_ENV,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
  }));
  assert.deepEqual(seen, [
    "GET /token",
    "POST /v1/prebuilds/p1/uploads",
    "PUT /put",
    "GET /token",
    "POST /v1/prebuilds/p1/uploads/complete",
  ]);
});

test("the upload presents TUMPEL_JOB_TOKEN when the orb sets it and requests no GitHub token", async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ACTIONS_ID_TOKEN")));
  const seen = await uploadWith("orb-upload", () => ({ ...env, TUMPEL_JOB_TOKEN: "job-token" }));
  assert.deepEqual(seen, ["POST /v1/prebuilds/p1/uploads", "PUT /put", "POST /v1/prebuilds/p1/uploads/complete"]);
});
