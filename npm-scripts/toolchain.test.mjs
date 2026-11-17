import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("rust-toolchain.toml pins the Rust version the guest image installs", () => {
  const image = read("npm-scripts/guest-image.mjs").match(/const RUST_VERSION = "([^"]+)"/)?.[1];
  const pinned = read("rust-toolchain.toml").match(/channel = "([^"]+)"/)?.[1];
  assert.ok(image, "guest-image.mjs defines no RUST_VERSION");
  assert.equal(pinned, image, `set channel in rust-toolchain.toml to ${image}, the version guest-image.mjs installs`);
  assert.match(read("rust-toolchain.toml"), /components = \["clippy", "rustfmt"\]/);
});
