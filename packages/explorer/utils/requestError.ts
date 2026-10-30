function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim())
    return value.trim()
  if (isRecord(value) && typeof value.value === 'string')
    return readMessage(value.value)
}

export class ExplorerRequestError extends Error {
  readonly conflict: boolean

  constructor(readonly status: number, detail: string) {
    const conflict = status === 409 || status === 412 || status === 428
    super(conflict
      ? `Request conflict (HTTP ${status}). Reload data before retrying. ${detail}`
      : `Request failed (HTTP ${status}). ${detail}`)
    this.name = 'ExplorerRequestError'
    this.conflict = conflict
  }
}

/** Decode V2/V4 and proxy-buffer errors without turning JSON into UI markup. */
export async function readExplorerRequestError(response: Response): Promise<ExplorerRequestError> {
  const text = await response.text().catch(() => '')
  let detail = response.statusText
  try {
    const body: unknown = JSON.parse(text)
    if (isRecord(body)) {
      const data = isRecord(body.data) ? body.data : undefined
      const error = isRecord(body.error) ? body.error : data && isRecord(data.error) ? data.error : undefined
      detail = readMessage(error?.message) ?? readMessage(body.message) ?? readMessage(body.statusMessage)
        ?? readMessage(data?.statusMessage) ?? detail
    }
  }
  catch {
    if (text && text.length < 200)
      detail = text
  }
  return new ExplorerRequestError(response.status, detail)
}
