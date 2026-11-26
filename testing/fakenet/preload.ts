/**
 * Loaded with `node --import` into the real chainer process: replaces fetch with the fake network
 * (answer.ts) for the world in CHAINER_FAKE_WORLD, logging to CHAINER_FAKE_LOG.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { fakeNetwork } from './answer.ts'
import type { World } from './world.ts'

const world = JSON.parse(readFileSync(process.env.CHAINER_FAKE_WORLD!, 'utf8')) as World
const net = fakeNetwork(world, (line) => appendFileSync(process.env.CHAINER_FAKE_LOG!, `${JSON.stringify(line)}\n`))

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return net(href, { method: init?.method, body: init?.body ? String(init.body) : undefined })
}) as typeof fetch
