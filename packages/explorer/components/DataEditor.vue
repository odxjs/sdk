<script setup lang="ts">
import type { EditorState } from '../composables/useODataState'
import { computed, onScopeDispose, watch } from 'vue'
import { buildEntityPreviewCacheKey, useSharedODataState } from '../composables/useODataState'
import { permitsExplorerDataMethod } from '../utils/capabilities'
import { assertExplorerKeyUnchanged, prepareExplorerUpdatePayload } from '../utils/recordIdentity'
import { ExplorerRequestError, readExplorerRequestError } from '../utils/requestError'

const emit = defineEmits(['refresh'])
const editor = defineModel<EditorState>('editor', { required: true })
const { config, selectedService, selectedEntity, setSessionHeaders, entityDataCache } = useSharedODataState()
const toast = useToast()

let validationTimeout: ReturnType<typeof setTimeout> | null = null
onScopeDispose(() => {
  if (validationTimeout)
    clearTimeout(validationTimeout)
})

const modeConfig = computed(() => {
  switch (editor.value.mode) {
    case 'create':
      return { title: 'Create Record', icon: 'i-lucide-plus', method: 'POST' }
    case 'update':
      return { title: 'Edit Record', icon: 'i-lucide-pencil', method: editor.value.target?.method ?? 'UPDATE' }
    case 'headers':
      return { title: 'Session Headers', icon: 'i-lucide-sliders-horizontal', method: 'CONFIG' }
    case 'request':
      return { title: 'Send Request', icon: 'i-lucide-send', method: editor.value.requestTarget?.method ?? 'REQUEST' }
    case 'response':
      return { title: 'Response Data', icon: 'i-lucide-terminal', method: editor.value.requestTarget?.method ?? 'REST' }
    case 'view':
    default:
      return { title: 'View Details', icon: 'i-lucide-eye', method: 'GET' }
  }
})

const RE_LINE_COL = /\(line (\d+) column (\d+)\)/

/**
 * Formats native JSON parse errors into a cleaner, human-readable string.
 */
function formatJsonError(err: Error): string {
  const msg = err.message
  const lineColMatch = msg.match(RE_LINE_COL)

  if (lineColMatch) {
    const cleanMsg = msg.split(' in JSON')[0]
    return `Invalid JSON: ${cleanMsg} (Line ${lineColMatch[1]}, Col ${lineColMatch[2]})`
  }

  return `Invalid JSON: ${msg.replace('in JSON ', '')}`
}

watch(
  () => editor.value.json,
  (newVal) => {
    if (validationTimeout) {
      clearTimeout(validationTimeout)
      validationTimeout = null
    }
    const draft = editor.value
    if (draft.mode === 'response')
      return
    if (draft.mode === 'view') {
      draft.error = null
      return
    }

    if (!newVal || newVal.trim() === '') {
      editor.value.error = 'Payload cannot be empty'
      return
    }

    try {
      JSON.parse(newVal)
      editor.value.error = null
    }
    catch (e: unknown) {
      validationTimeout = setTimeout(() => {
        if (editor.value === draft && draft.json === newVal)
          draft.error = formatJsonError(e as Error)
      }, 800)
    }
  },
  { immediate: true },
)

/**
 * Saves the current item or updates the session headers.
 * Executes the respective HTTP method based on the editor mode.
 */
