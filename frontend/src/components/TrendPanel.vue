<template>
  <div class="chart-panel">
    <div class="panel-head">
      <h4>📈 温度/振动趋势</h4>
      <div class="controls">
        <select v-model.number="deviceId" class="sel" @change="onViewChange">
          <option v-for="d in deviceOptions" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
        <select v-model.number="windowMin" class="sel" @change="onViewChange">
          <option :value="1">近1分钟</option>
          <option :value="5">近5分钟</option>
          <option :value="15">近15分钟</option>
        </select>
      </div>
    </div>
    <div v-if="!store.connected" class="ws-banner">
      <span>采样中断：实时连接已断开，正在显示缓存数据</span>
      <button class="retry-btn" @click="retry">重试</button>
    </div>
    <div class="chart-wrap">
      <div ref="chart" class="chart"></div>
      <div v-if="emptyReason" class="state-overlay">
        <p>{{ emptyReason }}</p>
        <button class="retry-btn" @click="retry">重试</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import { useFactoryStore } from '../store/factory'
import type { TrendSample } from '../types'

const store = useFactoryStore()
const chart = ref<HTMLDivElement>()
let inst: echarts.ECharts | null = null

const VIEW_KEY = 'trend-view-v1'
const SAMPLE_MS = 1000 // 采样周期约 1s
const GAP_MS = 2500    // 相邻样本间隔超过该值即判定为采样断档

const deviceId = ref<number | null>(null)
const windowMin = ref(5)
const emptyReason = ref('')

// 恢复上次查看的设备与时段，刷新后仍显示同一段采样
try {
  const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
  if (saved) {
    if (typeof saved.deviceId === 'number') deviceId.value = saved.deviceId
    if ([1, 5, 15].includes(saved.windowMin)) windowMin.value = saved.windowMin
  }
} catch { /* 忽略损坏的缓存 */ }

// 设备列表优先取实时数据；连接断开时回退到缓存序列，保证刷新后仍能定位设备
const deviceOptions = computed(() => {
  const live = store.data?.devices
  if (live?.length) return live.map(d => ({ id: d.id, label: `${d.type}-${d.id}` }))
  return Object.keys(store.samples).map(id => ({ id: Number(id), label: `#${id}` }))
})

watch(deviceOptions, (list) => {
  if (!list.length) return
  if (deviceId.value === null || !list.some(d => d.id === deviceId.value)) {
    deviceId.value = list[0].id
    saveView()
  }
  update()
}, { immediate: true })

function saveView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ deviceId: deviceId.value, windowMin: windowMin.value })) } catch { /* 忽略 */ }
}

function onViewChange() {
  saveView()
  update()
}

// 从同一份采样序列取数；断档处补 null 截断曲线，不跨缺口连线
function buildSeries(win: TrendSample[], pick: (s: TrendSample) => number): [number, number | null][] {
  const out: [number, number | null][] = []
  let prevT = 0
  for (const s of win) {
    if (prevT && s.t - prevT > GAP_MS) out.push([prevT + SAMPLE_MS, null])
    out.push([s.t, pick(s)])
    prevT = s.t
  }
  return out
}

function rangeOf(vals: number[]): { min: number; max: number } {
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (!isFinite(lo)) return { min: 0, max: 1 }
  if (lo === hi) { lo -= 1; hi += 1 }
  const pad = (hi - lo) * 0.15
  return { min: +(lo - pad).toFixed(2), max: +(hi + pad).toFixed(2) }
}

function fmtTooltip(params: any) {
  const ps = Array.isArray(params) ? params : [params]
  const t = ps[0]?.value?.[0]
  const head = t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : ''
  const lines = ps.map((p: any) => {
    const v = p.value?.[1]
    return `${p.marker} ${p.seriesName}: ${v == null ? '--' : Number(v).toFixed(2)}`
  })
  return [head, ...lines].join('<br/>')
}

