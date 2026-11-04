import { modelKey } from "./catalog.js"
import { ROLES } from "./constants.js"
import { QUALITY_PRIORS, priorFamilyForModel } from "./priors.js"

export { QUALITY_PRIORS }

const UNKNOWN_PRIOR_SCORE = 0.5
export const PRIOR_DIMENSIONS = Object.freeze([
  "reasoning",
  "coding",
  "codeGeneration",
  "toolUse",
  "instructionFollowing",
])
const CORE_DIMENSIONS = PRIOR_DIMENSIONS.filter((dimension) => dimension !== "codeGeneration")
const STATIC_CODING = /livecodebench|humaneval|mbpp|codeforces/i

// Each benchmark is normalized against a practical floor and ceiling. Optional
// static code-generation evidence is capped because it does not demonstrate
// repository-scale editing or tool use. The result stays on a linear 0..1 scale;
// it is a relative prior, not a calibrated task-success probability.
const STATIC_CODING_CAP = 0.8
const BENCHMARK_RANGES = Object.freeze([
  { pattern: /gpqa/i, floor: 0.45, ceiling: 0.92 },
  { pattern: /swe-bench|deepswe/i, floor: 0.2, ceiling: 0.82, agentic: true },
  { pattern: /terminal-bench/i, floor: 0.35, ceiling: 0.95, agentic: true },
  { pattern: /tau2|tau-bench|taubench/i, floor: 0.3, ceiling: 0.85, agentic: true },
  { pattern: /toolathlon|mcp atlas|bfcl/i, floor: 0.3, ceiling: 0.9, agentic: true },
  { pattern: /livecodebench/i, floor: 0.25, ceiling: 0.85 },
  { pattern: /ifbench|ifeval/i, floor: 0.25, ceiling: 0.95 },
  { pattern: /aime/i, floor: 0.1, ceiling: 0.95 },
])
const DEFAULT_BENCHMARK_RANGE = Object.freeze({ floor: 0.25, ceiling: 0.9 })

// Build quality is dominated by repository-level coding and tool use. Static
// code-generation evidence is deliberately a small separate contribution.
const ROLE_WEIGHTS = Object.freeze({
  plan: {
    reasoning: 0.45,
    coding: 0.1,
    codeGeneration: 0.05,
    toolUse: 0.2,
    instructionFollowing: 0.2,
  },
  build: {
    reasoning: 0.05,
    coding: 0.6,
    codeGeneration: 0.05,
    toolUse: 0.2,
    instructionFollowing: 0.1,
  },
  verify: {
    reasoning: 0.35,
    coding: 0.35,
    codeGeneration: 0.05,
    toolUse: 0.1,
    instructionFollowing: 0.15,
  },
  fast: {
    reasoning: 0.05,
    coding: 0.25,
    codeGeneration: 0.1,
    toolUse: 0.35,
    instructionFollowing: 0.25,
  },
})

export function priorForModel(model, settings = {}) {
  if (!model?.providerID || !model?.id) return { known: false, score: UNKNOWN_PRIOR_SCORE }
  const key = modelKey(model)
  const base = `${model.providerID}/${model.id}`
  const overrides = settings.qualityPriors && typeof settings.qualityPriors === "object"
    ? settings.qualityPriors
    : {}
  const override = overrides[key] || overrides[base]
  if (override) {
    return normalizePrior(
      { ...override, matchType: "override" },
      "user-config",
      true,
      key,
    )
  }
  const match = priorFamilyForModel(base)
  if (match) {
    return normalizePrior(
      {
        ...match.family,
        ...familyScores(match.family),
        familyID: match.id,
        matchType: "family",
      },
      QUALITY_PRIORS.source,
      true,
      base,
    )
  }
  return {
    known: false,
    score: UNKNOWN_PRIOR_SCORE,
    confidence: 0,
    source: "unmapped",
    matchType: "unmatched",
    version: QUALITY_PRIORS.version,
    updatedAt: QUALITY_PRIORS.updatedAt,
  }
}

export function calibrateEvidenceScore(value, benchmark = "") {
  const raw = clamp(value)
  const name = String(benchmark)
  const range =
    BENCHMARK_RANGES.find((item) => item.pattern.test(name)) ||
    DEFAULT_BENCHMARK_RANGE
  let normalized = clamp((raw - range.floor) / (range.ceiling - range.floor))
  if (!range.agentic && STATIC_CODING.test(name)) {
    normalized = Math.min(STATIC_CODING_CAP, normalized)
  }
  return normalized
}

