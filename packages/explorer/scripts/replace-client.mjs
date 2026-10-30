import { mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Keep the recognized previous client recoverable until the new one is placed. */
export async function replaceExplorerClient(staging, destination, hasPrevious, move = rename) {
  if (!hasPrevious) {
    await move(staging, destination)
    return
  }
  const backup = await mkdtemp(join(dirname(destination), '.client-backup-'))
  const previous = join(backup, 'client')
  let retainBackup = false
  try {
    await move(destination, previous)
    try {
      await move(staging, destination)
    }
    catch (error) {
      try {
        await move(previous, destination)
      }
      catch (restoreError) {
        retainBackup = true
        throw new AggregateError([error, restoreError], `Client replacement and rollback failed. Previous client retained at ${previous}.`)
      }
      throw error
    }
  }
  finally {
    // A failed rollback must preserve the only copy of the previous client.
    if (!retainBackup)
      await rm(backup, { recursive: true, force: true })
  }
}