function update() {
  if (!inst) return
  if (deviceId.value === null) {
    emptyReason.value = '暂无设备数据，等待采样…'
    inst.clear()
    return
  }
  const all = store.samples[deviceId.value] ?? []
  if (!all.length) {
    emptyReason.value = store.connected ? '暂无采样数据，等待采样…' : '采样失败：未获取到数据，请重试'
    inst.clear()
    return
  }
  // 时间轴锚定最近一次采样，保证曲线尾部时刻与最新样本对齐
  const latest = all[all.length - 1].t
  const from = latest - windowMin.value * 60_000
  const win = all.filter(s => s.t >= from)
  if (!win.length) {
    emptyReason.value = '当前时段内没有样本，请调整时段或重试'
    inst.clear()
    return
  }
  emptyReason.value = ''

  const temps = buildSeries(win, s => s.temp)
  const vibs = buildSeries(win, s => s.vib)
  const tempRange = rangeOf(win.map(s => s.temp))
  const vibRange = rangeOf(win.map(s => s.vib))

  // notMerge：切换设备/时段时整体重建，坐标轴与图例不残留上一台设备的配置
  inst.setOption({
    backgroundColor: 'transparent',
    grid: { left: 42, right: 42, top: 14, bottom: 44 },
    legend: { bottom: 0, textStyle: { color: '#94a3b8', fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#0d1b2a',
      borderColor: '#1e3a5f',
      textStyle: { color: '#e0e6ed', fontSize: 11 },
      formatter: fmtTooltip
    },
    xAxis: {
      type: 'time', min: from, max: latest,
      axisLabel: {
        color: '#94a3b8', fontSize: 9,
        formatter: (v: number) => new Date(v).toLocaleTimeString('zh-CN', { hour12: false })
      },
      axisLine: { lineStyle: { color: '#1e3a5f' } },
      splitLine: { show: false }
    },
    yAxis: [
      { type: 'value', min: tempRange.min, max: tempRange.max, axisLabel: { color: '#94a3b8', fontSize: 9 }, splitLine: { lineStyle: { color: '#1e3a5f55' } } },
      { type: 'value', min: vibRange.min, max: vibRange.max, axisLabel: { color: '#94a3b8', fontSize: 9 }, splitLine: { show: false } }
    ],
    series: [
      { name: '温度°C', type: 'line', data: temps, showSymbol: false, connectNulls: false, itemStyle: { color: '#f97316' }, lineStyle: { color: '#f97316', width: 2 } },
      { name: '振动mm/s', type: 'line', yAxisIndex: 1, data: vibs, showSymbol: false, connectNulls: false, itemStyle: { color: '#a78bfa' }, lineStyle: { color: '#a78bfa', width: 2 } }
    ],
    animation: false
  }, { notMerge: true })
}

function retry() {
  store.reloadSamples()
  if (!store.connected) store.reconnect()
  update()
}

onMounted(() => { if (chart.value) { inst = echarts.init(chart.value); update() } })
watch(() => store.data, update)
onUnmounted(() => inst?.dispose())
</script>

<style scoped>
.chart-panel{background:#0d1b2a;border-radius:8px;padding:12px;border:1px solid #1e3a5f}
.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.chart-panel h4{color:#64b5f6;font-size:13px}
.controls{display:flex;gap:6px}
.sel{background:#112233;color:#94a3b8;border:1px solid #1e3a5f;border-radius:4px;font-size:11px;padding:2px 4px;outline:none}
.ws-banner{display:flex;justify-content:space-between;align-items:center;gap:8px;background:#3f1d1d55;border:1px solid #7f1d1d;border-radius:4px;padding:4px 8px;margin-bottom:6px;font-size:11px;color:#fca5a5}
.chart-wrap{position:relative}
.chart{width:100%;height:200px}
.state-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#0d1b2acc;font-size:12px;color:#94a3b8;text-align:center;padding:0 12px}
.retry-btn{background:#1e3a5f;color:#64b5f6;border:1px solid #64b5f6;border-radius:4px;font-size:11px;padding:3px 14px;cursor:pointer}
.retry-btn:hover{background:#64b5f6;color:#0d1b2a}
</style>
