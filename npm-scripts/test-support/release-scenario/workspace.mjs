import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./sources.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const support = fileURLToPath(new URL(".", import.meta.url));
const dependencies = join(root, "node_modules");

export const write = (file, content) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

export const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export const workspace = (dir, services, sources) => {
  const bin = join(dir, "bin");
  const scratch = join(dir, "scratch");
  mkdirSync(bin);
  mkdirSync(scratch);
  symlinkSync(join(support, "gh.mjs"), join(bin, "gh"));
  const sleeps = join(dir, "sleeps");
  write(sleeps, "");
  const now = 1_800_000_000_000;
  const env = {
    PATH: [bin, sources.bin, join(dependencies, ".bin"), process.env.PATH].join(":"),
    TMPDIR: scratch,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Release Scenario",
    GIT_AUTHOR_EMAIL: "release@example.test",
    GIT_COMMITTER_NAME: "Release Scenario",
    GIT_COMMITTER_EMAIL: "release@example.test",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_fetch_retries: "0",
    npm_config_cache: join(dir, "npm-cache"),
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: join(dir, "npmrc-global"),
    NODE_OPTIONS: `--import=${join(support, "network.mjs")}`,
    RELEASE_SCENARIO_URL: services.url,
    RELEASE_SCENARIO_TIME: String(now),
    RELEASE_SCENARIO_SLEEPS: sleeps,
  };

  const run = (cwd, command, args, extraEnv) =>
    execute(command, args, { cwd, env: { ...env, ...extraEnv }, timeout: 60_000 });
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 }).trim();

  const repository = (name) => {
    const worktree = join(dir, name);
    const remote = join(dir, `${name}.git`);
    git(dir, "init", "--quiet", "--initial-branch=main", worktree);
    git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    git(worktree, "remote", "add", "origin", remote);
    git(worktree, "config", "core.hooksPath", "/dev/null");
    services.repositories.set(`tumpel/${name}`, remote);
    return { worktree, remote };
  };
  const lock = (cwd) => run(cwd, "npm", ["install", "--package-lock-only", "--ignore-scripts"]);
  const commit = (cwd, message) => {
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const scripts = (cwd, args, extraEnv) => run(cwd, process.execPath, args, extraEnv);
  const deployScript = (cwd, script, args, extraEnv) =>
    scripts(cwd, ["--import", join(support, "clock.mjs"), `npm-scripts/${script}.mjs`, ...args], {
      GITHUB_REPOSITORY: "tumpel/deploy",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      TUMPEL_ACCOUNT_ID: "test-account",
      CLOUDFLARE_TOFU_TOKEN: "test-value",
      R2_RELEASES_ACCESS_KEY_ID: "test-value",
      R2_RELEASES_SECRET_ACCESS_KEY: "test-value",
      ...extraEnv,
    });
  return { dir, env, now, sleeps, run, git, repository, lock, commit, scripts, deployScript };
};

export const dashboardCheckout = async (workspace, source, services, asset) => {
  const { worktree, remote } = workspace.repository("dashboard");
  const npmScripts = join(worktree, "npm-scripts");
  mkdirSync(npmScripts);
  for (const name of ["release-plan", "release", "pack", "pack-check"])
    cpSync(join(source, "npm-scripts", `${name}.mjs`), join(npmScripts, `${name}.mjs`));
  const publish = readJson(join(source, "package.json")).scripts;
  writeJson(join(worktree, "package.json"), {
    name: "scenario-dashboard",
    private: true,
    type: "module",
    workspaces: ["packages/*"],
    scripts: { build: publish.build, pack: publish.pack, "pack:check": publish["pack:check"] },
  });
  write(join(worktree, ".gitignore"), "node_modules/\ndist/\nrelease/\n.tmp/\n");
  const packageDir = join(worktree, "packages", "dashboard");
  const version = "0.10.0";
  writeJson(join(packageDir, "package.json"), {
    name: "@tumpel/dashboard",
    version,
    files: ["dist"],
    scripts: {
      build:
        "mkdir -p dist/fonts && cp index.html release.js dist/ && cp font.woff2 dist/fonts/inter-latin-wght-normal.woff2",
    },
  });
  write(join(packageDir, "index.html"), '<!doctype html><head></head><script src="/release.js"></script>');
  write(join(packageDir, "font.woff2"), "fixture font bytes");
  const sourceAsset = join(packageDir, "release.js");
  write(sourceAsset, asset);
  const pages = join(worktree, "packages", "pages");
  cpSync(join(source, "packages", "pages"), pages, { recursive: true });
  const { devDependencies, ...pagesManifest } = readJson(join(pages, "package.json"));
  writeJson(join(pages, "package.json"), { ...pagesManifest, version });
  await workspace.lock(worktree);
  symlinkSync(dependencies, join(worktree, "node_modules"), "dir");

  const sha = workspace.commit(worktree, "feat: publish dashboard A");
  const tag = `v${version}`;
  workspace.git(worktree, "tag", tag);
  workspace.git(worktree, "push", "--quiet", "origin", "main", tag);
  await workspace.run(worktree, "npm", ["run", "pack"]);
  const releaseDir = join(worktree, "release");
  services.publish(
    "tumpel/dashboard",
    tag,
    Object.fromEntries(readdirSync(releaseDir).map((name) => [name, readFileSync(join(releaseDir, name))])),
  );
  services.check("tumpel/dashboard", sha, "success");
  return { worktree, remote, sourceAsset, sha, version };
};

