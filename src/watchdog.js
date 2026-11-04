/**
 * Replaces a model response body with one that fails when no bytes arrive within
 * the configured first-chunk or inter-chunk deadline. OpenCode's retry hook then
 * moves the session to the next healthy model.
 */
export function watchResponse(response, { firstChunkMs, idleChunkMs } = {}) {
  if (!response?.body || !response.ok) return response
  const firstLimit = positive(firstChunkMs)
  const idleLimit = positive(idleChunkMs)
  if (!firstLimit && !idleLimit) return response

  const reader = response.body.getReader()
  let timer
  let controllerRef
  let finished = false

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const fail = (limit) => {
    if (finished) return
    finished = true
    clear()
    const error = new Error(`opencode-free: model response stalled for ${Math.max(1, Math.round(limit / 1000))}s`)
    error.code = "TIMEOUT"
    try {
      controllerRef?.error(error)
    } catch {
      // The consumer may already have cancelled the stream.
    }
    reader.cancel(error).catch(() => {})
  }
  const arm = (limit) => {
    clear()
    if (!limit) return
    timer = setTimeout(() => fail(limit), limit)
    timer.unref?.()
  }

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller
      arm(firstLimit)
    },
    async pull(controller) {
      if (finished) return
      try {
        const result = await reader.read()
        if (finished) return
        if (result.done) {
          finished = true
          clear()
          controller.close()
          return
        }
        arm(idleLimit)
        controller.enqueue(result.value)
      } catch (error) {
        if (finished) return
        finished = true
        clear()
        controller.error(error)
      }
    },
    cancel(reason) {
      finished = true
      clear()
      return reader.cancel(reason)
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}
