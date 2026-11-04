import { createHash } from "node:crypto"
import { VARIANT_PREFERENCES } from "./constants.js"

export function modelKey(model) {
  const variant = typeof model === "string" ? "" : model.variant
  const providerID = typeof model === "string" ? "" : model.providerID
  const id = typeof model === "string" ? model : model.id || model.modelID
  if (typeof model === "string") return normalizeKey(model)
  const base = `${providerID}/${id}`
  return variant ? `${base}#${variant}` : base
}

export function normalizeKey(key) {
  const value = String(key || "").trim()
  if (!value) return value
  const hash = value.lastIndexOf("#")
  if (hash === -1) return value
  const base = value.slice(0, hash)
  const variant = value.slice(hash + 1)
  return variant ? `${base}#${variant}` : base
}

export function parseKey(key) {
  const normalized = normalizeKey(key)
  if (!normalized) return undefined
  const hash = normalized.indexOf("#")
  const base = hash === -1 ? normalized : normalized.slice(0, hash)
  const variant = hash === -1 ? undefined : normalized.slice(hash + 1)
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) return undefined
  return {
    providerID: base.slice(0, slash),
    id: base.slice(slash + 1),
    ...(variant ? { variant } : {}),
  }
}

export function baseKey(model) {
  return `${model.providerID}/${model.id || model.modelID}`
}

export function isZeroCost(model) {
  const costs = Array.isArray(model?.cost) ? model.cost : []
  if (costs.length === 0) return false
  return costs.every(
    (tier) =>
      Number(tier?.input) === 0 &&
      Number(tier?.output) === 0 &&
      Number(tier?.cache?.read ?? 0) === 0 &&
      Number(tier?.cache?.write ?? 0) === 0,
  )
}

export function variantIds(model) {
  const seen = new Set()
  const result = []
  for (const variant of Array.isArray(model?.variants) ? model.variants : []) {
    const id = typeof variant === "string" ? variant : variant?.id
    if (typeof id === "string" && id && !seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

export function selectVariant(model, role, profile = "balanced") {
  const ids = variantIds(model)
  if (ids.length === 0) return undefined
  const preferences = VARIANT_PREFERENCES[role]?.[profile] || VARIANT_PREFERENCES.build.balanced
  return preferences.find((id) => ids.includes(id))
}

export function modelObject(record) {
  return {
    providerID: record.providerID,
    id: record.id,
    name: record.name,
    variant: record.variant,
    key: modelKey(record),
    capabilities: record.capabilities || { tools: true, input: ["text"], output: ["text"] },
    limit: record.limit || { context: 0, output: 0 },
    cost: record.cost || [],
    status: record.status || "active",
    released: record.released || 0,
  }
}

export function normalizeModel(model) {
  const id = model.id || model.modelID
  if (!id || !model.providerID) return undefined
  const costs = Array.isArray(model.cost) ? model.cost : []
  return {
    providerID: String(model.providerID),
    id: String(id),
    name: model.name || id,
    type: model.type || "chat",
    enabled: model.enabled !== false,
    status: model.status || "active",
    released: Number(model.time?.released || model.released || 0),
    capabilities: {
      tools: model.capabilities?.tools !== false,
      input: Array.isArray(model.capabilities?.input) ? model.capabilities.input.map(String) : ["text"],
      output: Array.isArray(model.capabilities?.output) ? model.capabilities.output.map(String) : ["text"],
    },
    variants: variantIds(model),
    limit: {
      context: Number(model.limit?.context || 0),
      input: Number(model.limit?.input || model.limit?.context || 0),
      output: Number(model.limit?.output || 0),
    },
    cost: costs.map((tier) => ({
      input: Number(tier.input || 0),
      output: Number(tier.output || 0),
      cache: {
        read: Number(tier.cache?.read || 0),
        write: Number(tier.cache?.write || 0),
      },
      ...(tier.tier ? { tier: tier.tier } : {}),
    })),
    raw: undefined,
  }
}

export function catalogFromModels(models, settings, now = new Date()) {
  const providers = new Set(settings.providers)
  const allProviders = providers.has("*")
  const excludedProviders = new Set(settings.excludeProviders)
  const excluded = new Set(settings.excludeModels)
  const normalized = []
  const seen = new Set()
  for (const input of models || []) {
    const model = normalizeModel(input)
    if (!model) continue
    const key = baseKey(model)
    if (seen.has(key)) continue
    seen.add(key)
    if (excludedProviders.has(model.providerID)) continue
    if (!allProviders && !providers.has(model.providerID)) continue
    if (!model.enabled) continue
    if (model.type !== "chat") continue
    if (!model.capabilities.tools) continue
    if (!isZeroCost(model)) continue
    if (model.status === "deprecated") continue
    if (excluded.has(key)) continue
    normalized.push(model)
  }
  normalized.sort((a, b) => a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id))
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        normalized.map((model) => [
          model.providerID,
          model.id,
          model.status,
          model.capabilities,
          model.limit,
          model.cost,
          model.variants,
        ]),
      ),
    )
    .digest("hex")
  return {
    refreshedAt: now.toISOString(),
    fingerprint,
    models: normalized,
  }
}

export function modelChoices(catalog, role, profile = "balanced", requirements = {}) {
  const choices = []
  for (const model of catalog.models || []) {
    if (requirements.needsVision && !model.capabilities.input.some((item) => item.startsWith("image"))) continue
    const variant = selectVariant(model, role, profile)
    choices.push(
      modelObject({
        ...model,
        variant,
      }),
    )
  }
  return choices
}

export function modelByBaseKey(catalog, providerID, id) {
  return (catalog.models || []).find((model) => model.providerID === providerID && model.id === id)
}

export function catalogFingerprintChanged(state, catalog) {
  return state?.catalog?.fingerprint !== catalog.fingerprint
}
