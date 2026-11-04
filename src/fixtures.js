export const PLANNING_FIXTURE = {
  name: "planning-off-by-one",
  files: {
    "package.json": JSON.stringify(
      {
        name: "free-bench-planning",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "src/cart.js": `export function total(items) {
  let sum = 0
  for (let i = 1; i < items.length; i += 1) {
    sum += items[i].price
  }
  return sum
}
`,
    "test/cart.test.js": `import test from "node:test"
import assert from "node:assert/strict"
import { total } from "../src/cart.js"

test("totals every line item", () => {
  assert.equal(total([{ price: 10 }, { price: 20 }]), 30)
})
`,
  },
  prompt: `You are evaluating a repository. Do not modify any file.

Read src/cart.js and test/cart.test.js using the available tools, then diagnose the failing test.

Reply with only one JSON object and no markdown:
{"file":"src/cart.js","line":<line number of the defect>,"bug":"<short explanation>","fix":"<minimal code fix>"}`,
  score(text) {
    const value = String(text || "").toLowerCase()
    const bug =
      /(skip|start|first|index 0|zero|off.by.one|i\s*=\s*1|from 1)/.test(value) &&
      /(item|entry|element|index|array|first)/.test(value)
    const fix = /i\s*=\s*0|index\s*=\s*0|start(?:ing)? at (?:0|zero)/.test(value) || /slice\(0\)|for\s*\(.*of/.test(value)
    const validJson = isJsonObject(text)
    return clamp((bug ? 0.45 : 0) + (fix ? 0.45 : 0) + (validJson ? 0.1 : 0))
  },
}

export const BUILD_FIXTURE = {
  name: "build-even-sum",
  files: {
    "package.json": JSON.stringify(
      {
        name: "free-bench-build",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "src/math.js": `export function sumEven(numbers) {
  return numbers
    .filter((number) => number % 2 !== 0)
    .reduce((sum, number) => sum + number, 0)
}
`,
    "test/math.test.js": `import test from "node:test"
import assert from "node:assert/strict"
import { sumEven } from "../src/math.js"

test("sums even numbers", () => {
  assert.equal(sumEven([1, 2, 3, 4]), 6)
})

test("returns zero when there are no even numbers", () => {
  assert.equal(sumEven([1, 3, 5]), 0)
})
`,
  },
  hiddenFile: {
    "test/hidden.test.js": `import test from "node:test"
import assert from "node:assert/strict"
import { sumEven } from "../src/math.js"

test("handles negative even numbers and does not mutate the input", () => {
  const input = [-2, -1, 0, 1, 2]
  assert.equal(sumEven(input), 0)
  assert.deepEqual(input, [-2, -1, 0, 1, 2])
})

test("handles an empty array", () => {
  assert.equal(sumEven([]), 0)
})
`,
  },
  prompt: `Fix the bug in src/math.js so the repository's tests pass. Do not edit tests.
Use the available file and shell tools, run the tests, and finish with a short summary.`,
  score({ visiblePass, hiddenPass }) {
    return clamp((visiblePass ? 0.2 : 0) + (hiddenPass ? 0.8 : 0))
  },
}

export function fixtureText() {
  return { planning: PLANNING_FIXTURE, build: BUILD_FIXTURE }
}

function isJsonObject(text) {
  const value = String(text || "").trim()
  const start = value.indexOf("{")
  const end = value.lastIndexOf("}")
  if (start === -1 || end <= start) return false
  try {
    const parsed = JSON.parse(value.slice(start, end + 1))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function clamp(value) {
  return Math.max(0, Math.min(1, value))
}
