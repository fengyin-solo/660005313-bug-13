<template>
  <div class="chart-panel trend-panel">
    <div class="panel-header">
      <h4>📈 温度/振动趋势</h4>
      <div class="controls">
        <el-select
          :model-value="store.selectedDeviceId"
          size="small"
          class="device-select"
          @change="onDeviceChange"
        >
          <el-option
            v-for="dev in devices"
            :key="dev.id"
            :label="`${dev.type} #${dev.id}`"
            :value="dev.id"
          />
        </el-select>
        <div class="range-tabs">
          <button
            v-for="item in timeRanges"
            :key="`${item.value}-${item.live}`"
            type="button"
            :class="{ active: item.value === store.timeWindow && item.live === isLiveWindow }"
            @click="setRange(item)"
          >{{ item.label }}</button>
        </div>
      </div>
    </div>

    <div class="latest-row">
      <template v-if="lastSample">
        <span class="device-name">{{ selectedDeviceLabel }}</span>
        <span>最近采样: {{ formatTime(lastSample.timestamp) }}</span>
        <span class="temp">温度: {{ lastSample.temperature.toFixed(1) }}°C</span>
        <span class="vibration">振动: {{ lastSample.vibration.toFixed(2) }}mm/s</span>
      </template>
      <span v-else class="no-sample">暂无有效采样</span>
    </div>

    <div v-if="loadError" class="error-banner">
      <span>⚠️ {{ loadError }}</span>
      <button type="button" @click="loadSamples">重试</button>
    </div>
    <div v-else-if="loading && visibleSamples.length" class="info-banner">
      正在重新加载采样数据，中断前记录仍保留在图中。
    </div>
    <div v-else-if="!store.connected" class="warning-banner">
      实时采样中断，已保留中断前记录；恢复后将按采样序列自动补齐。
    </div>

    <div class="chart-wrap">
      <div ref="chart" class="chart"></div>
      <div v-if="loading && !visibleSamples.length" class="overlay">
        <div>正在加载采样数据...</div>
        <button type="button" @click="loadSamples">重试</button>
      </div>
      <div v-else-if="!visibleSamples.length" class="overlay">
        <div>{{ emptyReason }}</div>
        <button type="button" @click="loadSamples">重试</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { useFactoryStore } from '../store/factory'
import type { SensorSample } from '../types'

const store = useFactoryStore()
const chart = ref<HTMLDivElement>()
const loading = ref(false)
const loadError = ref('')
let inst: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null

const timeRanges = [
  { label: '实时', value: 60, live: true },
  { label: '1分', value: 60, live: false },
  { label: '5分', value: 300, live: false },
  { label: '15分', value: 900, live: false },
  { label: '30分', value: 1800, live: false }
]

const devices = computed(() => store.data?.devices || [])
const selectedDevice = computed(() =>
  devices.value.find(dev => dev.id === store.selectedDeviceId)
)
const selectedDeviceLabel = computed(() => {
  const dev = selectedDevice.value
  return dev ? `${dev.type} #${dev.id}` : `设备 #${store.selectedDeviceId}`
})

const sourceSamples = computed<SensorSample[]>(() => {
  const end = store.timeWindowEnd ?? Date.now()
  const start = end - store.timeWindow * 1000
  const samples = store.sampleCache[store.selectedDeviceId] || []
  return samples.filter(sample => sample.timestamp >= start && sample.timestamp <= end)
})

const isLiveWindow = computed(() => store.timeWindowEnd === null)

type ChartPoint = {
  timestamp: number
  temperature: number | null
  vibration: number | null
  status?: string
  gap?: boolean
}

const visibleSamples = computed<ChartPoint[]>(() => {
  const points: ChartPoint[] = []
  sourceSamples.value.forEach((sample, index) => {
    if (index > 0) {
      const previous = sourceSamples.value[index - 1]
      if (sample.timestamp - previous.timestamp > 2500) {
        points.push({
          timestamp: previous.timestamp + (sample.timestamp - previous.timestamp) / 2,
          temperature: null,
          vibration: null,
          gap: true
        })
      }
    }
    points.push(sample)
  })
  return points
})

const lastSample = computed(() => sourceSamples.value[sourceSamples.value.length - 1])
const emptyReason = computed(() => {
  if (!devices.value.length) return '设备数据为空，请确认采集服务后重试。'
  if (!store.connected) return '采样中断，当前时段没有可显示的样本。'
  return '当前设备在所选时段内没有样本，请调整时段或重试。'
})

function onDeviceChange(deviceId: number) {
  loadError.value = ''
  store.selectDevice(deviceId)
}

function setRange(item: { value: number; live: boolean }) {
  loadError.value = ''
  store.setTimeWindow(item.value, item.live ? null : Date.now())
}

async function loadSamples() {
  loading.value = true
  loadError.value = ''
  try {
    await store.fetchHistory()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '采样数据加载失败'
  } finally {
    loading.value = false
  }
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}

