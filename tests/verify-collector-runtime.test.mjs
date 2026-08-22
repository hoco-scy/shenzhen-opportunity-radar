import test from "node:test";
import assert from "node:assert/strict";
import { inspectCollectorRuntime } from "../scripts/verify-collector-runtime.mjs";

test("all script-labelled sources have a stateless runnable collector contract", async () => {
  const runtime = await inspectCollectorRuntime();
  assert.equal(runtime.readyForOfflineContractTest, true);
  assert.equal(runtime.collectors.length, 1);
  assert.deepEqual(runtime.collectors.map((item) => item.sourceId), ["chinatelecom-careers"]);
  assert.equal(runtime.collectors[0].scriptPresent, true);
  assert.match(runtime.collectors[0].hardGuard, /筛选/);
});
