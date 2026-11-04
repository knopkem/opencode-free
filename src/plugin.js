import { Plugin } from "@opencode/plugin"
import { FORBIDDEN_AGENTS } from "./constants.js"
import { baseKey, catalogFromModels, modelKey } from "./catalog.js"
import { classifyError, recordFailure, recordSuccess } from "./health.js"
import {
  chooseRoutes,
  isFreeSelectedModel,
  retryCandidates,
  roleForAgent,
  selectExplorationCandidate,
} from "./router.js"
import {
  appendDecision,
  loadProbes,
  loadSettings,
  loadState,
  updateState,
} from "./state.js"
import { watchResponse } from "./watchdog.js"

const SWITCHABLE = new Set([
  "rate_limit",
  "quota",
  "timeout",
  "transport",
  "server",
  "invalid_output",
  "invalid_request",
  "unsupported",
  "no_route",
  "content_filter",
  "unknown",
])

export const OpenCodeFreePlugin = Plugin.define({
  id: "opencode-free",
  async setup(ctx) {
    const managed = new Set()
    const manualSelections = new Set()
    const authorizedModels = new Map()
    const attempts = new Map()
    const prompts = new Map()
    const requests = new Map()
    const explorationChoices = new Map()
    const catalogCache = { at: 0, value: undefined }
    let disposed = false
    const abort = new AbortController()

    const clearSessionRouting = (sessionID) => {
      managed.delete(sessionID)
      authorizedModels.delete(sessionID)
      attempts.delete(sessionID)
      prompts.delete(sessionID)
      explorationChoices.delete(sessionID)
    }

    const markManualSelection = (sessionID) => {
      manualSelections.add(sessionID)
      clearSessionRouting(sessionID)
    }

    const switchModel = async (sessionID, candidate) => {
      const key = modelKey(candidate)
      authorizedModels.set(sessionID, key)
      try {
        await ctx.session.switchModel({
          sessionID,
          model: {
            providerID: candidate.providerID,
            id: candidate.id,
            ...(candidate.variant ? { variant: candidate.variant } : {}),
          },
        })
      } catch (error) {
        if (authorizedModels.get(sessionID) === key) authorizedModels.delete(sessionID)
        throw error
      }
    }

    const refreshCatalog = async (settings, force = false) => {
      if (!force && catalogCache.value && Date.now() - catalogCache.at < 60_000) return catalogCache.value
      const result = await ctx.model.list({ types: ["chat"] })
      const catalog = catalogFromModels(result.data, settings)
      catalogCache.at = Date.now()
      catalogCache.value = catalog
      return catalog
    }

    const rememberDecision = async (decision) => {
      await updateState((state) => {
        appendDecision(state, {
          ...decision,
          at: new Date().toISOString(),
        })
        if (decision.candidate?.key) {
          state.routingCounts ||= {}
          state.routingCounts[decision.candidate.key] =
            Number(state.routingCounts[decision.candidate.key] || 0) + 1
          if (decision.reason === "explore_unmapped") {
            state.exploration ||= {}
            state.exploration[decision.candidate.key] = new Date().toISOString()
          }
        }
        return state
      }).catch((error) => {
        console.error("opencode-free: failed to persist routing decision", error)
      })
    }

    const persistCatalog = async (catalog) => {
      await updateState((state) => {
        if (state.catalog?.fingerprint === catalog.fingerprint) return state
        state.catalog = catalog
        return state
      }).catch((error) => {
        console.error("opencode-free: failed to persist model catalog", error)
      })
    }

    await ctx.session.hook("prompt", async (event) => {
      if (disposed || manualSelections.has(event.sessionID)) return
      try {
        const settings = await loadSettings()
        if (!settings.auto) return
        const session = await ctx.session.get({ sessionID: event.sessionID })
        if (!session || FORBIDDEN_AGENTS.has(String(session.agent || ""))) return
        const authorized = authorizedModels.get(event.sessionID)
        const selected = session.model ? modelKey(session.model) : undefined
        if (authorized && selected && authorized !== selected) {
          markManualSelection(event.sessionID)
          return
        }
        const catalog = await refreshCatalog(settings)
        if (!catalog.models.length) return
        if (session.model && !isFreeSelectedModel(session.model, catalog)) {
          markManualSelection(event.sessionID)
          return
        }
        const role = roleForAgent(session.agent)
        const [state, probes] = await Promise.all([loadState(), loadProbes()])
        const remembered = explorationChoices.get(event.sessionID)
        let forcedKey = remembered?.role === role ? remembered.key : undefined
        if (
          forcedKey &&
          !catalog.models.some((model) => baseKey(model) === forcedKey.replace(/#.*$/, ""))
        ) {
          explorationChoices.delete(event.sessionID)
          forcedKey = undefined
        }
        if (
          !forcedKey &&
          !remembered &&
          !managed.has(event.sessionID) &&
          !authorizedModels.has(event.sessionID)
        ) {
          forcedKey = selectExplorationCandidate({
            catalog,
            state,
            settings,
            role,
            prompt: event.prompt,
          })
        }
        const forcedKeys = forcedKey ? { [role]: forcedKey } : {}
        const routed = chooseRoutes({
          catalog,
          state,
          probes,
          settings,
          role,
          prompt: event.prompt,
          current: session.model,
          forcedKeys,
        })
        const result = routed.roles[role]
        if (!result.candidate) {
          await rememberDecision({
            type: "prompt",
            sessionID: event.sessionID,
            agent: session.agent,
            role,
            reason: result.decision.reason,
            decision: result.decision,
          })
          return
        }
        managed.add(event.sessionID)
        prompts.set(event.sessionID, event.prompt)
        if (result.decision.reason === "explore_unmapped") {
          explorationChoices.set(event.sessionID, {
            role,
            key: modelKey(result.candidate),
          })
        } else if (forcedKey) {
          explorationChoices.delete(event.sessionID)
        }
        attempts.set(event.sessionID, {
          keys: [modelKey(result.candidate)],
          lastAttempt: 0,
        })
        if (session.model && modelKey(session.model) === modelKey(result.candidate)) {
          authorizedModels.set(event.sessionID, modelKey(result.candidate))
          await persistCatalog(catalog)
          return
        }
        await switchModel(event.sessionID, result.candidate)
        await persistCatalog(catalog)
        await rememberDecision({
          type: "prompt",
          sessionID: event.sessionID,
          agent: session.agent,
          role,
          previous: session.model ? modelKey(session.model) : undefined,
          candidate: result.candidate,
          reason: result.decision.reason,
          decision: result.decision,
          alternatives: (result.alternatives || []).slice(0, 3),
        })
      } catch (error) {
        console.error("opencode-free: prompt routing failed", error)
      }
    })

    await ctx.session.hook("retry", async (event) => {
      if (disposed || !managed.has(event.sessionID)) return
      try {
        const settings = await loadSettings()
        if (!settings.auto) {
          managed.delete(event.sessionID)
          return
        }
        const kind = classifyError(event.error)
        if (!SWITCHABLE.has(kind)) return
        const catalog = await refreshCatalog(settings)
        const session = await ctx.session.get({ sessionID: event.sessionID })
        if (!session || FORBIDDEN_AGENTS.has(String(session.agent || ""))) return
        const role = roleForAgent(session.agent)
        const currentKey = modelKey(event.model)
        let attempt = attempts.get(event.sessionID)
        if (!attempt || event.attempt <= attempt.lastAttempt) {
          attempt = { keys: [], lastAttempt: 0 }
          attempts.set(event.sessionID, attempt)
        }
        attempt.lastAttempt = Math.max(attempt.lastAttempt || 0, event.attempt)
        if (!attempt.keys.includes(currentKey)) attempt.keys.push(currentKey)

        let failure
        const state = await updateState((draft) => {
          failure = recordFailure(draft, currentKey, event.error, settings)
          return draft
        })
        const probes = await loadProbes()
        if (explorationChoices.get(event.sessionID)?.key === currentKey) {
          explorationChoices.delete(event.sessionID)
        }
        const exhausted = attempt.keys.length > settings.maxFailovers
        const result = exhausted
          ? { candidate: undefined, decision: { reason: "failover_limit" } }
          : retryCandidates({
              catalog,
              state,
              probes,
              settings,
              role,
              prompt: prompts.get(event.sessionID),
              exclude: attempt.keys,
            })

        if (!result.candidate) {
          event.decision = { retry: false }
          await rememberDecision({
            type: "retry",
            sessionID: event.sessionID,
            agent: session.agent,
            role,
            failed: currentKey,
            failureKind: failure?.kind || kind,
            failureScope: failure?.scope,
            providerID: failure?.providerID,
            reason: result.decision?.reason || "exhausted",
            cooldownUntil: failure?.cooldownUntil
              ? new Date(failure.cooldownUntil).toISOString()
              : undefined,
            providerCooldownUntil:
              failure?.scope === "provider" && failure?.cooldownUntil
                ? new Date(failure.cooldownUntil).toISOString()
                : undefined,
            decision: result.decision,
          })
          return
        }

        attempt.keys.push(modelKey(result.candidate))
        await switchModel(event.sessionID, result.candidate)
        event.decision = { retry: true, delay: 50 }
        await rememberDecision({
          type: "retry",
          sessionID: event.sessionID,
          agent: session.agent,
          role,
          failed: currentKey,
          failureKind: failure?.kind || kind,
          failureScope: failure?.scope,
          providerID: failure?.providerID,
          candidate: result.candidate,
          reason: "failover",
          decision: result.decision,
          alternatives: (result.alternatives || []).slice(0, 3),
        })
      } catch (error) {
        console.error("opencode-free: retry routing failed", error)
      }
    })

    await ctx.session.hook("http.request", async (event) => {
      if (disposed || !managed.has(event.sessionID) || event.kind !== "primary") return
      requests.set(event.sessionID, {
        key: modelKey(event.model),
        startedAt: Date.now(),
        headersAt: undefined,
        firstOutputAt: undefined,
      })
    })

    await ctx.session.hook("http.response", async (event) => {
      if (disposed || !managed.has(event.sessionID) || event.kind !== "primary") return
      const current = requests.get(event.sessionID)
      if (!current) return
      current.headersAt = Date.now()
      current.status = event.response.status
      if (event.response.ok) {
        try {
          const settings = await loadSettings()
          event.response = watchResponse(event.response, settings.slow)
        } catch (error) {
          console.error("opencode-free: could not arm slow-response watchdog", error)
        }
      }
    })

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: abort.signal,
          types: [
            "session.text.started",
            "session.reasoning.started",
            "session.tool.input.started",
            "session.step.ended",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.idle",
            "session.deleted",
            "session.model.selected",
          ],
        })) {
          if (disposed) return
          const data = event.data || {}
          const sessionID = data.sessionID
          if (!sessionID) continue
          if (
            event.type === "session.text.started" ||
            event.type === "session.reasoning.started" ||
            event.type === "session.tool.input.started"
          ) {
            const request = requests.get(sessionID)
            if (request && request.firstOutputAt === undefined) request.firstOutputAt = Date.now()
            continue
          }
          if (event.type === "session.step.ended") {
            const request = requests.get(sessionID)
            requests.delete(sessionID)
            if (!request || !managed.has(sessionID)) continue
            const completedAt = Date.now()
            const output = Number(data.tokens?.output || 0)
            const reasoning = Number(data.tokens?.reasoning || 0)
            const generationStart = request.firstOutputAt || request.headersAt || request.startedAt
            const activeMs = completedAt - generationStart
            const metrics = {
              ttftMs:
                (request.firstOutputAt || request.headersAt)
                  ? (request.firstOutputAt || request.headersAt) - request.startedAt
                  : undefined,
              durationMs: completedAt - request.startedAt,
              tps: output + reasoning > 0 && activeMs > 0 ? ((output + reasoning) / activeMs) * 1000 : undefined,
              outputTokens: output,
              reasoningTokens: reasoning,
            }
            await updateState((state) => {
              const health = recordSuccess(state, request.key, metrics)
              state.routingCounts ||= {}
              state.lastSuccess = {
                at: new Date().toISOString(),
                sessionID,
                key: request.key,
                ...metrics,
                state: health.state,
              }
              return state
            }).catch((error) => console.error("opencode-free: failed to record success", error))
            continue
          }
          if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted" ||
            event.type === "session.idle" ||
            event.type === "session.deleted"
          ) {
            requests.delete(sessionID)
            if (event.type === "session.execution.succeeded" || event.type === "session.idle") {
              attempts.delete(sessionID)
            }
            if (event.type === "session.deleted") {
              manualSelections.delete(sessionID)
              clearSessionRouting(sessionID)
            } else if (
              event.type === "session.idle" ||
              event.type === "session.execution.failed" ||
              event.type === "session.execution.interrupted"
            ) {
              managed.delete(sessionID)
              prompts.delete(sessionID)
            }
            continue
          }
          if (event.type === "session.model.selected" && data.model) {
            const selected = modelKey(data.model)
            if (authorizedModels.get(sessionID) !== selected) {
              markManualSelection(sessionID)
            }
          }
        }
      } catch (error) {
        if (!abort.signal.aborted && !disposed) {
          console.error("opencode-free: event subscription failed", error)
        }
      }
    })()

    return () => {
      disposed = true
      abort.abort()
    }
  },
})

export default OpenCodeFreePlugin
