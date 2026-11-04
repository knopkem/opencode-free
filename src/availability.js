import { classifyError } from "./health.js"

const ACCESS_FAILURES = new Set([
  "auth",
  "invalid_request",
  "unsupported",
  "no_route",
])

export function probeStateFor(record, settings = {}, now = Date.now()) {
  if (!record?.at) {
    return { known: false, fresh: false, available: true }
  }
  const checkedAt = Date.parse(record.at)
  if (!Number.isFinite(checkedAt)) {
    return { known: false, fresh: false, available: true }
  }
  const kind = record.error
    ? classifyError(record.error)
    : record.responseOk === false
      ? "invalid_output"
      : "success"
  const ttl = probeTtlFor(kind, settings)
  const age = Math.max(0, now - checkedAt)
  if (age > ttl) {
    return {
      known: true,
      fresh: false,
      available: true,
      kind,
      checkedAt: record.at,
      ageMs: age,
      ttlMs: ttl,
    }
  }
  if (kind === "success") {
    return {
      known: true,
      fresh: true,
      available: true,
      kind,
      checkedAt: record.at,
      ageMs: age,
      ttlMs: ttl,
      latencyMs: finite(record.durationMs),
    }
  }
  return {
    known: true,
    fresh: true,
    available: false,
    kind,
    checkedAt: record.at,
    ageMs: age,
    ttlMs: ttl,
  }
}

export function probeTtlFor(kind, settings = {}) {
  if (kind === "success") {
    return Number(settings.probe?.successTtlMs) || 60 * 60_000
  }
  if (ACCESS_FAILURES.has(kind)) {
    return Number(settings.probe?.accessFailureTtlMs) || 6 * 60 * 60_000
  }
  return Number(settings.probe?.failureTtlMs) || 10 * 60_000
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}
