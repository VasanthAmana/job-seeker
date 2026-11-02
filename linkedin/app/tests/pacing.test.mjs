import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pacer, PaceCapError, HOUR_MS } = require("../src/pacing.js");

// Deterministic fake clock: sleep() advances it, random() is fixed.
function fakePacer(overrides = {}) {
  let t = 1_000_000;
  const sleeps = [];
  const pacer = new Pacer({
    minIntervalMs: 3000,
    jitterMs: 4000,
    maxLoadsPerHour: 3,
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    random: () => 0.5, // gap = 3000 + 2000 = 5000 ms
    ...overrides,
  });
  return { pacer, sleeps, tick: (ms) => (t += ms) };
}

test("first load runs immediately; later loads wait the human-like gap", async () => {
  const { pacer, sleeps } = fakePacer();
  await pacer.run(async () => "a");
  assert.deepEqual(sleeps, []);
  await pacer.run(async () => "b");
  assert.deepEqual(sleeps, [5000]);
});

test("the per-hour cap fails the call with a retry time (it never queues for an hour)", async () => {
  const { pacer, tick } = fakePacer();
  await pacer.run(async () => 1);
  tick(6000);
  await pacer.run(async () => 2);
  tick(6000);
  await pacer.run(async () => 3);
  tick(6000);
  await assert.rejects(pacer.run(async () => 4), (err) => {
    assert.ok(err instanceof PaceCapError);
    assert.equal(err.code, "PACE_CAP");
    assert.match(err.message, /pace cap/);
    assert.ok(err.retryAfterSec > 0 && err.retryAfterSec <= 3600);
    return true;
  });
});

test("cap frees up once the oldest load is more than an hour old", async () => {
  const { pacer, tick } = fakePacer();
  await pacer.run(async () => 1);
  tick(6000);
  await pacer.run(async () => 2);
  tick(6000);
  await pacer.run(async () => 3);
  tick(HOUR_MS); // all three loads age out
  const v = await pacer.run(async () => 4);
  assert.equal(v, 4);
});

test("loads are strictly serial: one request at a time, in order", async () => {
  const { pacer, tick } = fakePacer({ maxLoadsPerHour: 10 });
  const order = [];
  const slow = (name, ms) =>
    pacer.run(
      () =>
        new Promise((resolve) => {
          order.push("start:" + name);
          setTimeout(() => {
            order.push("end:" + name);
            resolve(name);
          }, ms);
        }),
    );
  tick(10000);
  const a = slow("a", 50);
  tick(10000);
  const b = slow("b", 10);
  tick(10000);
  const c = slow("c", 0);
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
});

test("a failed load does not wedge the queue", async () => {
  const { pacer, tick } = fakePacer();
  await assert.rejects(pacer.run(async () => Promise.reject(new Error("boom"))));
  tick(6000);
  const v = await pacer.run(async () => "recovered");
  assert.equal(v, "recovered");
});

test("billable:false tasks are serialised but free against the budget", async () => {
  const { pacer, sleeps } = fakePacer();
  await pacer.run(async () => "read", { billable: false });
  assert.deepEqual(sleeps, []);
  assert.equal(pacer.stats().loadsInLastHour, 0);
  await pacer.run(async () => "load");
  assert.equal(pacer.stats().loadsInLastHour, 1);
});

test("stats reports budget use", async () => {
  const { pacer } = fakePacer();
  await pacer.run(async () => 1);
  const stats = pacer.stats();
  assert.equal(stats.loadsInLastHour, 1);
  assert.equal(stats.maxLoadsPerHour, 3);
  assert.equal(stats.minIntervalMs, 3000);
});
