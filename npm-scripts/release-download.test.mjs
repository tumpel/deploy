import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedPins, supervisorRefusal } from "./release-download.mjs";

const CHANNEL = { Oldest: 18, Version: 19 };
const GUEST = { Oldest: 9, Version: 11 };
const RELEASE = {
  supervisorVersion: "0.1.0",
  channelProtocolOldest: 19,
  channelProtocolVersion: 19,
  guestProtocolOldest: 9,
  guestProtocolVersion: 11,
};

test("a pinned supervisor publishes while its channel and guest windows meet this commit's and the images'", () => {
  assert.equal(supervisorRefusal(RELEASE, CHANNEL, GUEST, 11), undefined);
  assert.equal(
    supervisorRefusal({ ...RELEASE, channelProtocolOldest: 19, channelProtocolVersion: 20 }, CHANNEL, GUEST, 9),
    undefined,
  );
  assert.equal(
    supervisorRefusal({ ...RELEASE, channelProtocolOldest: 17, channelProtocolVersion: 18 }, CHANNEL, GUEST, 9),
    undefined,
  );
});

test("a pinned supervisor whose window misses this commit's or the images' guest protocol is refused", () => {
  assert.match(
    supervisorRefusal({ ...RELEASE, channelProtocolOldest: 20, channelProtocolVersion: 20 }, CHANNEL, GUEST, 11),
    /supervisor 0\.1\.0 speaks channel protocol 20 to 20, and this commit accepts 18 to 19/,
  );
  assert.match(
    supervisorRefusal({ ...RELEASE, channelProtocolOldest: 16, channelProtocolVersion: 17 }, CHANNEL, GUEST, 11),
    /channel protocol 16 to 17/,
  );
  assert.match(
    supervisorRefusal({ ...RELEASE, guestProtocolOldest: 12, guestProtocolVersion: 12 }, CHANNEL, GUEST, 11),
    /speaks guest protocol 12 to 12, and this commit speaks 9 to 11/,
  );
  assert.match(
    supervisorRefusal({ ...RELEASE, guestProtocolOldest: 10 }, CHANNEL, GUEST, 9),
    /speaks guest protocol 10 to 11, and the guests of the image release speak 9/,
  );
});

test("stage dev runs a supervisor dev build, and every stage runs a stable supervisor", () => {
  assert.deepEqual(checkedPins({ supervisor: "0.1.22-main.3", cli: "0.4.0" }, "dev"), {
    supervisor: "0.1.22-main.3",
    cli: "0.4.0",
  });
  assert.deepEqual(checkedPins({ supervisor: "0.1.22", cli: "0.4.0" }, "prod"), { supervisor: "0.1.22", cli: "0.4.0" });
});

test("a supervisor dev build pinned outside stage dev, or any other version, is refused", () => {
  assert.throws(
    () => checkedPins({ supervisor: "0.1.22-main.3", cli: "0.4.0" }, "prod"),
    /dev build 0\.1\.22-main\.3, and only stage dev runs dev builds; pin a stable X\.Y\.Z for prod/,
  );
  assert.throws(
    () => checkedPins({ supervisor: "0.1.22-rc.1", cli: "0.4.0" }, "dev"),
    /not X\.Y\.Z or X\.Y\.Z-main\.N/,
  );
  assert.throws(
    () => checkedPins({ supervisor: "0.1.22", cli: "0.4.0-main.1" }, "dev"),
    /cli 0\.4\.0-main\.1, not X\.Y\.Z/,
  );
});
