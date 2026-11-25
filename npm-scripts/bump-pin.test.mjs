import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { bumpPin } from "./bump-pin.mjs";

const token = "test-installation-token";
const sha = (number) => number.toString(16).padStart(40, "0");
const candidate = (number) => ({ release: `rc.${number}`, commit: sha(number) });
const subject = (name, number) => `chore(pins): deploy ${name} rc.${number} to dev`;
const blob = (pin) => createHash("sha1").update(JSON.stringify(pin)).digest("hex");

const githubFixture = () => {
  const pins = { "control-plane": candidate(9), dashboard: { release: "v0.10.0", commit: sha(1) } };
  const history = { "control-plane": [], dashboard: [] };
  const writes = [];
  const requests = [];
  const fixture = { pins, history, writes, requests, hasChecksum: true, beforeWrite: undefined };
  const github = async (url, { method = "GET", headers, body }) => {
    const { pathname: path, searchParams: query } = new URL(url);
    requests.push([method, path, query.get("path")]);
    if (!path.startsWith("/repos/tumpel/deploy/")) {
      assert.equal(method, "GET");
      assert.equal(headers.authorization, undefined);
      const [, name, endpoint, tag] =
        /^\/repos\/tumpel\/([^/]+)\/(releases\/tags|commits)\/(?:refs%2Ftags%2F)?(rc\.\d+)$/.exec(path);
      if (endpoint === "commits") {
        assert.match(path, /refs%2Ftags%2F/);
        return Response.json({ sha: sha(Number(tag.slice(3))) });
      }
      const artifact = name === "dashboard" ? "dashboard-0.10.0.tgz" : `control-plane-${tag}.tgz`;
      const names = fixture.hasChecksum ? [artifact, `${artifact}.sha256`] : [artifact];
      return Response.json({
        draft: false,
        published_at: "2026-11-25T00:00:00Z",
        tag_name: tag,
        assets: names.map((name) => ({ name, state: "uploaded" })),
      });
    }
    assert.equal(headers.authorization, `Bearer ${token}`);
    if (path === "/repos/tumpel/deploy/commits") {
      assert.equal(method, "GET");
      assert.equal(query.get("sha"), "main");
      assert.equal(query.get("per_page"), "100");
      const [, name] = /^pins\/(control-plane|dashboard)\.json$/.exec(query.get("path"));
      return Response.json(history[name].map((message) => ({ commit: { message } })));
    }
    const [, name] = /^\/repos\/tumpel\/deploy\/contents\/pins\/(control-plane|dashboard)\.json$/.exec(path);
    const pin = pins[name];
    if (method === "GET") {
      assert.equal(query.get("ref"), "main");
      return Response.json({ sha: blob(pin), content: Buffer.from(JSON.stringify(pin)).toString("base64") });
    }
    assert.equal(method, "PUT");
    const change = JSON.parse(body);
    assert.equal(change.branch, "main");
    const status = await fixture.beforeWrite?.(name);
    if (status) return new Response(null, { status });
    if (change.sha !== blob(pins[name])) return new Response(null, { status: 409 });
    pins[name] = JSON.parse(Buffer.from(change.content, "base64").toString("utf8"));
    history[name].unshift(change.message);
    writes.push(change.message);
    return new Response(null, { status: 200 });
  };
  fixture.bump = (packageName, number) =>
    bumpPin({ packageName, tag: `rc.${number}`, commit: sha(number), token }, github);
  return fixture;
};

test("control-plane candidates 10 and 11 leave the pin on 11 in either finish order", async () => {
  for (const order of [
    [10, 11],
    [11, 10],
  ]) {
    const { bump, pins, writes } = githubFixture();
    for (const number of order) await bump("control-plane", number);
    assert.deepEqual(pins["control-plane"], candidate(11));
    assert.deepEqual(
      writes,
      order[0] === 10 ? [subject("control-plane", 10), subject("control-plane", 11)] : [subject("control-plane", 11)],
    );
  }
});

test("a revert from 11 to 10 survives reruns of both candidates", async () => {
  const { bump, pins, history, writes } = githubFixture();
  await bump("control-plane", 10);
  await bump("control-plane", 11);
  pins["control-plane"] = candidate(10);
  history["control-plane"].unshift(`Revert "${subject("control-plane", 11)}"\n\nRestore the previous pin.`);

  await bump("control-plane", 11);
  await bump("control-plane", 10);
  assert.deepEqual(pins["control-plane"], candidate(10));
  assert.deepEqual(writes, [subject("control-plane", 10), subject("control-plane", 11)]);
});

test("a rerun after a failed write applies the bump once", async () => {
  const github = githubFixture();
  github.beforeWrite = () => 500;
  await assert.rejects(github.bump("control-plane", 10), /could not update pins\/control-plane\.json \(500\)/);
  assert.deepEqual(github.pins["control-plane"], candidate(9));
  assert.deepEqual(github.writes, []);

  github.beforeWrite = undefined;
  await github.bump("control-plane", 10);
  await github.bump("control-plane", 10);
  assert.deepEqual(github.pins["control-plane"], candidate(10));
  assert.deepEqual(github.writes, [subject("control-plane", 10)]);
});

test("a concurrent dashboard bump makes the control-plane bump reread and both land", async () => {
  const github = githubFixture();
  github.beforeWrite = async (name) => {
    assert.equal(name, "control-plane");
    github.beforeWrite = undefined;
    await github.bump("dashboard", 11);
    return 409;
  };
  await github.bump("control-plane", 10);

  assert.deepEqual(github.pins, { "control-plane": candidate(10), dashboard: candidate(11) });
  assert.deepEqual(github.writes, [subject("dashboard", 11), subject("control-plane", 10)]);
  assert.deepEqual(
    github.requests
      .filter(([, path, file]) => path.endsWith("/pins/control-plane.json") || file === "pins/control-plane.json")
      .map(([method]) => method),
    ["GET", "GET", "PUT", "GET", "GET", "PUT"],
  );
});

test("a release without its checksum fails before deploy is contacted", async () => {
  const github = githubFixture();
  github.hasChecksum = false;
  await assert.rejects(github.bump("dashboard", 10), /needs its artifact and matching \.sha256 asset/);
  assert.ok(github.requests.every(([, path]) => !path.startsWith("/repos/tumpel/deploy/")));
});
