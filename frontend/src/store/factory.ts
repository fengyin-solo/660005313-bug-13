import { defineStore } from 'pinia'
import { ref, onUnmounted } from 'vue'
import type { FactoryData, SensorReading, SensorSample } from '@/types'

const SELECTION_KEY = 'factory.trendSelection'
const SAMPLE_KEY_PREFIX = 'factory.samples.'
const SAMPLE_TTL_MS = 30 * 60 * 1000
const RECONNECT_DELAY_MS = 3000

interface TrendSelection {
  deviceId: number
  timeWindow: number
  timeWindowEnd: number | null
}

function readSelection(): TrendSelection {
  const fallback = { deviceId: 1, timeWindow: 300, timeWindowEnd: null }
  try {
    const saved = localStorage.getItem(SELECTION_KEY)
    return saved ? { ...fallback, ...JSON.parse(saved) } : fallback
  } catch {
    return fallback
  }
}

function prune(samples: SensorSample[], now = Date.now()): SensorSample[] {
  return samples.filter(sample => sample.timestamp >= now - SAMPLE_TTL_MS)
}

function loadPersistedSamples(deviceId: number): SensorSample[] {
  try {
    const raw = localStorage.getItem(SAMPLE_KEY_PREFIX + deviceId)
    if (!raw) return []
    const saved = JSON.parse(raw)
    return prune(Array.isArray(saved.samples) ? saved.samples : [])
  } catch {
    return []
  }
}

export const useFactoryStore = defineStore('factory', () => {
  const data = ref<FactoryData | null>(null)
  const ws = ref<WebSocket | null>(null)
  const connected = ref(false)
  const selectedDeviceId = ref(readSelection().deviceId)
  const timeWindow = ref(readSelection().timeWindow)
  const timeWindowEnd = ref(readSelection().timeWindowEnd)
  const sampleCache = ref<Record<number, SensorSample[]>>({})
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let persistTimer: ReturnType<typeof setInterval> | null = null
  let manualDisconnect = false

  sampleCache.value[selectedDeviceId.value] = loadPersistedSamples(selectedDeviceId.value)

  function persistSelection() {
    const selection = {
      deviceId: selectedDeviceId.value,
      timeWindow: timeWindow.value,
      timeWindowEnd: timeWindowEnd.value
    }
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selection))
  }

  function persistSamples(deviceId = selectedDeviceId.value) {
    const samples = sampleCache.value[deviceId] || []
    if (!samples.length) return
    localStorage.setItem(
      SAMPLE_KEY_PREFIX + deviceId,
      JSON.stringify({ samples: prune(samples) })
    )
  }

  function mergeSamples(deviceId: number, incoming: SensorSample[]) {
    const byTimestamp = new Map<number, SensorSample>()
    for (const sample of sampleCache.value[deviceId] || []) {
      byTimestamp.set(sample.timestamp, sample)
    }
    for (const sample of incoming) {
      byTimestamp.set(sample.timestamp, sample)
    }
    const samples = Array.from(byTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp)
    sampleCache.value[deviceId] = prune(samples)
  }

  function appendFrame(readings: SensorReading[]) {
    const grouped = new Map<number, SensorReading[]>()
    for (const reading of readings) {
      const list = grouped.get(reading.device_id) || []
      list.push(reading)
      grouped.set(reading.device_id, list)
    }
    for (const [deviceId, deviceReadings] of grouped) {
      const latest = deviceReadings
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)[0]
      mergeSamples(deviceId, [{
        timestamp: Math.round(latest.timestamp * 1000),
        temperature: latest.temperature,
        vibration: latest.vibration,
        status: latest.status
      }])
    }
  }

  async function fetchHistory(
    deviceId = selectedDeviceId.value,
    windowSeconds = timeWindow.value,
    endMs = timeWindowEnd.value
  ) {
    const end = Math.floor((endMs ?? Date.now()) / 1000)
    const start = end - windowSeconds
    const response = await fetch(`/api/devices/${deviceId}/samples?start=${start}&end=${end}`)
    if (!response.ok) throw new Error(`采样请求失败 (${response.status})`)
    const payload = await response.json()
    const samples: SensorSample[] = (payload.samples || []).map((sample: any) => ({
      timestamp: Math.round(sample.timestamp * 1000),
      temperature: sample.temperature,
      vibration: sample.vibration,
      status: sample.status
    }))
    mergeSamples(deviceId, samples)
    return samples
  }

  function connect() {
    if (ws.value && ws.value.readyState <= WebSocket.OPEN) return
    manualDisconnect = false
    if (reconnectTimer) clearTimeout(reconnectTimer)
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const s = new WebSocket(`${protocol}//${location.hostname}:8000/ws`)
    s.onopen = () => {
      connected.value = true
      fetchHistory().catch(() => {})
    }
    s.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data) as FactoryData
        data.value = payload
        if (Array.isArray(payload.samples) && payload.samples.length) {
          appendFrame(payload.samples)
        }
      } catch {}
    }
    s.onclose = () => {
      connected.value = false
      ws.value = null
      if (!manualDisconnect) {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      }
    }
    ws.value = s
  }

  function disconnect() {
    manualDisconnect = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    persistSamples()
    ws.value?.close()
    ws.value = null
    connected.value = false
  }

  function selectDevice(deviceId: number) {
    if (deviceId === selectedDeviceId.value) return
    persistSamples(selectedDeviceId.value)
    selectedDeviceId.value = deviceId
    if (!sampleCache.value[deviceId]?.length) {
      sampleCache.value[deviceId] = loadPersistedSamples(deviceId)
    }
    persistSelection()
  }

  function setTimeWindow(seconds: number, endMs: number | null = null) {
    if (seconds === timeWindow.value && endMs === timeWindowEnd.value) return
    timeWindow.value = seconds
    timeWindowEnd.value = endMs
    persistSelection()
  }

  persistTimer = setInterval(() => persistSamples(), 5000)
  window.addEventListener('beforeunload', () => persistSamples())
  onUnmounted(() => {
    if (persistTimer) clearInterval(persistTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  return {
    data,
    connected,
    selectedDeviceId,
    timeWindow,
    timeWindowEnd,
    sampleCache,
    connect,
    disconnect,
    fetchHistory,
    selectDevice,
    setTimeWindow
  }
})
