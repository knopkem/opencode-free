import { PROFILE_WEIGHTS, RELAY_ROLE_MAP } from "./constants.js"
import {
  baseKey,
  isZeroCost,
  modelChoices,
  modelKey,
  normalizeKey,
  parseKey,
} from "./catalog.js"
import { healthStats, isEligibleHealth } from "./health.js"

export function roleForAgent(agent) {
  const name = String(agent || "").toLowerCase()
  if (RELAY_ROLE_MAP[name]) return RELAY_ROLE_MAP[name]
  if (name === "plan" || name.includes("planner") || name.endsWith("-plan")) return "plan"
  if (name === "build" || name.includes("implement") || name.endsWith("-build")) return "build"
  if (name.includes("verify") || name.includes("review") || name.includes("audit")) return "verify"
  if (name.includes("explore") || name.includes("orchestr") || name.includes("fast")) return "fast"
  return "build"
}

export function promptNeedsVision(prompt) {
  const files = Array.isArray(prompt?.files) ? prompt.files : []
  return files.some((file) => {
    const value = `${file?.uri || ""} ${file?.name || ""}`.toLowerCase()
    return (
      /^data:image\//.test(value) ||
      /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)(\?|$|\s)/i.test(value) ||
      /image\/(png|jpeg|gif|webp)/i.test(value)
    )
  })
}

export function isFreeSelectedModel(model, catalog) {
  if (!model?.providerID || !model?.id) return false
  const record = (catalog.models || []).find(
    (candidate) => candidate.providerID === model.providerID && candidate.id === model.id,
  )
  return Boolean(record && isZeroCost(record))
}

export function summaryFor(benchmarks, role, key) {
  return benchmarks?.summaries?.[role]?.[key]
}

export function scoreCandidate({ candidate, state, benchmarks, settings, role, now = Date.now() }) {
  const key = modelKey(candidate)
  const health = state.health?.[key]
  const stats = healthStats(health, now)
  const summary = summaryFor(benchmarks, role, key)
  const quality = finite(summary?.quality) ?? 0.5
  const benchCapability = finite(summary?.capability)
  const reliability = finite(summary?.reliability)
  const observedReliability = stats.samples >= 1 ? stats.reliability : undefined
  const effectiveReliability = observedReliability ?? reliability ?? 0.7
  const ttft = finite(summary?.ttftMs) ?? stats.ttftMs
  const tps = finite(summary?.tps) ?? stats.tps
  const weights = PROFILE_WEIGHTS[settings.profile]?.[role] || PROFILE_WEIGHTS.balanced.build
  const speed = speedScore(ttft, tps, settings.speed)
  const confidence = (summary?.samples || 0) > 0 ? Math.min(1, (summary.samples || 0) / 3) : 0
  const exploration = confidence === 0 ? 0.025 : 0
  const routingCount = Number(state.routingCounts?.[key] || 0)
  const tieBreak = -Math.min(0.001, routingCount * 0.00001)
  const score =
    quality * weights.quality +
    effectiveReliability * weights.reliability +
    speed * weights.speed +
    exploration +
    tieBreak
  return {
    key,
    score: round(score),
    quality: round(quality),
    capability: benchCapability === undefined ? undefined : round(benchCapability),
    reliability: round(effectiveReliability),
    speed: round(speed),
    confidence: round(confidence),
    benchmarkSamples: summary?.samples || 0,
    liveSamples: stats.samples,
    health: stats.state,
    ttftMs: ttft,
    tps,
    cooldownUntil: stats.cooldownUntil || undefined,
    lastError: stats.lastError,
    routingCount,
    weights,
  }
}

function speedScore(ttft, tps, speedSettings = {}) {
  const targetTtft = Number(speedSettings.targetTtftMs) || 8_000
  const targetTps = Number(speedSettings.targetTps) || 40
  const latency = Number.isFinite(ttft) ? 1 / (1 + Math.max(0, ttft) / targetTtft) : 0.5
  const throughput = Number.isFinite(tps) ? Math.min(1, Math.max(0, tps / targetTps)) : 0.5
  return round(0.6 * latency + 0.4 * throughput)
}

