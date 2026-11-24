import assert from "node:assert/strict";
import { test } from "node:test";
import { supervisorRolloutAllowed } from "./supervisor-rollout.mjs";

test("a supervisor pin change fails without the approval label", () => {
  assert.equal(supervisorRolloutAllowed({ supervisor: "1.0.0" }, { supervisor: "1.1.0" }, [{ name: "pins" }]), false);
});

test("a supervisor pin change passes with the approval label", () => {
  assert.equal(
    supervisorRolloutAllowed({ supervisor: "1.0.0" }, { supervisor: "1.1.0" }, [
      { name: "supervisor-rollout-approved" },
    ]),
    true,
  );
});

test("other pin changes pass without the approval label", () => {
  assert.equal(
    supervisorRolloutAllowed({ supervisor: "1.0.0", cli: "2.0.0" }, { supervisor: "1.0.0", cli: "2.1.0" }, []),
    true,
  );
});

test("unchanged pins pass without the approval label", () => {
  assert.equal(
    supervisorRolloutAllowed({ supervisor: "1.0.0", cli: "2.0.0" }, { supervisor: "1.0.0", cli: "2.0.0" }, []),
    true,
  );
});
