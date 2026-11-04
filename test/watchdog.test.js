import test from "node:test"
import assert from "node:assert/strict"
import { watchResponse } from "../src/watchdog.js"

test("passes response bytes through unchanged", async () => {
  const original = new Response("hello world", { status: 200 })
  const watched = watchResponse(original, { firstChunkMs: 1_000, idleChunkMs: 1_000 })
  assert.equal(await watched.text(), "hello world")
  assert.equal(watched.status, 200)
})

test("fails a response that never starts streaming", async () => {
  let timer
  const body = new ReadableStream({
    start(controller) {
      timer = setTimeout(() => controller.enqueue(new TextEncoder().encode("late")), 1_000)
    },
    cancel() {
      clearTimeout(timer)
    },
  })
  const watched = watchResponse(new Response(body), { firstChunkMs: 20, idleChunkMs: 20 })
  await assert.rejects(() => watched.text(), /stalled for 1s/)
})

test("does not wrap error responses", () => {
  const response = new Response("rate limited", { status: 429 })
  assert.equal(watchResponse(response, { firstChunkMs: 1, idleChunkMs: 1 }), response)
})
