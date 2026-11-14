<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'

export interface FriendsSettings { default_visibility: 'private' | 'friends'; discoverable: boolean }

const props = defineProps<{ settings: FriendsSettings }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', s: FriendsSettings): void }>()

const form = ref<FriendsSettings>({ ...props.settings })
const saving = ref(false)
const error = ref('')

async function save(): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    const res = await fetch('/api/profile/friends', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({ friends: form.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    emit('saved', (await res.json()).friends)
    emit('close')
  } catch {
    error.value = t('friends.error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal d-block" tabindex="-1" role="dialog" aria-modal="true" style="background: rgba(0, 0, 0, 0.5)" @click.self="emit('close')">
    <div class="modal-dialog modal-dialog-centered">
      <form class="modal-content" @submit.prevent="save">
        <div class="modal-header">
          <h2 class="modal-title h5">{{ t('friends.settings_title') }}</h2>
          <button type="button" class="btn-close" :aria-label="t('friends.cancel')" @click="emit('close')"></button>
        </div>
        <div class="modal-body">
          <div v-if="error" class="alert alert-danger py-1">{{ error }}</div>
          <div class="mb-3">
            <label for="fs-visibility" class="form-label">{{ t('friends.default_visibility') }}</label>
            <select id="fs-visibility" v-model="form.default_visibility" class="form-select">
              <option value="private">{{ t('friends.default_visibility_private') }}</option>
              <option value="friends">{{ t('friends.default_visibility_friends') }}</option>
            </select>
            <div class="form-text">{{ t('friends.default_visibility_hint') }}</div>
          </div>
          <div class="form-check form-switch">
            <input id="fs-discoverable" v-model="form.discoverable" class="form-check-input" type="checkbox" role="switch">
            <label for="fs-discoverable" class="form-check-label">{{ t('friends.discoverable') }}</label>
            <div class="form-text">{{ t('friends.discoverable_hint') }}</div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-secondary" @click="emit('close')">{{ t('friends.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">{{ t('friends.save') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>
