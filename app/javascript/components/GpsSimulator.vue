<script setup lang="ts">
// Page de débug : rejoue un itinéraire comme faux GPS pour observer la navigation.
// Le setup tourne AVANT le montage de RouteNavigation (îlot placé avant dans la vue),
// ce qui laisse le temps de remplacer navigator.geolocation.
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { installFakeGeolocation, buildTrack, trackLength, type SimTrack } from '../gpsSimulator'

const props = defineProps<{ shareToken: string; free?: boolean }>()

const geo = installFakeGeolocation()
const track = ref<SimTrack | null>(null)
const playing = ref(false)
const collapsed = ref(false)
const state = reactive({ distM: 0, speedKmh: 25, lateralM: 0, accuracyM: 5, signal: true })
const total = computed(() => (track.value ? trackLength(track.value) : 0))
let timer: number | undefined
let lastTick = 0

function tick() {
  const now = performance.now()
  const dt = (now - lastTick) / 1000
  lastTick = now
  if (!track.value) return
  if (playing.value) {
    state.distM = Math.min(total.value, state.distM + (state.speedKmh / 3.6) * dt)
    if (state.distM >= total.value) playing.value = false
  }
  geo.emit(track.value, { ...state, speedKmh: playing.value ? state.speedKmh : 0 })
}

function jump(deltaM: number) {
  state.distM = Math.max(0, Math.min(total.value, state.distM + deltaM))
}

onMounted(async () => {
  const res = await fetch(`/api/routes/shared/${props.shareToken}`, { headers: { Accept: 'application/json' } })
  const json = await res.json()
  track.value = buildTrack(json.route.geometry)
  const at = Number(new URLSearchParams(location.search).get('at'))
  if (at > 0) state.distM = Math.min(total.value, at)
  lastTick = performance.now()
  timer = window.setInterval(tick, 1000)
  tick()
})
// Bascule navigation libre / avec itinéraire : recharge la page, car RouteNavigation
// décide de charger (ou non) le tracé au montage.
function toggleFree() {
  const url = new URL(location.href)
  if (props.free) url.searchParams.delete('free')
  else url.searchParams.set('free', '1')
  url.searchParams.set('at', String(Math.round(state.distM)))
  location.href = url.toString()
}
onBeforeUnmount(() => { clearInterval(timer); geo.restore() })
</script>

<template>
  <div class="gps-sim" :class="{ collapsed }">
    <button class="gps-sim__head" type="button" @click="collapsed = !collapsed">
      GPS simulé · {{ (state.distM / 1000).toFixed(2) }} / {{ (total / 1000).toFixed(2) }} km
    </button>
    <div v-if="!collapsed" class="gps-sim__body">
      <div v-if="!track">Chargement du tracé…</div>
      <template v-else>
        <div class="gps-sim__row">
          <button type="button" @click="playing = !playing">{{ playing ? '⏸ Pause' : '▶ Lecture' }}</button>
          <button type="button" @click="jump(-1000)">−1 km</button>
          <button type="button" @click="jump(-100)">−100 m</button>
          <button type="button" @click="jump(100)">+100 m</button>
          <button type="button" @click="jump(1000)">+1 km</button>
        </div>
        <label>Position
          <input v-model.number="state.distM" type="range" min="0" :max="total" step="10">
        </label>
        <label>Vitesse : {{ state.speedKmh }} km/h
          <input v-model.number="state.speedKmh" type="range" min="3" max="120" step="1">
        </label>
        <label>Écart latéral : {{ state.lateralM }} m (hors-trajet à partir de quelques dizaines)
          <input v-model.number="state.lateralM" type="range" min="-300" max="300" step="5">
        </label>
        <label>Précision GPS : {{ state.accuracyM }} m
          <input v-model.number="state.accuracyM" type="range" min="3" max="100" step="1">
        </label>
        <label class="gps-sim__check"><input type="checkbox" :checked="free" @change="toggleFree"> Navigation libre (sans itinéraire)</label>
        <label class="gps-sim__check"><input v-model="state.signal" type="checkbox"> Signal GPS (décocher = perte de fix)</label>
      </template>
    </div>
  </div>
</template>

<style scoped>
.gps-sim { position: fixed; z-index: 10000; left: 8px; bottom: 8px; width: min(340px, calc(100vw - 16px));
  background: rgba(20, 20, 24, .92); color: #fff; border-radius: 10px; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
.gps-sim__head { width: 100%; background: none; border: 0; color: inherit; padding: 8px 12px; text-align: left; font-weight: 600; }
.gps-sim__body { padding: 0 12px 10px; display: flex; flex-direction: column; gap: 6px; }
.gps-sim__row { display: flex; gap: 4px; flex-wrap: wrap; }
.gps-sim__row button { flex: 1; padding: 4px 6px; border-radius: 6px; border: 1px solid #555; background: #333; color: #fff; }
.gps-sim label { display: flex; flex-direction: column; gap: 2px; }
.gps-sim__check { flex-direction: row !important; align-items: center; gap: 6px !important; }
</style>
