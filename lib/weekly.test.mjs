import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "./weekly.mjs";
test("reports total minutes across completed work", () => {
  assert.deepEqual(summarize([{minutes:25}, {minutes:35}]), {count:2, minutes:60});
});
test("an empty week has zero minutes", () => {
  assert.deepEqual(summarize([]), {count:0, minutes:0});
});
