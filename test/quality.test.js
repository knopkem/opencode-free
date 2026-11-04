import test from "node:test"
import assert from "node:assert/strict"
import {
  calibrateEvidenceScore,
  neutralQualityForModels,
  priorForModel,
  priorQualityForRole,
  publicQualitySummary,
  qualityEstimate,
  QUALITY_PRIORS,
} from "../src/quality.js"
import { modelChoices, catalogFromModels } from "../src/catalog.js"
import { emptyState, mergeSettings } from "../src/state.js"

const settings = mergeSettings()

function model(id, providerID = "opencode") {
  return {
    providerID,
    id,
    name: id,
    type: "chat",
    enabled: true,
    status: "active",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    limit: { context: 100000, output: 16000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    time: { released: 1 },
  }
}

test("public priors map recognizable families and leave aliases unmapped", () => {
  const known = priorForModel(model("deepseek-v4.1-flash-free"), settings)
  const alias = priorForModel(model("big-pickle"), settings)
  assert.equal(known.known, true)
  assert.ok(known.reasoning > 0.8)
  assert.equal(alias.known, false)
  assert.equal(alias.source, "unmapped")
  assert.ok(QUALITY_PRIORS.models["opencode/glm-5.3-flash-free"])
  assert.ok(QUALITY_PRIORS.families["nemotron-3.5-lightning-30b-a3b"])
})

test("public quality summaries expose role scores only for mapped models", () => {
  const known = publicQualitySummary(model("deepseek-v4.1-flash-free"), settings)
  assert.equal(known.known, true)
  assert.equal(known.source, QUALITY_PRIORS.source)
  for (const role of ["plan", "build", "verify", "fast"]) {
    assert.ok(Number.isFinite(known.roles[role]))
  }
  const alias = publicQualitySummary(model("big-pickle"), settings)
  assert.equal(alias.known, false)
  assert.equal(alias.source, "unmapped")
  assert.deepEqual(alias.roles, {})
})

test("equivalent provider endpoints share one reviewed family prior", () => {
  const native = publicQualitySummary(model("nemotron-3.5-lightning-free"), settings)
  const mirrored = publicQualitySummary(
    model("nvidia/nemotron-3.5-lightning:free", "openrouter"),
    settings,
  )
  assert.equal(mirrored.known, true)
  assert.equal(mirrored.family, native.family)
  assert.equal(mirrored.sourceModel, "Nemotron 3.5 Lightning 30B A3B")
  assert.deepEqual(mirrored.roles, native.roles)
  assert.ok(mirrored.evidence.benchmarks.includes("GPQA Diamond"))
  assert.ok(mirrored.evidence.dimensions.includes("toolUse"))
})

test("benchmark percentages use a linear, benchmark-specific scale", () => {
  assert.ok(
    calibrateEvidenceScore(0.742, "DeepSWE v1.1") >
      calibrateEvidenceScore(0.8, "LiveCodeBench v6"),
  )
  assert.ok(calibrateEvidenceScore(0.9, "GPQA Diamond") > 0.9)
  assert.ok(calibrateEvidenceScore(0.5, "GPQA Diamond") < 0.2)
  assert.equal(calibrateEvidenceScore(0.99, "LiveCodeBench v6"), 0.8)
})

test("static code generation is separate from agentic coding", () => {
  const gemma = priorForModel(
    model("google/gemma-4-31b-it:free", "openrouter"),
    settings,
  )
  assert.equal(gemma.coding, 0.5)
  assert.ok(gemma.codeGeneration > 0.7)
  const qwen = priorForModel(model("qwen/qwen3-coder-30b", "lmstudio"), settings)
  assert.ok(qwen.coding > qwen.codeGeneration)
})

test("build quality reflects agentic coding instead of collapsing to near zero", () => {
  const qwen = publicQualitySummary(model("qwen/qwen3-coder-30b", "lmstudio"), settings)
  const glm = publicQualitySummary(model("zai-org/GLM-4.7-Flash", "huggingface"), settings)
  const gemma = publicQualitySummary(
    model("google/gemma-4-31b-it:free", "openrouter"),
    settings,
  )
  assert.ok(qwen.roles.build > 0.4)
  assert.ok(glm.roles.build > qwen.roles.build)
  assert.ok(qwen.roles.plan > 0.2)
  assert.ok(gemma.roles.plan > qwen.roles.plan)
})

test("missing benchmark dimensions shrink toward neutral instead of renormalizing", () => {
  const base = {
    known: true,
    reasoning: 0.9,
    coding: 0.8,
    codeGeneration: 0.8,
    toolUse: 0.8,
    instructionFollowing: 0.5,
  }
  const partial = {
    ...base,
    evidenceDimensions: ["reasoning", "coding", "toolUse"],
  }
  const complete = {
    ...base,
    evidenceDimensions: [
      "reasoning",
      "coding",
      "codeGeneration",
      "toolUse",
      "instructionFollowing",
    ],
  }
  assert.equal(priorQualityForRole(partial, "plan"), priorQualityForRole(complete, "plan"))
})

test("unmapped models use the role median of mapped public priors", () => {
  const catalog = catalogFromModels(
    [
      model("deepseek-v4.1-flash-free"),
      model("glm-5.3-flash-free"),
      model("big-pickle"),
    ],
    settings,
  )
  const choices = modelChoices(catalog, "build", settings.profile)
  const neutral = neutralQualityForModels(choices, "build", settings)
  const known = choices
    .filter((candidate) => priorForModel(candidate, settings).known)
    .map((candidate) => priorQualityForRole(priorForModel(candidate, settings), "build"))
    .sort((left, right) => left - right)
  const median = (known[0] + known[1]) / 2
  assert.ok(Math.abs(neutral - median) < 1e-3)
  const estimate = qualityEstimate({
    model: { providerID: "opencode", id: "big-pickle" },
    role: "build",
    settings,
    neutralQuality: neutral,
  })
  assert.equal(estimate.source, "neutral")
  assert.equal(estimate.score, Math.round(neutral * 10_000) / 10_000)
})

test("different model versions do not inherit each other's priors", () => {
  const glm47 = priorForModel(model("zai-org/GLM-4.7-Flash", "huggingface"), settings)
  const glm53 = priorForModel(model("glm-5.3-flash-free"), settings)
  assert.equal(glm47.known, true)
  assert.equal(glm53.known, true)
  assert.notEqual(glm47.familyID, glm53.familyID)
  assert.notEqual(glm47.coding, glm53.coding)
})

test("bundled family matches and evidence are valid and unique", () => {
  const matches = new Set()
  for (const [familyID, family] of Object.entries(QUALITY_PRIORS.families)) {
    assert.ok(family.sourceModel, familyID)
    assert.ok(family.matches.length > 0, familyID)
    for (const match of family.matches) {
      assert.ok(match.includes("/"), match)
      assert.equal(matches.has(match), false, `duplicate match ${match}`)
      matches.add(match)
    }
    for (const item of family.evidence) {
      assert.ok(item.benchmark, familyID)
      assert.ok(Number.isFinite(item.score), familyID)
      assert.ok(item.score >= 0 && item.score <= (item.scale || 100), familyID)
      assert.match(item.url, /^https?:\/\//)
      assert.match(item.checkedAt, /^\d{4}-\d{2}-\d{2}$/)
    }
  }
})

test("settings overrides replace a bundled or missing prior", () => {
  const overridden = mergeSettings({
    qualityPriors: {
      "opencode/big-pickle": {
        reasoning: 0.91,
        coding: 0.88,
        toolUse: 0.9,
        instructionFollowing: 0.9,
        confidence: 0.8,
      },
    },
  })
  const prior = priorForModel(model("big-pickle"), overridden)
  assert.equal(prior.known, true)
  assert.equal(prior.reasoning, 0.91)
  assert.equal(prior.source, "user-config")
  assert.equal(prior.matchType, "override")
})

test("empty catalogs retain a neutral fallback", () => {
  assert.equal(
    neutralQualityForModels([], "plan", settings),
    0.5,
  )
  const catalog = catalogFromModels([], settings)
  assert.equal(catalog.models.length, 0)
  assert.equal(emptyState().exploration !== undefined, true)
})
