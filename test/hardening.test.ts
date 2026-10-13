import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AosError } from "../src/errors.ts";
import { describeTuning, sandboxTuning } from "../src/hardening.ts";

describe("sandboxTuning", () => {
  test("defaults to an empty tuning", () => {
    assert.deepEqual(sandboxTuning({}), {});
    assert.equal(describeTuning(sandboxTuning({})), undefined);
  });

  test("passes a single network and several comma-separated networks through", () => {
    assert.deepEqual(sandboxTuning({ AOS_NETWORK: "isolated" }), { network: "isolated" });
    assert.deepEqual(sandboxTuning({ AOS_NETWORK: "a, b" }), { network: ["a", "b"] });
  });

  test("accepts a positive CPU limit and rejects the rest", () => {
    assert.deepEqual(sandboxTuning({ AOS_CPUS: "2" }), { cpus: 2 });
    assert.deepEqual(sandboxTuning({ AOS_CPUS: "1.5" }), { cpus: 1.5 });
    for (const bad of ["0", "-1", "many"]) assert.throws(() => sandboxTuning({ AOS_CPUS: bad }), AosError);
  });

  test("summarises tuning for doctor", () => {
    assert.equal(describeTuning({ network: "isolated", cpus: 2 }), "network isolated; cpus 2");
  });
});