export const controlPlaneCheckout = async (workspace, sources, dashboardVersion, services) => {
  const { worktree, remote } = workspace.repository("control-plane");
  const wrangler = join(worktree, "packages", "scenario-wrangler");
  writeJson(join(wrangler, "package.json"), {
    name: "wrangler",
    version: "1.0.0",
    type: "module",
    bin: { wrangler: "./wrangler.mjs" },
  });
  cpSync(join(support, "wrangler.mjs"), join(wrangler, "wrangler.mjs"));
  writeJson(join(worktree, "package.json"), {
    name: "scenario-control-plane",
    private: true,
    type: "module",
    workspaces: ["packages/*"],
    dependencies: { wrangler: "1.0.0" },
  });
  write(join(worktree, ".gitignore"), "node_modules/\n");
  const scripts = join(worktree, "npm-scripts");
  mkdirSync(scripts);
  for (const name of ["update-dashboard", "dashboard-bot", "dashboard-release", "release-github", "dispatch-deploy"])
    cpSync(join(sources, "npm-scripts", `${name}.mjs`), join(scripts, `${name}.mjs`));

  for (const [packageName, name] of [
    ["control-plane", "pages"],
    ["dashboard-site", "dashboard"],
  ]) {
    const directory = join(worktree, "packages", packageName);
    const dependency = `https://github.com/tumpel/dashboard/releases/download/v${dashboardVersion}/${name}-${dashboardVersion}.tgz`;
    writeJson(join(directory, "package.json"), {
      name: `@tumpel/${packageName}`,
      version: "1.0.0",
      type: "module",
      dependencies: { [`@tumpel/${name}`]: dependency },
    });
  }
  const cp = join(worktree, "packages", "control-plane");
  writeJson(join(cp, "wrangler.jsonc"), { d1_databases: [{ database_id: "00000000-0000-0000-0000-000000000000" }] });
  const site = join(worktree, "packages", "dashboard-site");
  for (const file of ["worker.ts", "wrangler.jsonc"])
    cpSync(join(sources, "packages", "dashboard-site", file), join(site, file));

  await workspace.lock(worktree);
  const sha = workspace.commit(worktree, "chore: pin dashboard A");
  workspace.git(worktree, "push", "--quiet", "origin", "main");
  services.check("tumpel/control-plane", sha, "success");
  workspace.env.GIT_CONFIG_COUNT = "1";
  workspace.env.GIT_CONFIG_KEY_0 = `url.${remote}.insteadOf`;
  workspace.env.GIT_CONFIG_VALUE_0 = "https://github.com/tumpel/control-plane.git";
  return { worktree, remote, sha };
};

export const deployCheckout = (workspace, pins) => {
  const { worktree, remote } = workspace.repository("deploy");
  cpSync(join(root, "npm-scripts"), join(worktree, "npm-scripts"), { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) cpSync(join(root, name), join(worktree, name));
  write(join(worktree, ".gitignore"), "node_modules/\n.tmp/\n");
  symlinkSync(dependencies, join(worktree, "node_modules"), "dir");
  writeJson(join(worktree, "release-pins.json"), pins);
  const sha = workspace.commit(worktree, "chore: deploy dashboard A");
  workspace.git(worktree, "tag", "v1.0.0");
  workspace.git(worktree, "push", "--quiet", "origin", "main", "v1.0.0");
  return { worktree, remote, sha };
};
