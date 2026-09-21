import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { FactoryData, TrendSample } from '@/types'

const STORAGE_KEY = 'trend-samples-v1'
const MAX_SAMPLES = 1200 // 每台设备最多保留约 20 分钟采样（1Hz）
const SAVE_DELAY = 3000
const RECONNECT_DELAY = 5000

function loadPersisted(): Record<number, TrendSample[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    const out: Record<number, TrendSample[]> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) {
        out[Number(k)] = (v as TrendSample[])
          .filter(s => s && typeof s.t === 'number')
          .slice(-MAX_SAMPLES)
      }
    }
    return out
  } catch {
    return {}
  }
}

export const useFactoryStore = defineStore('factory', () => {
  const data = ref<FactoryData | null>(null)
  const ws = ref<WebSocket | null>(null)
  const connected = ref(false)
  // 每台设备的采样序列，中断前的记录保留在内存与 localStorage 中
  const samples = ref<Record<number, TrendSample[]>>(loadPersisted())

  let manualClose = false
  let reconnectTimer: number | null = null
  let saveTimer: number | null = null

  function recordSamples(d: FactoryData) {
    const t = d.timestamp ? Math.round(d.timestamp * 1000) : Date.now()
    for (const dev of d.devices) {
      const arr = samples.value[dev.id] ?? (samples.value[dev.id] = [])
      const last = arr[arr.length - 1]
      if (last && t === last.t) {
        last.temp = dev.temperature
        last.vib = dev.vibration
        continue
      }
      if (last && t < last.t) continue // 丢弃乱序样本，保证序列时间单调
      arr.push({ t, temp: dev.temperature, vib: dev.vibration })
      if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES)
    }
    scheduleSave()
  }

  function scheduleSave() {
    if (saveTimer !== null) return
    saveTimer = window.setTimeout(() => { saveTimer = null; persist() }, SAVE_DELAY)
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(samples.value)) } catch { /* 存储满时忽略 */ }
  }

  // 内存中缺失的设备从持久层补回（重试时使用）
  function reloadSamples() {
    const restored = loadPersisted()
    for (const [k, v] of Object.entries(restored)) {
      const id = Number(k)
      if (!samples.value[id]?.length && v.length) samples.value[id] = v
    }
  }

  function connect() {
    if (ws.value) return
    manualClose = false
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const s = new WebSocket(`${protocol}//${location.hostname}:8000/ws`)
    s.onopen = () => { connected.value = true; console.log('WS connected') }
    s.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as FactoryData
        data.value = parsed
        recordSamples(parsed)
      } catch { /* 忽略无法解析的帧 */ }
    }
    s.onclose = () => {
      connected.value = false
      ws.value = null
      if (!manualClose) reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY)
    }
    ws.value = s
  }

  function disconnect() {
    manualClose = true
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
    ws.value?.close()
    ws.value = null
    connected.value = false
  }

  function reconnect() {
    disconnect()
    manualClose = false
    connect()
  }

  window.addEventListener('beforeunload', persist)

  return { data, connected, samples, connect, disconnect, reconnect, reloadSamples: reloadSamples }
})
