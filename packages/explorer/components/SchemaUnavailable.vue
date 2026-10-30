<script setup lang="ts">
defineOptions({ inheritAttrs: false })

function reloadExplorer(): void {
  window.location.reload()
}
</script>

<template>
  <div role="alert" class="h-full flex flex-col items-center justify-center gap-4 p-6 text-center">
    <UIcon name="i-lucide-triangle-alert" class="text-warning" />
    <p>Schema could not be loaded. Reload Explorer to fetch current assets.</p>
    <UButton label="Reload Explorer" icon="i-lucide-refresh-cw" color="neutral" variant="outline" @click="reloadExplorer" />
  </div>
</template>
