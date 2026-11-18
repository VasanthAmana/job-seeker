"use strict";
// Gentle-by-design pacing. This is a personal assistant on the user's own
// LinkedIn account, not a scraper, so:
//   1. ONE request at a time  - every page load runs through a serial queue.
//   2. Human-like pacing     - a random 3-7 s gap (defaults) between loads.
//   3. A per-hour cap        - at most `maxLoadsPerHour` page loads/hour; when
//                              the cap is hit the call FAILS (it does not
//                              queue for an hour) saying when to retry.
// The clock, sleeper and RNG are injectable so tests are deterministic.

class PaceCapError extends Error {
  constructor(retryAfterSec, maxLoadsPerHour) {
    super(
      `pace cap reached: ${maxLoadsPerHour} page loads in the last hour. ` +
        `Try again in ~${retryAfterSec}s. This assistant is deliberately gentle on your account.`,
    );
    this.name = "PaceCapError";
    this.code = "PACE_CAP";
    this.retryAfterSec = retryAfterSec;
  }
}

const HOUR_MS = 3600_000;

class Pacer {
  constructor({
    minIntervalMs = 3000,
    jitterMs = 4000,
    maxLoadsPerHour = 40,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = () => Math.random(),
  } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.jitterMs = jitterMs;
    this.maxLoadsPerHour = maxLoadsPerHour;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.loads = []; // timestamps of page loads, ascending
    this.chain = Promise.resolve();
  }

  stats() {
    this.#purge();
    return {
      loadsInLastHour: this.loads.length,
      maxLoadsPerHour: this.maxLoadsPerHour,
      minIntervalMs: this.minIntervalMs,
      jitterMs: this.jitterMs,
    };
  }

  #purge() {
    const cutoff = this.now() - HOUR_MS;
    while (this.loads.length > 0 && this.loads[0] <= cutoff) this.loads.shift();
  }

  // Run `task` through the serial queue. With billable=true (default) the task
  // is a page load: the per-hour cap applies and the inter-load gap is
  // enforced before it starts. billable=false tasks (in-page reads after a
  // load) are only serialised.
  run(task, { billable = true } = {}) {
    const result = this.chain.then(() => this.#gated(task, billable));
    // Keep the chain alive after a failure: the next call must not inherit a
    // rejection.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #gated(task, billable) {
    if (billable) {
      this.#purge();
      if (this.loads.length >= this.maxLoadsPerHour) {
        const oldest = this.loads[0];
        const retryAfterSec = Math.max(1, Math.ceil((oldest + HOUR_MS - this.now()) / 1000));
        throw new PaceCapError(retryAfterSec, this.maxLoadsPerHour);
      }
      const last = this.loads[this.loads.length - 1];
      if (last !== undefined) {
        const gap = this.minIntervalMs + Math.round(this.random() * this.jitterMs);
        const waitMs = last + gap - this.now();
        if (waitMs > 0) await this.sleep(waitMs);
      }
      this.loads.push(this.now());
    }
    return task();
  }
}

module.exports = { Pacer, PaceCapError, HOUR_MS };