async function saveItem() {
  const draft = editor.value
  if (draft.loading || draft.outcomeUnknown)
    return
  draft.loading = true
  draft.error = null
  draft.conflict = false
  let writeDispatched = false

  try {
    const payload = JSON.parse(draft.json)
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Payload must be a JSON object. No request was sent.')
    const intent = draft.target ?? draft.requestTarget
    if (intent) {
      const originalService = config.value.services.find(service => service.name === intent.serviceName)
      if (!permitsExplorerDataMethod(originalService, intent.method))
        throw new Error(`${intent.method} is unavailable under the current host service policy. No request was sent.`)
    }

    if (draft.mode === 'headers') {
      if (Object.values(payload).some(value => typeof value !== 'string'))
        throw new Error('Session header values must be strings.')
      if (!draft.headersServiceName)
        throw new Error('The original service is unavailable. No session headers were changed.')
      setSessionHeaders(draft.headersServiceName, payload)
      toast.add({
        title: 'Session headers updated',
        icon: 'i-lucide-settings',
        color: 'success',
      })
      draft.show = false
      if (selectedService.value?.name === draft.headersServiceName)
        emit('refresh')
      return
    }

    if (draft.mode === 'request') {
      const target = draft.requestTarget
      if (!target)
        throw new Error('The original request target is unavailable. No request was sent.')
      writeDispatched = true
      const res = await fetch(target.url, {
        method: target.method,
        headers: target.headers,
        ...(target.method === 'DELETE' ? {} : { body: JSON.stringify(payload) }),
      })
      if (!res.ok)
        throw await readExplorerRequestError(res)
      delete entityDataCache.value[buildEntityPreviewCacheKey(target.serviceName, target.entitySet)]
      const text = await res.text().catch(() => 'The request succeeded, but its response body could not be read.')
      let json = text
      try {
        json = JSON.stringify(JSON.parse(text), null, 2)
      }
      catch {}
      toast.add({ title: `${target.method} request succeeded (HTTP ${res.status})`, color: 'success' })
      if (editor.value === draft && draft.show) {
        draft.mode = 'response'
        draft.context = `${target.method} ${target.url} · HTTP ${res.status}`
        draft.json = json
      }
      if (selectedService.value?.name === target.serviceName && selectedEntity.value === target.entitySet)
        emit('refresh')
      return
    }

    if (draft.mode !== 'create' && draft.mode !== 'update')
      throw new Error('This editor does not send record mutations.')
    const target = draft.target
    if (!target)
      throw new Error(draft.targetError || 'The original mutation target is unavailable. No request was sent.')
    const updating = draft.mode === 'update'
    if ((updating && target.method !== 'PATCH' && target.method !== 'MERGE') || (!updating && target.method !== 'POST'))
      throw new Error('The captured operation does not match this editor. No request was sent.')
    if (updating && target.key)
      assertExplorerKeyUnchanged(target.key, payload)
    const body = updating ? prepareExplorerUpdatePayload(target, payload) : payload
    if (updating && Object.keys(body).length === 0) {
      toast.add({ title: 'No changes to save', color: 'neutral' })
      draft.show = false
      return
    }
    writeDispatched = true
    const res = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: JSON.stringify(body),
    })

    if (!res.ok)
      throw await readExplorerRequestError(res)

    delete entityDataCache.value[buildEntityPreviewCacheKey(target.serviceName, target.entitySet)]
    toast.add({
      title: `Item ${updating ? 'updated' : 'created'} successfully`,
      icon: 'i-lucide-circle-check',
      color: 'success',
    })

    draft.show = false
    if (selectedService.value?.name === target.serviceName && selectedEntity.value === target.entitySet)
      emit('refresh')
  }
  catch (e: unknown) {
    draft.conflict = draft.mode !== 'request' && e instanceof ExplorerRequestError && e.conflict
    if (e instanceof SyntaxError) {
      draft.error = formatJsonError(e)
    }
    else {
      draft.error = e instanceof Error ? e.message : String(e)
    }
    const failedTarget = draft.requestTarget ?? draft.target
    if (writeDispatched && failedTarget) {
      if (!(e instanceof ExplorerRequestError) || e.status >= 500) {
        draft.outcomeUnknown = true
        delete entityDataCache.value[buildEntityPreviewCacheKey(failedTarget.serviceName, failedTarget.entitySet)]
        draft.error = `The write outcome is unknown. Check current data before starting another write. ${draft.error}`
      }
      else if (draft.mode === 'request' && e.conflict) {
        draft.error = `Request rejected (HTTP ${e.status}). Review the payload and prepare a new request if its headers must change. ${e.detail}`
      }
    }
    if (editor.value !== draft || !draft.show) {
      toast.add({
        title: `Request failed: ${draft.target?.serviceName ?? draft.requestTarget?.serviceName ?? draft.headersServiceName ?? ''}/${draft.context ?? ''}`,
        description: draft.error,
        icon: 'i-lucide-circle-x',
        color: 'error',
      })
    }
  }
  finally {
    draft.loading = false
  }
}