function renderChart() {
  if (!inst) return
  if (!visibleSamples.value.length) {
    inst.clear()
    return
  }
  const temperatureData = visibleSamples.value.map(point => [point.timestamp, point.temperature])
  const vibrationData = visibleSamples.value.map(point => [point.timestamp, point.vibration])
  const now = Date.now()
  const rangeEnd = store.timeWindowEnd ?? now
  const rangeStart = rangeEnd - store.timeWindow * 1000
  inst.setOption({
    backgroundColor: 'transparent',
    grid: { left: 48, right: 48, top: 28, bottom: 48 },
    legend: {
      bottom: 2,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { color: '#94a3b8', fontSize: 10 }
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(13,27,42,0.95)',
      borderColor: '#1e3a5f',
      textStyle: { color: '#e0e6ed', fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: '#64b5f6', type: 'dashed' } },
      formatter: (params: any) => {
        const values = Array.isArray(params) ? params : [params]
        if (!values.length) return ''
        const point = visibleSamples.value.find(item => item.timestamp === values[0].axisValue)
        const time = formatTime(values[0].axisValue)
        if (point?.gap) {
          return `${time}<br/>采样中断：断档不连线，恢复后继续记录`
        }
        const rows = values.map((item: any) => {
          const unit = item.seriesName.includes('温度') ? '°C' : 'mm/s'
          const value = item.value?.[1]
          return `${item.marker}${item.seriesName}: ${value == null ? '无样本' : Number(value).toFixed(2)}${unit}`
        })
        return `${time}<br/>${rows.join('<br/>')}`
      }
    },
    xAxis: {
      type: 'time',
      min: rangeStart,
      max: rangeEnd,
      axisLabel: { color: '#94a3b8', fontSize: 9, formatter: (value: number) => formatTime(value) },
      axisLine: { lineStyle: { color: '#1e3a5f' } },
      splitLine: { show: false }
    },
    yAxis: [
      {
        type: 'value',
        name: '温度°C',
        nameTextStyle: { color: '#f97316', fontSize: 10 },
        scale: true,
        axisLabel: { color: '#94a3b8', fontSize: 9 },
        splitLine: { lineStyle: { color: '#1e3a5f55' } }
      },
      {
        type: 'value',
        name: '振动mm/s',
        nameTextStyle: { color: '#a78bfa', fontSize: 10 },
        scale: true,
        axisLabel: { color: '#94a3b8', fontSize: 9 },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: '温度',
        type: 'line',
        yAxisIndex: 0,
        data: temperatureData,
        smooth: false,
        showSymbol: true,
        symbolSize: 4,
        connectNulls: false,
        itemStyle: { color: '#f97316' },
        lineStyle: { width: 2 }
      },
      {
        name: '振动',
        type: 'line',
        yAxisIndex: 1,
        data: vibrationData,
        smooth: false,
        showSymbol: true,
        symbolSize: 4,
        connectNulls: false,
        itemStyle: { color: '#a78bfa' },
        lineStyle: { width: 2 }
      }
    ],
    animation: false
  }, true)
}

onMounted(() => {
  if (chart.value) {
    inst = echarts.init(chart.value)
    resizeObserver = new ResizeObserver(() => inst?.resize())
    resizeObserver.observe(chart.value)
  }
  loadSamples()
  renderChart()
})

watch(
  [() => store.selectedDeviceId, () => store.timeWindow, () => store.timeWindowEnd],
  () => {
    loadSamples()
    renderChart()
  }
)
watch(visibleSamples, renderChart, { deep: true })
watch(() => store.connected, () => {
  if (store.connected) loadSamples()
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  inst?.dispose()
  inst = null
})
</script>

<style scoped>
.chart-panel{background:#0d1b2a;border-radius:8px;padding:12px;border:1px solid #1e3a5f}
.chart-panel h4{color:#64b5f6;font-size:13px;margin-bottom:4px}
.panel-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.device-select{width:126px}
.range-tabs{display:flex;gap:2px;background:#112233;border:1px solid #1e3a5f;border-radius:4px;overflow:hidden}
.range-tabs button{border:0;background:transparent;color:#94a3b8;font-size:10px;padding:4px 7px;cursor:pointer}
.range-tabs button.active{background:#1e3a5f;color:#e0e6ed}
.latest-row{display:flex;gap:10px;align-items:center;min-height:20px;margin:5px 0;font-size:10px;color:#94a3b8;flex-wrap:wrap}
.device-name{color:#cbd5e1;font-weight:600}
.temp{color:#fdba74}
.vibration{color:#c4b5fd}
.no-sample{color:#64748b}
.error-banner,.warning-banner,.info-banner{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;padding:5px 8px;border-radius:4px;font-size:10px}
.error-banner{background:#7f1d1d33;border:1px solid #991b1b66;color:#fca5a5}
.warning-banner{background:#78350f33;border:1px solid #b4530966;color:#fcd34d}
.info-banner{background:#1e3a5f33;border:1px solid #2563eb66;color:#bfdbfe}
.error-banner button,.overlay button{border:1px solid #64b5f6;background:#123653;color:#bfdbfe;border-radius:3px;padding:3px 10px;font-size:11px;cursor:pointer}
.chart-wrap{position:relative}
.chart{width:100%;height:200px}
.overlay{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;background:rgba(13,27,42,0.88);color:#94a3b8;font-size:12px;text-align:center;padding:16px}
:deep(.device-select .el-select__wrapper){background:#112233;box-shadow:0 0 0 1px #1e3a5f inset;min-height:24px}
:deep(.device-select .el-select__placeholder),:deep(.device-select .el-select__selected-item){color:#cbd5e1;font-size:11px}
</style>
