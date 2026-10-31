import type { onDevtoolsReady } from '@nuxt/devtools-kit'
import type { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { consola } from 'consola'

export type ExplorerDevtoolsContext = Parameters<Parameters<typeof onDevtoolsReady>[0]>[0]
type TerminalSession = Awaited<ReturnType<ExplorerDevtoolsContext['terminals']['startChildProcess']>>
const RE_LOCAL_URL = /http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)(?=\/|\s)/

interface ContributorRun {
  owner: ExplorerDevtoolsContext
  abort: AbortController
  session?: TerminalSession
  task?: Promise<string>
  removal?: Promise<void>
  termination?: Promise<void>
  ready?: boolean
  cancelled?: boolean
}

export interface ExplorerContributor {
  start: () => Promise<string>
  current: () => Promise<string> | undefined
  stop: () => Promise<void>
  dispose: () => Promise<void>
}

/** One lazy terminal-owned client per Nuxt application, never per HTTP request. */
export function createExplorerContributor(options: {
  directory: string
  baseURL: string
  apiBase: string
  context: () => ExplorerDevtoolsContext | undefined
  onStopped: () => void
}): ExplorerContributor {
  let active: ContributorRun | undefined
  let failedRun: ContributorRun | undefined
  let stopping: Promise<void> | undefined
  let disposed = false
  let workspace: Promise<string> | undefined
  const temporaryParent = resolve(tmpdir())

  function hasEnded(run: ContributorRun): boolean {
    const session = run.session
    if (!session)
      return false
    const result = session.getResult()
    return session.status !== 'running' || result.killed || result.exitCode !== undefined
  }

  function remove(run: ContributorRun): Promise<void> {
    const session = run.session
    if (!session)
      return Promise.resolve()
    return run.removal ||= (async () => {
      try {
        await terminate(run)
      }
      finally {
        run.owner.terminals.remove(session)
      }
    })()
  }

  function terminate(run: ContributorRun): Promise<void> {
    return run.termination ||= Promise.resolve(run.session?.terminate()).then(() => undefined)
  }

  async function removeFailed(): Promise<void> {
    const run = failedRun
    if (!run)
      return
    await remove(run)
    if (failedRun === run)
      failedRun = undefined
  }

  async function launch(run: ContributorRun): Promise<string> {
    const signal = AbortSignal.any([run.abort.signal, AbortSignal.timeout(120_000)])
    try {
      const require = createRequire(join(options.directory, 'package.json'))
      const cli = join(dirname(require.resolve('nuxt/package.json')), 'bin', 'nuxt.mjs')
      const buildDirectory = await (workspace ||= mkdtemp(join(temporaryParent, 'odx-explorer-dev-')))
      signal.throwIfAborted()
      run.session = await run.owner.terminals.startChildProcess({
        command: process.execPath,
        args: [cli, 'dev', '--host', '127.0.0.1', '--port', '0'],
        cwd: options.directory,
        env: {
          NUXT_TELEMETRY_DISABLED: '1',
          NUXT_APP_BASE_URL: options.baseURL,
          // The host mount may itself begin with /_nuxt/. Give this child a
          // distinct asset prefix so Nuxt's asset-only 404 guard does not
          // reject the child's application document before Nitro renders it.
          NUXT_APP_BUILD_ASSETS_DIR: '/_odx_assets/',
          ODX_EXPLORER_BUILD_DIR: buildDirectory,
          ODX_EXPLORER_CLIENT_BASE: options.baseURL,
          NUXT_PUBLIC_ODX_API_BASE: options.apiBase,
          ODX_API_BASE: options.apiBase,
          ODX_EXPLORER_API_PROXY_TARGET: '',
        },
      }, {
        id: 'odx:client',
        title: 'ODX Explorer Dev',
        icon: 'lucide:cable',
        restartable: false,
      })
      run.abort.signal.throwIfAborted()
      const session = run.session
      const onExit = async (error: unknown): Promise<void> => {
        run.abort.abort(error)
        if (active !== run || !run.ready)
          return
        try {
          await stop(true)
        }
        finally {
          if (!disposed && !active)
            options.onStopped()
        }
      }
      void Promise.resolve(session.getResult()).then(
        ({ exitCode }) => onExit(new Error(`The ODX Explorer process exited (${exitCode ?? 'terminated'}).`)),
        onExit,
      ).catch(error => consola.warn('[ODX] Contributor process cleanup failed.', error))
      const origin = await announcedOrigin(session, signal)
      // The listener announcement precedes compilation. Wait for the actual
      // Nuxt app rather than replacing the launcher with a startup document.
      while (true) {
        signal.throwIfAborted()
        try {
          const response = await fetch(`${origin}${options.baseURL}`, { signal, redirect: 'error' })
          const html = await response.text()
          if (response.ok && html.includes('window.__NUXT__.config='))
            break
        }
        catch (error) {
          signal.throwIfAborted()
          if (!(error instanceof TypeError))
            throw error
        }
        await setTimeout(100, undefined, { signal })
      }
      run.abort.signal.throwIfAborted()
      run.ready = true
      return origin
    }
    catch (error) {
      const failure = signal.aborted ? signal.reason : error
      try {
        await terminate(run)
        if (!disposed && !run.cancelled)
          failedRun = run
      }
      finally {
        if (disposed || run.cancelled || failedRun !== run)
          await remove(run)
        if (active === run)
          active = undefined
      }
      throw failure
    }
  }

  function start(): Promise<string> {
    if (disposed)
      return Promise.reject(new Error('The ODX contributor host is closed.'))
    if (stopping)
      return stopping.then(start)
    if (failedRun)
      return removeFailed().then(start)
    if (active && hasEnded(active))
      return stop().then(start)
    if (active?.task)
      return active.task
    const owner = options.context()
    if (!owner)
      return Promise.reject(new Error('The repository Explorer requires an active Nuxt DevTools v4 host.'))
    const run: ContributorRun = { owner, abort: new AbortController() }
    active = run
    run.task = launch(run)
    return run.task
  }

  function stop(retainTerminal = false): Promise<void> {
    const run = active
    if (!run)
      return (stopping || Promise.resolve()).then(removeFailed)
    active = undefined
    run.cancelled = true
    run.abort.abort(new Error('The ODX contributor host was stopped.'))
    const task = (async () => {
      // A failed terminate must not bypass a late process-creation cleanup.
      await Promise.allSettled([retainTerminal ? terminate(run) : remove(run), run.task])
      if (retainTerminal && !disposed)
        failedRun = run
      else
        await remove(run)
    })()
    stopping = task
    void task.finally(() => {
      if (stopping === task)
        stopping = undefined
    }).catch(() => undefined)
    return task
  }

  return {
    start,
    current: () => disposed || stopping || (active && hasEnded(active)) ? undefined : active?.task,
    stop,
    async dispose(): Promise<void> {
      disposed = true
      await stop()
      await removeFailed()
      if (workspace) {
        const owned = await workspace
        if (dirname(resolve(owned)) !== temporaryParent)
          throw new Error('Unexpected Explorer development workspace; cleanup refused.')
        await rm(owned, { recursive: true, force: true })
      }
    },
  }
}

function announcedOrigin(session: TerminalSession, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = session.getChildProcess()
    let output = session.buffer?.join('') || ''
    function cleanup(): void {
      child?.stdout?.off('data', onData)
      child?.stderr?.off('data', onData)
      signal.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      cleanup()
      reject(signal.reason)
    }
    function onData(chunk: Buffer | string): void {
      output = `${output}${chunk.toString()}`.slice(-16_384)
      const match = stripVTControlCharacters(output).match(RE_LOCAL_URL)
      if (match) {
        cleanup()
        const port = Number(match[1])
        if (!Number.isInteger(port) || port < 1 || port > 65_535)
          reject(new Error('The ODX Explorer announced an invalid loopback port.'))
        else
          resolve(`http://127.0.0.1:${port}`)
      }
    }
    child?.stdout?.on('data', onData)
    child?.stderr?.on('data', onData)
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve(session.getResult()).then(({ exitCode }) => {
      cleanup()
      reject(new Error(`The ODX Explorer process exited before becoming ready (${exitCode ?? 'terminated'}).`))
    }, (error: unknown) => {
      cleanup()
      reject(error)
    })
    if (signal.aborted)
      onAbort()
    else
      onData('')
  })
}
