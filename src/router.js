import { PROFILE_WEIGHTS, RELAY_ROLE_MAP, ROLES } from "./constants.js"
import {
  baseKey,
  isZeroCost,
  modelChoices,
  modelKey,
  normalizeKey,
  parseKey,
} from "./catalog.js"
import { probeStateFor } from "./availability.js"
import { healthStats, isEligibleHealth } from "./health.js"
import {
  neutralQualityForModels,
  priorForModel,
  qualityEstimate,
} from "./quality.js"

const STICKY_MARGIN = 0.035
const DIVERSITY_CANDIDATE_LIMIT = 6

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

export function scoreCandidate({
  candidate,
  state,
  probes,
  settings,
  role,
  neutralQuality = 0.5,
  now = Date.now(),
}) {
  const key = modelKey(candidate)
  const health = state.health?.[key]
  const stats = healthStats(health, now)
  const providerHealth = state.providerHealth?.[candidate.providerID]
  const providerStats = healthStats(providerHealth, now)
  const providerEligible = isEligibleHealth(providerHealth, now)
  const estimate = qualityEstimate({
    model: candidate,
    role,
    settings,
    neutralQuality,
  })
  const quality = estimate.score
  const effectiveReliability = stats.samples >= 1 ? stats.reliability : 0.7
  const tps = stats.tps
  const probe = probeStateFor(
    probes?.probes?.[`${candidate.providerID}/${candidate.id}`],
    settings,
    now,
  )
  const probeBlocked = Boolean(probe.fresh && !probe.available)
  const probeLatencyMs = probe.fresh && probe.available ? probe.latencyMs : undefined
  const liveSpeed = speedScore(stats.ttftMs, tps, settings.speed)
  const probeSpeed = Number.isFinite(probeLatencyMs)
    ? speedScore(probeLatencyMs, tps, settings.speed)
    : undefined
  const speed =
    stats.samples < 1 && Number.isFinite(probeSpeed)
      ? probeSpeed
      : Number.isFinite(probeSpeed)
        ? Math.min(liveSpeed, probeSpeed)
        : liveSpeed
  const weights = PROFILE_WEIGHTS[settings.profile]?.[role] || PROFILE_WEIGHTS.balanced.build
  const routingCount = Number(state.routingCounts?.[key] || 0)
  const tieBreak = -Math.min(0.001, routingCount * 0.00001)
  const score =
    quality * weights.quality +
    effectiveReliability * weights.reliability +
    speed * weights.speed +
    tieBreak
  return {
    key,
    providerID: candidate.providerID,
    score: round(score),
    quality: round(quality),
    priorQuality: estimate.priorQuality,
    priorKnown: estimate.priorKnown,
    priorSource: estimate.priorSource,
    qualitySource: estimate.source,
    reliability: round(effectiveReliability),
    speed: round(speed),
    confidence: round(estimate.confidence),
    liveSamples: stats.samples,
    health: providerEligible ? stats.state : providerStats.state,
    modelHealth: stats.state,
    providerState: providerStats.state,
    providerEligible,
    ttftMs: stats.ttftMs,
    tps,
    cooldownUntil: stats.cooldownUntil || undefined,
    providerCooldownUntil: providerStats.cooldownUntil || undefined,
    providerLastError: providerStats.lastError,
    lastError: stats.lastError,
    probeKnown: probe.known,
    probeFresh: probe.fresh,
    probeAvailable: probe.available,
    probeKind: probe.kind,
    probeCheckedAt: probe.checkedAt,
    probeLatencyMs,
    probeBlocked,
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

function evaluateRole({
  catalog,
  state,
  probes,
  settings,
  role,
  prompt,
  exclude = [],
  forcedKey,
  now = Date.now(),
}) {
  const requirements = { needsVision: promptNeedsVision(prompt) }
  const choices = modelChoices(catalog, role, settings.profile, requirements)
  const choiceByKey = new Map(choices.map((candidate) => [candidate.key, candidate]))
  const neutralQuality = neutralQualityForModels(choices, role, settings)
  const excluded = new Set(exclude.map(normalizeExclude))
  const all = choices
    .map((candidate) => {
      const scored = scoreCandidate({
        candidate,
        state,
        probes,
        settings,
        role,
        neutralQuality,
        now,
      })
      let excludedReason
      if (excluded.has(scored.key)) excludedReason = "excluded"
      else if (!scored.providerEligible) excludedReason = "provider_cooldown"
      else if (!isEligibleHealth(state.health?.[scored.key], now)) excludedReason = "unhealthy"
      else if (scored.probeBlocked) excludedReason = "probe_unavailable"
      return {
        ...scored,
        eligible: !excludedReason,
        excludedReason,
      }
    })
    .sort(byScore)
  let eligible = all.filter((item) => item.eligible)
  if (!eligible.length && all.some((item) => item.excludedReason === "probe_unavailable")) {
    eligible = all
      .filter((item) => item.excludedReason === "probe_unavailable")
      .map((item) => ({
        ...item,
        eligible: true,
        excludedReason: undefined,
        probeFallback: true,
      }))
  }
  const ranked = [...eligible].sort(byScore)
  const best = ranked[0]
  const pinned = settings.pinnedModels?.[role]
  const pinnedCandidate = pinned
    ? ranked.find((item) => pinMatchesModel(pinned, choiceByKey.get(item.key)))
    : undefined
  const forcedItem = forcedKey
    ? ranked.find((item) => item.key === normalizeKey(forcedKey))
    : undefined
  const primary = pinnedCandidate || forcedItem || best
  const reason = pinnedCandidate
    ? "pinned"
    : forcedItem
      ? "explore_unmapped"
      : pinned
        ? "pinned_unavailable"
        : "best_score"
  return {
    role,
    requirements,
    choices,
    choiceByKey,
    excluded,
    all,
    eligible,
    ranked,
    best,
    pinned,
    pinnedCandidate,
    forcedItem,
    primary,
    neutralQuality,
    chainOrder: primary
      ? [primary, ...ranked.filter((item) => item.key !== primary.key)]
      : [],
    reason,
  }
}

export function chooseModel({
  catalog,
  state,
  probes,
  settings,
  role,
  prompt,
  current,
  exclude = [],
  forcedKey,
  now = Date.now(),
}) {
  const evaluated = evaluateRole({
    catalog,
    state,
    probes,
    settings,
    role,
    prompt,
    exclude,
    forcedKey,
    now,
  })
  const { all, eligible, ranked, pinnedCandidate, forcedItem, primary, excluded } = evaluated
  if (!primary) {
    return {
      candidate: undefined,
      decision: {
        role,
        reason: noCandidateReason(evaluated),
        needsVision: evaluated.requirements.needsVision,
        excluded: [...excluded],
        chain: [],
      },
      alternatives: [],
      all,
      chain: [],
    }
  }

  if (pinnedCandidate) {
    return selectionResult(evaluated, pinnedCandidate, "pinned", settings, {
      current,
      pinned: true,
    })
  }

  if (forcedItem) {
    return selectionResult(evaluated, forcedItem, "explore_unmapped", settings, {
      current,
      independent: evaluated.best,
    })
  }

  let reason = evaluated.pinned ? "pinned_unavailable" : "best_score"
  let chosen = primary
  if (current) {
    const currentKey = modelKey(current)
    const currentChoice = eligible.find((item) => item.key === currentKey)
    if (currentChoice && currentChoice.health !== "half-open") {
      const margin = Number(primary.score) - Number(currentChoice.score)
      if (margin < STICKY_MARGIN) {
        chosen = currentChoice
        reason = "sticky"
      }
    }
  }

  return selectionResult(evaluated, chosen, reason, settings, {
    current,
    bestAlternative: reason === "sticky" ? primary.key : undefined,
  })
}

export function chooseRoutes({
  catalog,
  state,
  probes,
  settings,
  role,
  prompt,
  current,
  prompts = {},
  currentModels = {},
  forcedKeys = {},
  now = Date.now(),
}) {
  const rolePrompts = { ...prompts }
  const roleCurrent = { ...currentModels }
  if (role && prompt !== undefined) rolePrompts[role] = prompt
  if (role && current) roleCurrent[role] = current

  const evaluations = Object.fromEntries(
    ROLES.map((name) => [
      name,
      evaluateRole({
        catalog,
        state,
        probes,
        settings,
        role: name,
        prompt: rolePrompts[name],
        exclude: [],
        forcedKey: forcedKeys[name],
        now,
      }),
    ]),
  )
  const diversity = diversitySettings(settings, evaluations)
  const assigned = assignRoutes(evaluations, diversity)
  const routes = {}
  for (const name of ROLES) {
    const evaluation = evaluations[name]
    if (!assigned[name]) {
      routes[name] = {
        candidate: undefined,
        decision: {
          role: name,
          reason: noCandidateReason(evaluation),
          needsVision: evaluation.requirements.needsVision,
          chain: [],
        },
        alternatives: [],
        all: evaluation.all,
        chain: [],
        independent: evaluation.best,
      }
      continue
    }
    let chosen = assigned[name]
    let reason = evaluation.reason
    const independent = evaluation.best
    if (
      independent &&
      chosen.key !== independent.key &&
      !evaluation.pinnedCandidate &&
      !evaluation.forcedItem
    ) {
      reason = "role_diversity"
    }
    let stickyBest
    if (reason === "best_score" && roleCurrent[name]) {
      const currentKey = modelKey(roleCurrent[name])
      const currentItem = evaluation.eligible.find((item) => item.key === currentKey)
      const currentCandidate = evaluation.choiceByKey.get(currentKey)
      const usedElsewhere = diversity.enabled && currentCandidate
        ? ROLES.some((other) => {
            if (other === name || !assigned[other]) return false
            const candidate = evaluations[other].choiceByKey.get(assigned[other].key)
            return candidate && reuseKey(candidate, diversity) === reuseKey(currentCandidate, diversity)
          })
        : false
      if (
        currentItem &&
        currentItem.health !== "half-open" &&
        !usedElsewhere &&
        Number(evaluation.primary.score) - Number(currentItem.score) < STICKY_MARGIN
      ) {
        stickyBest = chosen.key
        chosen = currentItem
        reason = "sticky"
      }
    }
    const result = selectionResult(evaluation, chosen, reason, settings, {
      current: roleCurrent[name],
      independent,
      diversity,
      assignmentReason: reason,
      bestAlternative: stickyBest,
    })
    routes[name] = result
  }
  return { roles: routes, diversity, evaluations }
}

export function retryCandidates({
  catalog,
  state,
  probes,
  settings,
  role,
  prompt,
  exclude,
  now = Date.now(),
}) {
  return chooseModel({ catalog, state, probes, settings, role, prompt, exclude, now })
}

export function explorationRate(settings, role) {
  const configured = settings.routing?.exploreUnmapped
  const value =
    configured && typeof configured === "object"
      ? configured[role]
      : configured
  const rate = Number(value)
  return Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0
}

export function selectExplorationCandidate({
  catalog,
  state,
  settings,
  role,
  prompt,
  exclude = [],
  random = Math.random,
  now = Date.now(),
}) {
  const rate = explorationRate(settings, role)
  if (rate <= 0 || random() >= rate) return undefined
  const requirements = { needsVision: promptNeedsVision(prompt) }
  const excluded = new Set(exclude.map(normalizeExclude))
  const candidates = modelChoices(catalog, role, settings.profile, requirements)
    .filter((candidate) => {
      if (excluded.has(candidate.key)) return false
      if (priorForModel(candidate, settings).known) return false
      if (!isEligibleHealth(state.providerHealth?.[candidate.providerID], now)) return false
      if (!isEligibleHealth(state.health?.[candidate.key], now)) return false
      return true
    })
    .sort((left, right) => {
      const leftCount = Number(state.routingCounts?.[left.key] || 0)
      const rightCount = Number(state.routingCounts?.[right.key] || 0)
      if (leftCount !== rightCount) return leftCount - rightCount
      const leftAt = Date.parse(state.exploration?.[left.key] || "") || 0
      const rightAt = Date.parse(state.exploration?.[right.key] || "") || 0
      if (leftAt !== rightAt) return leftAt - rightAt
      return left.key.localeCompare(right.key)
    })
  return candidates[0]?.key
}

function noCandidateReason(evaluated) {
  if (evaluated.all.length > 0 && !evaluated.all.some((item) => item.providerEligible)) {
    return "provider_cooldown"
  }
  return evaluated.excluded.size > 0 ? "exhausted" : "no_eligible_free_models"
}

function selectionResult(evaluated, chosen, reason, settings, options = {}) {  const candidate = evaluated.choiceByKey.get(chosen.key)
  const alternatives = evaluated.ranked
    .filter((item) => item.key !== chosen.key)
    .sort(byScore)
  const chain = buildChain(evaluated, chosen.key, settings)
  const decision = {
    ...chosen,
    role: evaluated.role,
    reason,
    previous: options.current ? modelKey(options.current) : undefined,
    needsVision: evaluated.requirements.needsVision,
    chain: chain.map((item) => item.key),
  }
  if (options.pinned) decision.pinned = true
  if (reason === "sticky" && options.bestAlternative) {
    decision.bestAlternative = options.bestAlternative
    const best = evaluated.ranked.find((item) => item.key === options.bestAlternative)
    decision.bestAlternativeScore = best?.score
  }
  if (reason === "role_diversity" && options.independent) {
    decision.independentBest = options.independent.key
    decision.independentScore = options.independent.score
    decision.scoreLoss = round(Number(options.independent.score) - Number(chosen.score))
    decision.assignmentReason = "role_diversity"
    decision.overlapPenalty = options.diversity?.enabled
      ? options.diversity.overlapPenalty
      : 0
  }
  if (options.current && modelKey(options.current) === chosen.key) decision.kept = true
  return {
    candidate,
    decision,
    alternatives,
    all: evaluated.all,
    chain,
    independent: options.independent || evaluated.primary,
  }
}

function buildChain(evaluated, primaryKey, settings) {
  const max = Math.max(1, Math.min(Number(settings.maxFailovers) + 1 || 4, 20))
  const primary = evaluated.all.find((item) => item.key === primaryKey)
  if (!primary) return []
  const ordered = [primary, ...evaluated.ranked.filter((item) => item.key !== primary.key)]
  return ordered.slice(0, max)
}

function diversitySettings(settings, evaluations) {
  const configured = settings.routing?.diversity
  const requested =
    configured === true || configured === false
      ? configured
      : settings.profile !== "quality"
  const providers = new Set()
  for (const evaluation of Object.values(evaluations)) {
    for (const item of evaluation.eligible) providers.add(item.providerID)
  }
  const unit = configured === true ? "model" : "provider"
  const enabled = requested && (unit === "model" || providers.size > 1)
  return {
    enabled,
    requested,
    unit,
    providerCount: providers.size,
    overlapPenalty: Math.max(0, Number(settings.routing?.overlapPenalty) || 0),
    maxPrimaryScoreLoss: Math.max(0, Number(settings.routing?.maxPrimaryScoreLoss) || 0),
    maxQualityLoss: Math.max(0, Number(settings.routing?.maxQualityLoss) || 0),
  }
}

function assignRoutes(evaluations, diversity) {
  const assigned = {}
  const counts = new Map()
  for (const role of ROLES) {
    const evaluation = evaluations[role]
    if (!evaluation.primary) continue
    if (evaluation.pinnedCandidate || evaluation.forcedItem || !diversity.enabled) {
      assigned[role] = evaluation.primary
      addCount(counts, evaluation.choiceByKey.get(evaluation.primary.key), diversity)
      continue
    }

    const independent = evaluation.primary
    const candidates = evaluation.ranked
      .filter(
        (item) =>
          Number(item.score) >=
            Number(independent.score) - diversity.maxPrimaryScoreLoss - 1e-9 &&
          Number(item.quality) >=
            Number(independent.quality) - diversity.maxQualityLoss - 1e-9,
      )
      .slice(0, DIVERSITY_CANDIDATE_LIMIT)
    let chosen = candidates[0] || independent
    let chosenAdjusted =
      Number(chosen.score) -
      Number(counts.get(reuseKey(evaluation.choiceByKey.get(chosen.key), diversity)) || 0) *
        diversity.overlapPenalty
    for (const item of candidates.slice(1)) {
      const candidate = evaluation.choiceByKey.get(item.key)
      const uses = Number(counts.get(reuseKey(candidate, diversity)) || 0)
      const adjusted = Number(item.score) - uses * diversity.overlapPenalty
      if (
        adjusted > chosenAdjusted + 1e-9 ||
        (Math.abs(adjusted - chosenAdjusted) <= 1e-9 && item.key < chosen.key)
      ) {
        chosen = item
        chosenAdjusted = adjusted
      }
    }
    assigned[role] = chosen
    addCount(counts, evaluation.choiceByKey.get(chosen.key), diversity)
  }
  return assigned
}

function addCount(counts, candidate, diversity) {
  if (!candidate) return
  const key = reuseKey(candidate, diversity)
  counts.set(key, Number(counts.get(key) || 0) + 1)
}

function reuseKey(candidate, diversity) {
  return diversity.unit === "provider" ? candidate.providerID : baseKey(candidate)
}

export function normalizeExclude(value) {
  if (typeof value === "string") return normalizeKey(value)
  return modelKey(value)
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
  return (
    Number(b.score) - Number(a.score) ||
    b.quality - a.quality ||
    Number(Boolean(b.priorKnown)) - Number(Boolean(a.priorKnown)) ||
    a.key.localeCompare(b.key)
  )
}

function round(value) {
  return Math.round(value * 10_000) / 10_000
}
