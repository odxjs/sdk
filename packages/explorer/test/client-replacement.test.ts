import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replaceExplorerClient } from '../scripts/replace-client.mjs'

const failRename = new Set<string>()
const failTarget = new Set<string>()
async function moveWithLocks(...[source, target]: Parameters<typeof rename>): Promise<void> {
  if (failRename.has(String(source)) || failTarget.has(String(target)))
    throw new Error(`Simulated locked directory: ${source}`)
  await rename(source, target)
}

let directory: string | undefined
afterEach(async () => {
  failRename.clear()
  failTarget.clear()
  if (directory)
    await rm(directory, { recursive: true, force: true })
  directory = undefined
})
async function fixture(): Promise<{ current: string, staging: string }> {
  directory = await mkdtemp(join(tmpdir(), 'odx-client-replacement-'))
  const current = join(directory, 'client')
  const staging = join(directory, 'staging')
  await mkdir(current)
  await mkdir(staging)
  await writeFile(join(current, 'index.html'), 'previous client')
  await writeFile(join(staging, 'index.html'), 'new client')
  return { current, staging }
}

describe('generated client replacement under Windows directory locks', () => {
  it('restores the previous usable client when placing the new directory fails', async () => {
    const { current, staging } = await fixture()
    failRename.add(staging)
    await expect(replaceExplorerClient(staging, current, true, moveWithLocks)).rejects.toThrow('Simulated locked directory')
    expect(await readFile(join(current, 'index.html'), 'utf8')).toBe('previous client')
    expect(await readFile(join(staging, 'index.html'), 'utf8')).toBe('new client')
    expect(await readdir(directory!)).toEqual(['client', 'staging'])
  })

  it('preserves the current client if it cannot be moved to a backup', async () => {
    const { current, staging } = await fixture()
    failRename.add(current)
    await expect(replaceExplorerClient(staging, current, true, moveWithLocks)).rejects.toThrow('Simulated locked directory')
    expect(await readFile(join(current, 'index.html'), 'utf8')).toBe('previous client')
    expect(await readdir(directory!)).toEqual(['client', 'staging'])
  })

  it('replaces a recognized client without leaving a backup behind', async () => {
    const { current, staging } = await fixture()
    await replaceExplorerClient(staging, current, true)
    expect(await readFile(join(current, 'index.html'), 'utf8')).toBe('new client')
    expect(await readdir(directory!)).toEqual(['client'])
  })

  it('retains a recoverable previous client when both placement and rollback are locked', async () => {
    const { current, staging } = await fixture()
    failTarget.add(current)
    await expect(replaceExplorerClient(staging, current, true, moveWithLocks)).rejects.toThrow('Previous client retained at')
    const backups = (await readdir(directory!)).filter(name => name.startsWith('.client-backup-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(directory!, backups[0]!, 'client/index.html'), 'utf8')).toBe('previous client')
  })
})
