import type { ODataExplorerGenerationFailure, ODataProxyConfig } from '@me-tools/odx-core'
import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import { join } from 'pathe'
import { enforceExplorerEndpointPolicy, isProductionExplorerRuntime } from '../utils/explorer-policy'
import { refreshRuntimeMetadata, sanitizeMetadataFailureReason } from '../utils/metadata-refresh'

export default defineEventHandler(async (event) => {
  enforceExplorerEndpointPolicy(event, 'generate')
  if (event.method !== 'POST') {
    setHeader(event, 'Allow', 'POST')
    throw createError({ statusCode: 405, statusMessage: 'Metadata refresh and SDK generation require POST' })
  }

  const config = event.context.odataConfig as ODataProxyConfig
  const query = getQuery(event)
  const serviceName = (query.service as string) ?? ''

  if (!serviceName) {
    throw createError({ statusCode: 400, statusMessage: 'Missing service name' })
  }

  const services = config.services ?? []
  const matched = services.find(s => s.name === serviceName)

  if (!matched) {
    throw createError({ statusCode: 404, statusMessage: `Service ${serviceName} not found` })
  }

  const buildDir = config.buildDir ?? ''
  const outRoot = join(buildDir, 'odx', 'generated')
  const outDir = join(outRoot, matched.name)

  try {
    const metadata = await refreshRuntimeMetadata(event, config, matched)

    const generate = event.context.odataGenerator
    if (isProductionExplorerRuntime() || typeof generate !== 'function') {
      return {
        success: true,
        operation: 'metadata-refresh',
        generated: false,
        stale: metadata.stale,
        staleReason: metadata.staleReason,
        message: metadata.stale
          ? `Refreshed ${matched.name} runtime metadata from cached metadata (${metadata.staleReason})`
          : `Refreshed ${matched.name} runtime metadata`,
        service: matched.name,
        timestamp: metadata.timestamp,
        refreshedAt: metadata.refreshedAt,
        hash: metadata.hash,
        bytes: metadata.bytes,
        source: metadata.source,
      }
    }

    try {
      await generate(metadata.inputPath, outDir, matched.name)
    }
    catch (error) {
      throw createError({
        statusCode: 500,
        statusMessage: 'SDK generation failed after metadata refresh',
        data: {
          success: false,
          operation: 'sdk-generation',
          generated: false,
          metadataRefreshed: true,
          service: matched.name,
          error: error instanceof Error ? error.message : String(error),
          stale: metadata.stale,
          staleReason: metadata.staleReason,
          timestamp: metadata.timestamp,
          refreshedAt: metadata.refreshedAt,
          hash: metadata.hash,
          bytes: metadata.bytes,
          source: metadata.source,
        } satisfies ODataExplorerGenerationFailure,
      })
    }

    return {
      success: true,
      operation: 'sdk-generation',
      generated: true,
      stale: metadata.stale,
      staleReason: metadata.staleReason,
      message: metadata.stale
        ? `Generated ${matched.name} from cached metadata (SAP unreachable: ${metadata.staleReason})`
        : `Generated ${matched.name} successfully`,
      service: matched.name,
      timestamp: metadata.timestamp,
      refreshedAt: metadata.refreshedAt,
      hash: metadata.hash,
      bytes: metadata.bytes,
      source: metadata.source,
    }
  }
  catch (err: unknown) {
    const error = err as any
    if (error.statusCode) {
      throw error
    }

    const message = error.message || String(error)
    const isProduction = isProductionExplorerRuntime()
    const publicMessage = isProduction ? sanitizeMetadataFailureReason(error) : message
    const failureLabel = isProduction ? 'Metadata refresh failed' : 'Generation failed'
    console.error(`[ODX] Generation failed for ${serviceName}:`, message)

    throw createError({
      statusCode: 500,
      statusMessage: `${failureLabel}: ${publicMessage}`,
      data: { error: publicMessage },
    })
  }
})
