import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.ts";

test("a request on the legacy app host answers 308 to the dashboard host with its path and query", () => {
  const response = worker.fetch(new Request("https://app.dev.tumpel.dev/x?y=1"));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://dev.tumpel.dev/x?y=1");
});
