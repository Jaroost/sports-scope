<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'

const props = defineProps<{ routeId: number; routeName: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface ShareTarget { user_id: number; display_name: string; shared: boolean }
const targets = ref<ShareTarget[]>([])
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  try {
    const res = await fetch(`/api/routes/${props.routeId}/shares`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    targets.value = (await res.json()).friends
  } catch {
    error.value = t('friends.error')
  } finally {
    loading.value = false
  }
}

async function toggle(target: ShareTarget): Promise<void> {
  const wasShared = target.shared
  target.shared = !wasShared
  try {
    const res = await fetch(
      wasShared ? `/api/routes/${props.routeId}/shares/${target.user_id}` : `/api/routes/${props.routeId}/shares`,
      {
        method: wasShared ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        credentials: 'same-origin',
        body: wasShared ? undefined : JSON.stringify({ user_id: target.user_id }),
      },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    target.shared = wasShared
    error.value = t('friends.error')
  }
}

onMounted(load)
</script>

<template>
  <div class="modal d-block" tabindex="-1" role="dialog" aria-modal="true" style="background: rgba(0, 0, 0, 0.5)" @click.self="emit('close')">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header">
          <h2 class="modal-title h5">{{ t('friends.share_title') }}</h2>
          <button type="button" class="btn-close" :aria-label="t('friends.cancel')" @click="emit('close')"></button>
        </div>
        <div class="modal-body">
          <p class="text-muted small mb-2">{{ routeName }}</p>
          <div v-if="error" class="alert alert-danger py-1">{{ error }}</div>
          <p v-if="!loading && !targets.length" class="text-muted mb-0">{{ t('friends.share_no_friends') }}</p>
          <div v-for="f in targets" :key="f.user_id" class="form-check form-switch mb-2">
            <input :id="`share-${f.user_id}`" class="form-check-input" type="checkbox" :checked="f.shared" @change="toggle(f)">
            <label class="form-check-label" :for="`share-${f.user_id}`">{{ f.display_name }}</label>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
