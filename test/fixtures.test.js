import test from "node:test"
import assert from "node:assert/strict"
import { BUILD_FIXTURE, PLANNING_FIXTURE } from "../src/fixtures.js"

test("planning fixture scores diagnosis and fix", () => {
  const good =
    '{"file":"src/cart.js","line":3,"bug":"Loop starts at index 1 and skips the first item","fix":"Use i = 0"}'
  const bad = "The code looks fine."
  assert.equal(PLANNING_FIXTURE.score(good), 1)
  assert.equal(PLANNING_FIXTURE.score(bad), 0)
})

test("planning fixture requires JSON in the answer", () => {
  assert.equal(PLANNING_FIXTURE.score("Loop starts at 1 and skips the first item; use i = 0"), 0.9)
})

test("build fixture rewards visible and hidden test success", () => {
  assert.equal(BUILD_FIXTURE.score({ visiblePass: true, hiddenPass: true }), 1)
  assert.equal(BUILD_FIXTURE.score({ visiblePass: true, hiddenPass: false }), 0.2)
  assert.equal(BUILD_FIXTURE.score({ visiblePass: false, hiddenPass: false }), 0)
})
