<script setup lang="ts">
import { onMounted, ref } from 'vue'

const hydrated = ref(false)
onMounted(() => hydrated.value = true)
</script>

<template>
  <h1>ODX native host</h1>
  <p role="status">
    {{ hydrated ? 'Host ready' : 'Loading host' }}
  </p>
</template>
