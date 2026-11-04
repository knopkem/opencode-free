export const STATE_VERSION = 3
export const PROBE_VERSION = 1

export const ROLES = ["plan", "build", "verify", "fast"]
export const PRIMARY_ROLES = new Set(["plan", "build"])

export const DEFAULT_SETTINGS = Object.freeze({
  auto: true,
  profile: "balanced",
  providers: ["*"],
  excludeProviders: [],
  excludeModels: [],
  pinnedModels: {},
  qualityPriors: {},
  limitScopes: {
    opencode: "provider",
  },
  maxFailovers: 3,
  rateLimitCooldownMs: 60_000,
  quotaCooldownMs: 30 * 60_000,
  serverCooldownMs: 30_000,
  unknownCooldownMs: 15_000,
  speed: {
    targetTtftMs: 8_000,
    targetTps: 40,
  },
  routing: {
    diversity: "auto",
    overlapPenalty: 0.04,
    maxPrimaryScoreLoss: 0.04,
    maxQualityLoss: 0.03,
    exploreUnmapped: {
      plan: 0.02,
      build: 0.02,
      verify: 0.02,
      fast: 0.05,
    },
  },
  slow: {
    firstChunkMs: 90_000,
    idleChunkMs: 90_000,
  },
  probe: {
    onAssign: true,
    timeoutMs: 10_000,
    concurrency: 2,
    candidatesPerRole: 4,
    successTtlMs: 60 * 60_000,
    failureTtlMs: 10 * 60_000,
    accessFailureTtlMs: 6 * 60 * 60_000,
  },
})

export const PROFILE_WEIGHTS = Object.freeze({
  quality: {
    plan: { quality: 0.7, reliability: 0.2, speed: 0.1 },
    build: { quality: 0.6, reliability: 0.3, speed: 0.1 },
    verify: { quality: 0.7, reliability: 0.2, speed: 0.1 },
    fast: { quality: 0.3, reliability: 0.25, speed: 0.45 },
  },
  balanced: {
    plan: { quality: 0.55, reliability: 0.25, speed: 0.2 },
    build: { quality: 0.45, reliability: 0.3, speed: 0.25 },
    verify: { quality: 0.55, reliability: 0.25, speed: 0.2 },
    fast: { quality: 0.2, reliability: 0.25, speed: 0.55 },
  },
  fast: {
    plan: { quality: 0.35, reliability: 0.25, speed: 0.4 },
    build: { quality: 0.3, reliability: 0.3, speed: 0.4 },
    verify: { quality: 0.35, reliability: 0.25, speed: 0.4 },
    fast: { quality: 0.1, reliability: 0.2, speed: 0.7 },
  },
})

export const VARIANT_PREFERENCES = Object.freeze({
  plan: {
    quality: ["high", "xhigh", "max", "medium", "low", "minimal", "none"],
    balanced: ["medium", "high", "low", "xhigh", "max", "minimal", "none"],
    fast: ["low", "minimal", "none", "medium", "high"],
  },
  build: {
    quality: ["high", "medium", "xhigh", "max", "low", "minimal", "none"],
    balanced: ["medium", "low", "high", "minimal", "none", "xhigh"],
    fast: ["low", "minimal", "none", "medium", "high"],
  },
  verify: {
    quality: ["high", "xhigh", "max", "medium", "low", "minimal", "none"],
    balanced: ["medium", "high", "low", "xhigh", "max", "minimal", "none"],
    fast: ["low", "minimal", "none", "medium", "high"],
  },
  fast: {
    quality: ["low", "medium", "minimal", "none", "high"],
    balanced: ["low", "minimal", "none", "medium", "high"],
    fast: ["none", "minimal", "low", "medium", "high"],
  },
})

export const FORBIDDEN_AGENTS = new Set([
  "title",
  "summary",
  "compaction",
])

export const RELAY_ROLE_MAP = Object.freeze({
  orchestrator: "fast",
  planner: "plan",
  implementer: "build",
  verifier: "verify",
  watcher: "verify",
})