export function chooseModel({
  catalog,
  state,
  benchmarks,
  settings,
  role,
  prompt,
  current,
  exclude = [],
  now = Date.now(),
}) {
  const requirements = { needsVision: promptNeedsVision(prompt) }
  const choices = modelChoices(catalog, role, settings.profile, requirements)
  const excluded = new Set(exclude.map(normalizeExclude))
  const pinned = settings.pinnedModels?.[role]
  const all = choices.map((candidate) =>
    scoreCandidate({ candidate, state, benchmarks, settings, role, now }),
  )
  const eligible = all.filter((scored) => {
    if (excluded.has(scored.key)) return false
    if (summaryFor(benchmarks, role, scored.key)?.disqualified) return false
    return isEligibleHealth(state.health?.[scored.key], now)
  })

  if (pinned) {
    const parsedPin = parseKey(pinned)
    const chosen = eligible.find((item) => {
      if (!pinMatchesModel(pinned, choices.find((candidate) => candidate.key === item.key))) return false
      return !parsedPin?.variant || item.key === normalizeKey(pinned)
    })
    if (chosen) {
      return {
        candidate: choices.find((item) => item.key === chosen.key),
        decision: {
          ...chosen,
          role,
          reason: "pinned",
          pinned: true,
          needsVision: requirements.needsVision,
        },
        alternatives: eligible.filter((item) => item.key !== chosen.key).sort(byScore),
        all,
      }
    }
  }

  const models = new Map(choices.map((candidate) => [modelKey(candidate), candidate]))
  const ranked = eligible.sort(byScore)
  const best = ranked[0]
  if (!best) {
    return {
      candidate: undefined,
      decision: {
        role,
        reason: excluded.size > 0 ? "exhausted" : "no_eligible_free_models",
        needsVision: requirements.needsVision,
        excluded: [...excluded],
      },
      alternatives: [],
      all,
    }
  }

  let reason = pinned ? "pinned_unavailable" : "best_score"
  if (current) {
    const currentKey = modelKey(current)
    const currentChoice = eligible.find((item) => item.key === currentKey)
    if (currentChoice && currentChoice.health !== "half-open") {
      const margin = Number(best.score) - Number(currentChoice.score)
      if (margin < 0.035) {
        return {
          candidate: models.get(currentChoice.key),
          decision: {
            ...currentChoice,
            role,
            reason: "sticky",
            bestAlternative: best.key,
            bestAlternativeScore: best.score,
            needsVision: requirements.needsVision,
          },
          alternatives: ranked.filter((item) => item.key !== currentChoice.key),
          all,
        }
      }
    }
  }

  return {
    candidate: models.get(best.key),
    decision: {
      ...best,
      role,
      reason,
      previous: current ? modelKey(current) : undefined,
      needsVision: requirements.needsVision,
    },
    alternatives: ranked.slice(1),
    all,
  }
}

export function normalizeExclude(value) {
  if (typeof value === "string") return normalizeKey(value)
  return modelKey(value)
}

export function retryCandidates({
  catalog,
  state,
  benchmarks,
  settings,
  role,
  prompt,
  exclude,
  now = Date.now(),
}) {
  return chooseModel({ catalog, state, benchmarks, settings, role, prompt, exclude, now })
}

export function routeKeyForPin(value, catalog) {
  const parsed = parseKey(value)
  if (!parsed) return undefined
  const record = (catalog.models || []).find(
    (model) => model.providerID === parsed.providerID && model.id === parsed.id,
  )
  if (!record) return undefined
  if (!parsed.variant) return baseKey(record)
  return modelKey({ ...record, variant: parsed.variant })
}

export function pinMatchesModel(pin, candidate) {
  if (!pin || !candidate) return false
  const parsed = parseKey(pin)
  if (!parsed) return false
  if (parsed.providerID !== candidate.providerID || parsed.id !== candidate.id) return false
  return !parsed.variant || parsed.variant === candidate.variant
}

function byScore(a, b) {
  return Number(b.score) - Number(a.score) || b.quality - a.quality || a.key.localeCompare(b.key)
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function round(value) {
  return Math.round(value * 10_000) / 10_000
}
