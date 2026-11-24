#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [command, operation, ...args] = process.argv.slice(2);
const repo = `repos/${process.env.GITHUB_REPOSITORY}`;
let [endpoint, body] = [operation, undefined];
if (basename(process.argv[1]).startsWith("wrangler")) {
  [endpoint, body] = ["wrangler", { cwd: process.cwd(), args: [command, operation, ...args] }];
} else if (command === "release" && operation === "create") {
  const target = args.indexOf("--target");
  const files = args.slice(1, target).map((file) => [basename(file), readFileSync(file).toString("base64")]);
  [endpoint, body] = [`${repo}/releases`, { tag: args[0], sha: args[target + 1], files }];
} else if (command === "release" && operation === "view") {
  endpoint = `${repo}/releases/tags/${args[0]}`;
} else if (command === "workflow" && operation === "run") {
  [endpoint, body] = [`${repo}/dispatches`, { workflow: args[0], ref: args[2] }];
} else if (command === "api" && [operation, ...args].includes("--input")) {
  endpoint = [operation, ...args].find((arg) => arg.startsWith("/repos/") || arg.startsWith("repos/"));
  body = JSON.parse(readFileSync(0, "utf8"));
}
const response = await fetch(new URL(endpoint, "https://api.github.com/"), {
  method: body === undefined ? "GET" : "POST",
  body: JSON.stringify(body),
});
if (!response.ok)
  throw new Error(`GitHub ${command} ${operation} returned ${response.status}: ${await response.text()}`);
console.log(await response.text());