/**
 * Closes the editor slide-over.
 */
function close() {
  editor.value.show = false
}

const canReloadOriginal = computed(() => {
  const target = editor.value.target ?? editor.value.requestTarget
  return Boolean(target && selectedService.value?.name === target.serviceName && selectedEntity.value === target.entitySet)
})

function discardAndReload() {
  if (!canReloadOriginal.value)
    return
  editor.value.show = false
  emit('refresh')
}
</script>

<template>
  <USlideover
    v-model:open="editor.show"
    :description="(editor.mode === 'headers' ? 'Session Configuration' : editor.context ?? selectedEntity) ?? undefined"
    :ui="{ body: 'bg-neutral-50 dark:bg-neutral-950' }"
  >
    <template #title>
      <div class="flex items-center gap-2">
        <UIcon :name="modeConfig.icon" class="w-5 h-5 text-muted" />
        <span>{{ modeConfig.title }}</span>
      </div>
    </template>

    <template #body>
      <div class="flex flex-col h-full py-2">
        <p v-if="editor.mode === 'request'" class="mb-3 text-sm text-muted">
          Review the method, URL and JSON before sending. This advanced request
          uses the captured query and session headers; row-key and ETag automation
          applies to the separate Edit and Delete record actions.
        </p>
        <div class="flex-1 relative flex flex-col min-h-0 bg-default rounded-xl ring-1 ring-default shadow-sm focus-within:ring-2 focus-within:ring-primary transition-all overflow-hidden">
          <div class="px-4 py-2.5 flex items-center justify-between border-b border-default bg-default/50 shrink-0">
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-terminal" class="w-4 h-4 text-muted" />
              <span class="text-xs font-semibold text-toned font-mono tracking-tight">payload.json</span>
            </div>
            <div class="flex items-center gap-2">
              <UBadge color="neutral" variant="soft" size="sm" class="font-mono">
                {{ modeConfig.method }}
              </UBadge>
            </div>
          </div>

          <div class="flex-1 min-h-0 relative bg-transparent rounded-b-xl overflow-hidden">
            <p v-if="editor.mode === 'request' && editor.requestTarget?.method === 'DELETE'" class="p-4 text-sm text-muted">
              DELETE sends no request body.
            </p>
            <ShikiEditor
              v-else
              v-model="editor.json"
              :readonly="editor.mode === 'view' || editor.mode === 'response'"
            />
          </div>

          <Transition
            enter-active-class="transition duration-200 ease-out"
            enter-from-class="opacity-0 translate-y-2 scale-95"
            enter-to-class="opacity-100 translate-y-0 scale-100"
            leave-active-class="transition duration-150 ease-in"
            leave-from-class="opacity-100 translate-y-0 scale-100"
            leave-to-class="opacity-0 translate-y-2 scale-95"
          >
            <div
              v-if="editor.error"
              class="absolute bottom-4 left-4 right-4 z-10"
            >
              <UAlert
                icon="i-lucide-circle-alert"
                color="error"
                variant="subtle"
                :title="editor.error"
              />
            </div>
          </Transition>
        </div>
      </div>
    </template>

    <template v-if="editor.mode !== 'view' && editor.mode !== 'response'" #footer>
      <div class="flex items-center justify-end gap-3 w-full">
        <UButton
          v-if="editor.conflict || editor.outcomeUnknown"
          :label="editor.outcomeUnknown ? 'Close and reload data' : 'Discard draft and reload'"
          color="neutral"
          variant="outline"
          :disabled="!canReloadOriginal || editor.loading"
          @click="discardAndReload"
        />
        <UButton
          label="Cancel"
          color="neutral"
          variant="soft"
          class="px-5 font-semibold"
          @click="close"
        />
        <UButton
          :label="editor.mode === 'request' ? 'Send Request' : editor.mode === 'create' ? 'Create Record' : 'Save Changes'"
          color="primary"
          class="px-5 font-semibold shadow-sm"
          :loading="editor.loading"
          :disabled="editor.outcomeUnknown"
          @click="saveItem"
        />
      </div>
    </template>
  </USlideover>
</template>
