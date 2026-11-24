#!/usr/bin/env node
const response = await fetch("https://api.cloudflare.com/scenario/wrangler", {
  method: "POST",
  body: JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }),
});
if (!response.ok) throw new Error(`Wrangler command failed: ${await response.text()}`);