function familyScores(family) {
  if (family.priors) {
    return {
      ...family.priors,
      evidenceDimensions: Object.keys(family.priors).filter((key) =>
        PRIOR_DIMENSIONS.includes(key),
      ),
    }
  }
  const buckets = new Map()
  let validEvidence = 0
  for (const item of family.evidence || []) {
    const score = Number(item?.score)
    const scale = Number(item?.scale) || 100
    if (!Number.isFinite(score) || !PRIOR_DIMENSIONS.includes(item?.dimension)) continue
    validEvidence += 1
    const dimension = evidenceDimension(item)
    const bucket = buckets.get(dimension) || { total: 0, count: 0 }
    bucket.total += calibrateEvidenceScore(score / scale, item.benchmark)
    bucket.count += 1
    buckets.set(dimension, bucket)
  }
  const evidenceDimensions = [...buckets.keys()]
  const scores = Object.fromEntries(
    PRIOR_DIMENSIONS.map((dimension) => {
      const bucket = buckets.get(dimension)
      return [
        dimension,
        bucket ? bucket.total / bucket.count : UNKNOWN_PRIOR_SCORE,
      ]
    }),
  )
  const coveredCore = evidenceDimensions.filter((dimension) =>
    CORE_DIMENSIONS.includes(dimension),
  ).length
  const extraEvidence = validEvidence > evidenceDimensions.length ? 0.05 : 0
  return {
    ...scores,
    confidence: clamp(0.4 + coveredCore * 0.1 + extraEvidence),
    evidenceDimensions,
  }
}

function evidenceDimension(item) {
  if (item?.dimension === "coding" && STATIC_CODING.test(String(item.benchmark))) {
    return "codeGeneration"
  }
  return item?.dimension
}

export function priorQualityForRole(prior, role) {
  if (!prior?.known) return UNKNOWN_PRIOR_SCORE
  if (Number.isFinite(prior.roles?.[role])) return clamp(prior.roles[role])
  const weights = ROLE_WEIGHTS[role] || ROLE_WEIGHTS.build
  let total = 0
  for (const dimension of PRIOR_DIMENSIONS) {
    const value = Number.isFinite(prior[dimension])
      ? prior[dimension]
      : UNKNOWN_PRIOR_SCORE
    total += value * Number(weights[dimension] || 0)
  }
  return clamp(total)
}

export function neutralQualityForModels(models, role, settings = {}) {
  const scores = []
  for (const model of models || []) {
    const prior = priorForModel(model, settings)
    if (!prior.known) continue
    scores.push(priorQualityForRole(prior, role))
  }
  if (!scores.length) return UNKNOWN_PRIOR_SCORE
  scores.sort((left, right) => left - right)
  const middle = Math.floor(scores.length / 2)
  return round(
    scores.length % 2
      ? scores[middle]
      : (scores[middle - 1] + scores[middle]) / 2,
  )
}

export function publicQualitySummary(model, settings = {}) {
  const prior = priorForModel(model, settings)
  const roles = {}
  if (prior.known) {
    for (const role of ROLES) {
      roles[role] = round(priorQualityForRole(prior, role))
    }
  }
  const evidence = Array.isArray(prior.evidence) ? prior.evidence : []
  return {
    known: prior.known,
    source: prior.source || "unmapped",
    sourceModel: prior.sourceModel,
    family: prior.familyID,
    matchedBy: prior.matchType || (prior.known ? "family" : "unmatched"),
    confidence: prior.known ? prior.confidence : undefined,
    version: prior.version,
    updatedAt: prior.updatedAt,
    evidence: {
      count: evidence.length,
      benchmarks: [...new Set(evidence.map((item) => item.benchmark).filter(Boolean))],
      dimensions: prior.evidenceDimensions || [],
    },
    roles,
  }
}

export function qualityEstimate({
  model,
  role,
  settings = {},
  neutralQuality = UNKNOWN_PRIOR_SCORE,
}) {
  const prior = priorForModel(model, settings)
  const priorScore = prior.known
    ? priorQualityForRole(prior, role)
    : clamp(neutralQuality)
  return {
    score: round(clamp(priorScore)),
    priorQuality: round(clamp(priorScore)),
    priorKnown: prior.known,
    priorSource: prior.source,
    priorVersion: prior.version,
    priorUpdatedAt: prior.updatedAt,
    confidence: round(clamp(prior.known ? prior.confidence ?? 0 : 0)),
    source: prior.known ? prior.source : "neutral",
  }
}

function normalizePrior(input, source, known, key) {
  const evidenceDimensions = Array.isArray(input.evidenceDimensions)
    ? [...new Set(input.evidenceDimensions.filter((dimension) =>
        PRIOR_DIMENSIONS.includes(dimension),
      ))]
    : PRIOR_DIMENSIONS.filter((dimension) => input[dimension] !== undefined)
  const normalized = {
    ...input,
    known,
    key,
    source: input.source || source,
    version: input.version || QUALITY_PRIORS.version,
    updatedAt: input.updatedAt || QUALITY_PRIORS.updatedAt,
    confidence: clamp(input.confidence ?? (known ? 0.5 : 0)),
    reasoning: clamp(input.reasoning ?? 0.5),
    coding: clamp(input.coding ?? 0.5),
    codeGeneration: clamp(input.codeGeneration ?? 0.5),
    toolUse: clamp(input.toolUse ?? 0.5),
    instructionFollowing: clamp(input.instructionFollowing ?? 0.5),
    evidenceDimensions,
    roles: input.roles && typeof input.roles === "object" ? input.roles : undefined,
  }
  normalized.score = priorQualityForRole(normalized, "build")
  return normalized
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

function round(value) {
  return Math.round(value * 10_000) / 10_000
}
