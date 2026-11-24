#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [command, operation, ...args] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
if (command === "api") {
  const all = [operation, ...args];
  const endpoint = all.find((arg) => arg.startsWith("repos/") || arg.startsWith("/repos/"));
  if (!endpoint) throw new Error(`Unexpected gh api arguments: ${all.join(" ")}`);
  const method = all.includes("--method") ? all[all.indexOf("--method") + 1] : "GET";
  const response = await fetch(new URL(endpoint, "https://api.github.com/"), {
    method,
    body: all.includes("--input") ? readFileSync(0) : undefined,
  });
  if (all.includes("--include")) console.log(`HTTP/2 ${response.status}\r\n\r`);
  const body = await response.text();
  if (body) console.log(body);
  if (!response.ok) {
    console.error(`GitHub returned ${response.status}`);
    process.exitCode = 1;
  }
} else if (command === "release" && operation === "create") {
  const [tag, ...files] = args.slice(0, args.indexOf("--target"));
  const assets = Object.fromEntries(files.map((file) => [basename(file), readFileSync(file).toString("base64")]));
  const response = await fetch(`https://api.github.com/repos/${repository}/releases`, {
    method: "POST",
    body: JSON.stringify({ tag, sha: args[args.indexOf("--target") + 1], assets }),
  });
  if (!response.ok) throw new Error(`GitHub release creation returned ${response.status}`);
} else if (command === "workflow" && operation === "run") {
  const [workflow, refOption, ref, inputOption, input] = args;
  if (refOption !== "--ref" || inputOption !== "-f") throw new Error(`Unexpected workflow arguments: ${args}`);
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref, inputs: Object.fromEntries([input.split("=")]) }),
  });
  if (!response.ok) throw new Error(`GitHub workflow dispatch returned ${response.status}`);
} else {
  throw new Error(`Unexpected gh command: ${process.argv.slice(2).join(" ")}`);
}
