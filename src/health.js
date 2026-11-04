const MAX_RECENT = 24
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000

function emptyHealth() {
  return {
    state: "unknown",
    consecutiveFailures: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    cooldownUntil: 0,
    lastError: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    recent: [],
  }
}

export function healthFor(state, key) {
  state.health ||= {}
  state.health[key] ||= emptyHealth()
  return state.health[key]
}

export function providerHealthFor(state, providerID) {
  state.providerHealth ||= {}
  state.providerHealth[providerID] ||= emptyHealth()
  return state.providerHealth[providerID]
}

export function providerIDForKey(key) {
  const value = String(key || "")
  const slash = value.indexOf("/")
  return slash > 0 ? value.slice(0, slash) : value
}

export function limitScopeFor(key, kind, settings = {}) {
  if (kind !== "rate_limit" && kind !== "quota") return "model"
  const providerID = providerIDForKey(key)
  const configured = settings.limitScopes?.[providerID]
  return configured === "provider" ? "provider" : "model"
}

export function classifyError(error = {}) {
  const type = String(error.type || "unknown")
  const message = String(error.message || "")
  const status = Number(error.status || 0)
  if (
    type === "provider.free-limit" ||
    type === "provider.quota" ||
    type === "provider.budget-limit" ||
    /quota|usage limit|free limit/i.test(message)
  ) {
    return "quota"
  }
  if (type === "provider.rate-limit" || status === 429) return "rate_limit"
  if (type === "provider.auth") return "auth"
  if (type === "provider.timeout" || /(?:timed? ?out|TIMEOUT|stalled for)/i.test(message)) return "timeout"
  if (type === "provider.transport") return "transport"
  if (type === "provider.internal" || status >= 500) return "server"
  if (type === "provider.invalid-output") return "invalid_output"
  if (type === "provider.invalid-request") return "invalid_request"
  if (type === "provider.content-filter") return "content_filter"
  if (type === "provider.unsupported-operation") return "unsupported"
  if (type === "provider.no-route") return "no_route"
  if (/rate.?limit|too many requests/i.test(message)) return "rate_limit"
  if (/timed? ?out|timeout/i.test(message)) return "timeout"
  return "unknown"
}

export function retryAfterMs(error) {
  const value = Number(error?.retryAfterMs)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.min(value, MAX_RETRY_AFTER_MS)
}

export function failureCooldown(kind, settings, error) {
  if (kind === "rate_limit") return retryAfterMs(error) ?? settings.rateLimitCooldownMs
  if (kind === "quota") return retryAfterMs(error) ?? settings.quotaCooldownMs
  if (kind === "timeout" || kind === "transport" || kind === "invalid_output") {
    return settings.serverCooldownMs
  }
  if (kind === "server") return settings.serverCooldownMs
  if (kind === "auth") return 24 * 60 * 60_000
  if (kind === "invalid_request" || kind === "unsupported" || kind === "no_route") {
    return 6 * 60 * 60_000
  }
  return settings.unknownCooldownMs
}

export function recordFailure(state, key, error, settings, now = Date.now()) {
  const kind = classifyError(error)
  const cooldown = failureCooldown(kind, settings, error)
  const scope = limitScopeFor(key, kind, settings)
  const providerID = providerIDForKey(key)
  let health
  let providerHealth
  if (scope === "provider") {
    providerHealth = providerHealthFor(state, providerID)
    applyFailure(providerHealth, error, kind, cooldown, now)
    health = providerHealth
  } else {
    health = healthFor(state, key)
    applyFailure(health, error, kind, cooldown, now)
  }
  return {
    health,
    kind,
    cooldown,
    scope,
    providerID,
    providerHealth,
    cooldownUntil: now + cooldown,
  }
}

function applyFailure(health, error, kind, cooldown, now) {
  health.state = "cooldown"
  health.consecutiveFailures += 1
  health.totalFailures += 1
  health.cooldownUntil = Math.max(health.cooldownUntil || 0, now + cooldown)
  health.lastAttemptAt = new Date(now).toISOString()
  health.lastError = {
    type: error?.type || "unknown",
    message: String(error?.message || "Unknown provider error").slice(0, 500),
    status: error?.status,
    kind,
    at: health.lastAttemptAt,
  }
  health.recent = [
    ...(health.recent || []),
    {
      at: now,
      ok: false,
      kind,
      durationMs: undefined,
      ttftMs: undefined,
      tps: undefined,
    },
  ].slice(-MAX_RECENT)
}

export function recordSuccess(state, key, metrics = {}, now = Date.now()) {
  const health = healthFor(state, key)
  applySuccess(health, metrics, now, false)
  const providerHealth = providerHealthFor(state, providerIDForKey(key))
  applySuccess(providerHealth, metrics, now, true)
  return health
}

function applySuccess(health, metrics, now, preserveFutureCooldown) {
  const cooling = preserveFutureCooldown && health.cooldownUntil > now
  health.state = cooling ? "cooldown" : "healthy"
  health.consecutiveFailures = 0
  health.totalSuccesses += 1
  if (!cooling) health.cooldownUntil = 0
  health.lastAttemptAt = new Date(now).toISOString()
  health.lastSuccessAt = health.lastAttemptAt
  health.recent = [
    ...(health.recent || []),
    {
      at: now,
      ok: true,
      kind: "success",
      ttftMs: finite(metrics.ttftMs),
      durationMs: finite(metrics.durationMs),
      tps: finite(metrics.tps),
      outputTokens: finite(metrics.outputTokens),
      reasoningTokens: finite(metrics.reasoningTokens),
    },
  ].slice(-MAX_RECENT)
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

export function effectiveState(health, now = Date.now()) {
  if (!health) return "unknown"
  if (health.cooldownUntil && health.cooldownUntil > now) return "cooldown"
  if (health.state === "cooldown" && health.cooldownUntil <= now) return "half-open"
  return health.state || "unknown"
}

export function isEligibleHealth(health, now = Date.now()) {
  if (!health) return true
  if (health.cooldownUntil && health.cooldownUntil > now) return false
  if (health.lastError?.kind === "auth" && health.cooldownUntil > now) return false
  return true
}

export function healthStats(health, now = Date.now()) {
  const recent = Array.isArray(health?.recent) ? health.recent : []
  const successes = recent.filter((item) => item.ok)
  const failures = recent.filter((item) => !item.ok)
  const nonAbortFailures = failures.filter((item) => item.kind !== "abort" && item.kind !== "user")
  const total = successes.length + nonAbortFailures.length
  const reliability = total === 0 ? 0.7 : (successes.length + 0.5) / (total + 1)
  const ttfts = successes.map((item) => item.ttftMs).filter(Number.isFinite)
  const durations = successes.map((item) => item.durationMs).filter(Number.isFinite)
  const throughputs = successes.map((item) => item.tps).filter(Number.isFinite)
  return {
    state: effectiveState(health, now),
    reliability: clamp(reliability, 0.05, 0.99),
    ttftMs: percentile(ttfts, 0.5),
    ttftP95Ms: percentile(ttfts, 0.95),
    durationMs: percentile(durations, 0.5),
    tps: percentile(throughputs, 0.5),
    samples: recent.length,
    consecutiveFailures: health?.consecutiveFailures || 0,
    cooldownUntil: health?.cooldownUntil || 0,
    lastError: health?.lastError,
    lastSuccessAt: health?.lastSuccessAt,
  }
}

function percentile(values, fraction) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
