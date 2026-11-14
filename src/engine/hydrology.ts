import { boundedPatternSearch, differentialEvolution, type Bounds } from './optimizer';
import {
  AREA_TO_ACRES,
  FLOW_TO_MGD,
  convertRainToInHr,
  formatWallClockIso,
  medianOfNumbers,
  parseTelemetryText,
} from './parser';
import type {
  AnalysisConfig,
  CoupledGimResult,
  DiurnalHourRow,
  DwfSummary,
  FullAnalysisResult,
  IcmParameterRow,
  PumpDiagnostics,
  StormEventRtk,
  TimeSeriesData,
} from './types';

const MS_PER_MIN = 60_000;
const MS_15M = 15 * MS_PER_MIN;
const MS_HOUR = 60 * MS_PER_MIN;
const MS_DAY = 24 * MS_HOUR;

function computeDiffStd(values: Float64Array): number {
  if (values.length < 2) return 0;
  const n = values.length - 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i + 1] - values[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i + 1] - values[i] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / Math.max(1, n - 1));
}

function meanOfSlice(arr: Float64Array, start: number, end: number): number {
  if (end <= start) return 0;
  let s = 0;
  for (let i = start; i < end; i++) s += arr[i];
  return s / (end - start);
}

function stdOfSlice(arr: Float64Array, start: number, end: number, mean: number): number {
  if (end - start < 2) return 0;
  let sq = 0;
  for (let i = start; i < end; i++) {
    const d = arr[i] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / (end - start - 1));
}

/**
 * Simple local peak finder matching scipy.signal.find_peaks(prominence, distance).
 */
function findLocalPeaks(
  arr: Float64Array,
  start: number,
  end: number,
  minDistance: number,
  minProminence: number
): number[] {
  const candidates: Array<{ idx: number; val: number }> = [];
  const lookaround = Math.max(3, minDistance * 2);

  for (let i = start + 1; i < end - 1; i++) {
    const v = arr[i];
    if (v > arr[i - 1] && v >= arr[i + 1]) {
      let leftMin = v;
      for (let j = Math.max(start, i - lookaround); j < i; j++) {
        if (arr[j] < leftMin) leftMin = arr[j];
      }
      let rightMin = v;
      for (let j = i + 1; j <= Math.min(end - 1, i + lookaround); j++) {
        if (arr[j] < rightMin) rightMin = arr[j];
      }
      const prom = v - Math.max(leftMin, rightMin);
      if (prom >= minProminence) {
        candidates.push({ idx: i, val: v });
      }
    }
  }

  // Enforce minimum index separation (highest peaks win)
  candidates.sort((a, b) => b.val - a.val);
  const selected: number[] = [];
  for (const c of candidates) {
    let tooClose = false;
    for (const s of selected) {
      if (Math.abs(c.idx - s) < minDistance) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) selected.push(c.idx);
  }
  selected.sort((a, b) => a - b);
  return selected;
}

function centeredMovingAverage(arr: Float64Array, windowPts: number): Float64Array {
  const n = arr.length;
  const out = new Float64Array(n);
  const half = windowPts >> 1;
  // Prefix sum for O(N) exact centered rolling average with min_periods=1
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + arr[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

/**
 * Step 1: Detect lift-station pump cycling and apply zero-phase 2-pass centered running average.
 */
export function detectAndSmoothPumpFlow(
  timestampsMs: Float64Array,
  flowMgd: Float64Array,
  dtMin: number,
  enableSmoothing: boolean,
  windowOverrideMin: number | null
): { smoothed: Float64Array; diagnostics: PumpDiagnostics } {
  // Group indices by UTC calendar day
  const dayBuckets = new Map<number, { start: number; end: number; mean: number }>();
  let curDay = Math.floor(timestampsMs[0] / MS_DAY);
  let bucketStart = 0;
  for (let i = 1; i <= timestampsMs.length; i++) {
    const d = i < timestampsMs.length ? Math.floor(timestampsMs[i] / MS_DAY) : -1;
    if (d !== curDay) {
      dayBuckets.set(curDay, {
        start: bucketStart,
        end: i,
        mean: meanOfSlice(flowMgd, bucketStart, i),
      });
      curDay = d;
      bucketStart = i;
    }
  }

  const dailyMeans = Array.from(dayBuckets.values()).map((b) => b.mean);
  const q50 = medianOfNumbers(dailyMeans);
  const candidateDays = Array.from(dayBuckets.values())
    .filter((b) => b.mean <= q50 * 1.15 && b.end - b.start >= 20)
    .slice(0, 12);

  const periodsMin: number[] = [];
  const minDistPts = Math.max(2, Math.round(10.0 / Math.max(dtMin, 0.5)));

  for (const day of candidateDays) {
    const sd = stdOfSlice(flowMgd, day.start, day.end, day.mean);
    const prom = Math.max(0.1 * day.mean, 0.2 * sd);
    const peaks = findLocalPeaks(flowMgd, day.start, day.end, minDistPts, prom);
    if (peaks.length >= 6) {
      for (let k = 1; k < peaks.length; k++) {
        const diffMin = (timestampsMs[peaks[k]] - timestampsMs[peaks[k - 1]]) / MS_PER_MIN;
        if (diffMin > 0 && diffMin <= 120) {
          periodsMin.push(diffMin);
        }
      }
    }
  }

  let totalMean = 0;
  for (let i = 0; i < flowMgd.length; i++) totalMean += flowMgd[i];
  totalMean /= Math.max(1, flowMgd.length);

  const rawDiffStd = computeDiffStd(flowMgd);
  const hasPumpInfluence =
    periodsMin.length >= 10 && rawDiffStd / Math.max(totalMean, 1e-6) > 0.12;
  const medianCycleMin = periodsMin.length >= 10 ? medianOfNumbers(periodsMin) : null;
  const meanCycleMin =
    periodsMin.length >= 10
      ? periodsMin.reduce((a, b) => a + b, 0) / periodsMin.length
      : null;

  const targetWinMin =
    windowOverrideMin !== null && windowOverrideMin > 0
      ? windowOverrideMin
      : medianCycleMin !== null && medianCycleMin >= 15 && medianCycleMin <= 90
      ? medianCycleMin
      : 35.0;

  let nPts = Math.max(3, Math.round(targetWinMin / Math.max(dtMin, 0.5)));
  if (nPts % 2 === 0) nPts += 1;

  const shouldSmooth = enableSmoothing && (hasPumpInfluence || windowOverrideMin !== null);
  const smoothed = shouldSmooth
    ? centeredMovingAverage(centeredMovingAverage(flowMgd, nPts), nPts)
    : Float64Array.from(flowMgd);

  const smoothDiffStd = computeDiffStd(smoothed);
  const reductionPct =
    rawDiffStd > 1e-9 ? Math.max(0, 100 * (1 - smoothDiffStd / rawDiffStd)) : 0;

  return {
    smoothed,
    diagnostics: {
      dtMin,
      hasPumpInfluence,
      medianCycleMin,
      meanCycleMin,
      rawDiffStdMgd: rawDiffStd,
      smoothDiffStdMgd: smoothDiffStd,
      roughnessReductionPct: reductionPct,
      smoothingApplied: shouldSmooth,
      windowPoints: nPts,
      windowActualMin: nPts * dtMin,
    },
  };
}

/**
 * Resample any timestamped series onto a uniform 15-minute grid [startGridMs .. endGridMs].
 */
function resampleFlowTo15m(
  timestampsMs: Float64Array,
  values: Float64Array,
  gridStartMs: number,
  nGrid: number
): Float64Array {
  const sums = new Float64Array(nGrid);
  const counts = new Int32Array(nGrid);
  for (let i = 0; i < timestampsMs.length; i++) {
    const idx = Math.floor((timestampsMs[i] - gridStartMs) / MS_15M);
    if (idx >= 0 && idx < nGrid) {
      sums[idx] += values[i];
      counts[idx] += 1;
    }
  }
  const out = new Float64Array(nGrid);
  let lastValid = -1;
  for (let i = 0; i < nGrid; i++) {
    if (counts[i] > 0) {
      out[i] = sums[i] / counts[i];
      if (lastValid >= 0 && i - lastValid > 1) {
        const v0 = out[lastValid];
        const v1 = out[i];
        const gap = i - lastValid;
        for (let g = 1; g < gap; g++) {
          out[lastValid + g] = v0 + (g / gap) * (v1 - v0);
        }
      } else if (lastValid === -1 && i > 0) {
        for (let g = 0; g < i; g++) out[g] = out[i];
      }
      lastValid = i;
    }
  }
  if (lastValid >= 0 && lastValid < nGrid - 1) {
    for (let g = lastValid + 1; g < nGrid; g++) out[g] = out[lastValid];
  }
  return out;
}

function resampleRainTo15mInHr(
  timestampsMs: Float64Array,
  rainInHr: Float64Array,
  gridStartMs: number,
  nGrid: number
): Float64Array {
  const sums = new Float64Array(nGrid);
  const counts = new Int32Array(nGrid);
  for (let i = 0; i < timestampsMs.length; i++) {
    const idx = Math.floor((timestampsMs[i] - gridStartMs) / MS_15M);
    if (idx >= 0 && idx < nGrid) {
      sums[idx] += rainInHr[i];
      counts[idx] += 1;
    }
  }
  const out = new Float64Array(nGrid);
  for (let i = 0; i < nGrid; i++) {
    out[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  }
  return out;
}

/**
 * Step 2: Clean Dry-Weather Day Selection & 24-Hr Weekday/Weekend Diurnal Extraction.
 */
function extractDwfAndDiurnal(
  gridStartMs: number,
  flow15m: Float64Array,
  rain15mIn: Float64Array
): { summary: DwfSummary; dwf15m: Float64Array } {
  const n = flow15m.length;
  interface DayStat {
    dayKey: number;
    count: number;
    flowSum: number;
    flowMean: number;
    rainIn: number;
    isWeekend: boolean;
  }

  const dayMap = new Map<number, DayStat>();
  for (let i = 0; i < n; i++) {
    const ms = gridStartMs + i * MS_15M;
    const dayKey = Math.floor(ms / MS_DAY);
    let st = dayMap.get(dayKey);
    if (!st) {
      const dow = new Date(dayKey * MS_DAY).getUTCDay();
      st = {
        dayKey,
        count: 0,
        flowSum: 0,
        flowMean: 0,
        rainIn: 0,
        isWeekend: dow === 0 || dow === 6,
      };
      dayMap.set(dayKey, st);
    }
    st.count += 1;
    st.flowSum += flow15m[i];
    st.rainIn += rain15mIn[i];
  }

  const allDays = Array.from(dayMap.values()).sort((a, b) => a.dayKey - b.dayKey);
  for (const d of allDays) d.flowMean = d.flowSum / Math.max(1, d.count);

  const expectedCnt = medianOfNumbers(allDays.map((d) => d.count));
  const zeroRainDays: DayStat[] = [];
  for (let i = 0; i < allDays.length; i++) {
    const d = allDays[i];
    const prevRain =
      i > 0 && allDays[i - 1].dayKey === d.dayKey - 1 ? allDays[i - 1].rainIn : 0;
    if (d.count >= 0.94 * expectedCnt && d.rainIn <= 0.015 && prevRain <= 0.03) {
      zeroRainDays.push(d);
    }
  }

  let cleanDays: DayStat[];
  if (zeroRainDays.length >= 7) {
    const sortedMeans = zeroRainDays.map((d) => d.flowMean).sort((a, b) => a - b);
    const q75Idx = Math.min(sortedMeans.length - 1, Math.floor(0.75 * (sortedMeans.length - 1)));
    const dryThresh = sortedMeans[q75Idx];
    cleanDays = zeroRainDays.filter((d) => d.flowMean <= dryThresh + 1e-9);
  } else {
    const complete = allDays.filter((d) => d.count >= 0.9 * expectedCnt);
    const pool = (complete.length > 0 ? complete : allDays).slice().sort((a, b) => a.flowMean - b.flowMean);
    cleanDays = pool.slice(0, Math.max(5, Math.floor(pool.length / 3)));
  }

  // Guarantee weekend representation when available
  if (!cleanDays.some((d) => d.isWeekend)) {
    const wkndPool = (zeroRainDays.filter((d) => d.isWeekend).length > 0
      ? zeroRainDays.filter((d) => d.isWeekend)
      : allDays.filter((d) => d.isWeekend)
    )
      .slice()
      .sort((a, b) => a.flowMean - b.flowMean);
    for (const w of wkndPool.slice(0, Math.min(4, wkndPool.length))) {
      cleanDays.push(w);
    }
  }

  cleanDays.sort((a, b) => a.dayKey - b.dayKey);
  const cleanSet = new Set(cleanDays.map((d) => d.dayKey));

  const wdSum = new Float64Array(24);
  const wdCnt = new Int32Array(24);
  const weSum = new Float64Array(24);
  const weCnt = new Int32Array(24);

  for (let i = 0; i < n; i++) {
    const ms = gridStartMs + i * MS_15M;
    const dayKey = Math.floor(ms / MS_DAY);
    if (!cleanSet.has(dayKey)) continue;
    const dt = new Date(ms);
    const hr = dt.getUTCHours();
    const dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) {
      weSum[hr] += flow15m[i];
      weCnt[hr] += 1;
    } else {
      wdSum[hr] += flow15m[i];
      wdCnt[hr] += 1;
    }
  }

  const wdHr = new Float64Array(24);
  const weHr = new Float64Array(24);
  let fallbackMean = cleanDays.reduce((s, d) => s + d.flowMean, 0) / Math.max(1, cleanDays.length);
  if (!Number.isFinite(fallbackMean) || fallbackMean <= 0) fallbackMean = 1.0;

  for (let h = 0; h < 24; h++) {
    wdHr[h] = wdCnt[h] > 0 ? wdSum[h] / wdCnt[h] : NaN;
    weHr[h] = weCnt[h] > 0 ? weSum[h] / weCnt[h] : NaN;
  }

  // Forward/backward fill missing hours
  const fillMissing = (arr: Float64Array, fallbackArr: Float64Array) => {
    for (let h = 0; h < 24; h++) {
      if (!Number.isFinite(arr[h])) {
        arr[h] = h > 0 && Number.isFinite(arr[h - 1]) ? arr[h - 1] : Number.isFinite(fallbackArr[h]) ? fallbackArr[h] : fallbackMean;
      }
    }
    for (let h = 23; h >= 0; h--) {
      if (!Number.isFinite(arr[h])) arr[h] = h < 23 ? arr[h + 1] : fallbackMean;
    }
  };
  fillMissing(wdHr, weHr);
  fillMissing(weHr, wdHr);

  let weekdayMean = 0;
  let weekendMean = 0;
  for (let h = 0; h < 24; h++) {
    weekdayMean += wdHr[h];
    weekendMean += weHr[h];
  }
  weekdayMean /= 24;
  weekendMean /= 24;
  const weightedMean = (5 * weekdayMean + 2 * weekendMean) / 7;

  const diurnal: DiurnalHourRow[] = [];
  for (let h = 0; h < 24; h++) {
    diurnal.push({
      hour: h,
      weekdayFlowMgd: wdHr[h],
      weekdayFactor: wdHr[h] / Math.max(weekdayMean, 1e-6),
      weekendFlowMgd: weHr[h],
      weekendFactor: weHr[h] / Math.max(weekendMean, 1e-6),
    });
  }

  // Smooth circular hourly interpolation onto 15-minute timestamps (anchors at h + 0.5)
  const dwf15m = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ms = gridStartMs + i * MS_15M;
    const dt = new Date(ms);
    const dow = dt.getUTCDay();
    const curve = dow === 0 || dow === 6 ? weHr : wdHr;
    const hrDec = dt.getUTCHours() + dt.getUTCMinutes() / 60.0;
    const shifted = hrDec - 0.5;
    const h0 = ((Math.floor(shifted) % 24) + 24) % 24;
    const h1 = (h0 + 1) % 24;
    const frac = shifted - Math.floor(shifted);
    dwf15m[i] = curve[h0] * (1 - frac) + curve[h1] * frac;
  }

  const sampleDryDay =
    cleanDays.length > 0 ? cleanDays[Math.floor(cleanDays.length / 2)].dayKey * MS_DAY : gridStartMs;
  let wettestDay = allDays[0];
  for (const d of allDays) {
    if (d.rainIn > wettestDay.rainIn) wettestDay = d;
  }

  return {
    summary: {
      cleanDryDayCount: cleanDays.length,
      totalCompleteDays: allDays.filter((d) => d.count >= 0.94 * expectedCnt).length,
      weekdayMeanMgd: weekdayMean,
      weekendMeanMgd: weekendMean,
      weightedMeanMgd: weightedMean,
      diurnal,
      sampleDryDayStartMs: sampleDryDay,
      sampleStormStartMs: Math.max(gridStartMs, wettestDay.dayKey * MS_DAY - 12 * MS_HOUR),
    },
    dwf15m,
  };
}

/**
 * Normalized 15-min triangular RTK unit hydrograph kernel.
 */
export function buildRtkKernel15m(tHr: number, kRatio: number): Float64Array {
  const dt = 0.25;
  const tTot = tHr * (1 + kRatio);
  const n = Math.max(2, Math.ceil(tTot / dt) + 1);
  const u = new Float64Array(n);
  const up = 2.0 / (tHr * (1 + kRatio));
  let sum = 0;

  for (let i = 1; i < n; i++) {
    const t = i * dt;
    let val = 0;
    if (t <= tHr) {
      val = up * (t / tHr);
    } else if (t < tTot) {
      val = up * ((tTot - t) / (tHr * kRatio));
    }
    if (val > 0) {
      u[i] = val;
      sum += val;
    }
  }

  if (sum > 0) {
    const inv = 1.0 / sum;
    for (let i = 0; i < n; i++) u[i] *= inv;
  } else {
    u[0] = 1.0;
  }
  return u;
}

function addConvolvedRtk(
  out: Float64Array,
  rainMgd: Float64Array,
  r: number,
  tHr: number,
  kRatio: number
): void {
  if (r <= 1e-6) return;
  const w = buildRtkKernel15m(tHr, kRatio);
  const n = rainMgd.length;
  const wLen = w.length;
  for (let i = 0; i < n; i++) {
    const rm = rainMgd[i];
    if (rm <= 0) continue;
    const scaled = r * rm;
    const maxJ = Math.min(wLen, n - i);
    for (let j = 0; j < maxJ; j++) {
      out[i + j] += scaled * w[j];
    }
  }
}

export function simulateThreeUnitRtk(
  rainInArr: Float64Array,
  mgPerIn: number,
  params: readonly number[],
  outBuffer?: Float64Array
): Float64Array {
  const n = rainInArr.length;
  const out = outBuffer ?? new Float64Array(n);
  out.fill(0);
  const rainMgd = new Float64Array(n);
  const scale = mgPerIn * 96.0;
  for (let i = 0; i < n; i++) rainMgd[i] = rainInArr[i] * scale;

  addConvolvedRtk(out, rainMgd, params[0], params[1], params[2]);
  addConvolvedRtk(out, rainMgd, params[3], params[4], params[5]);
  addConvolvedRtk(out, rainMgd, params[6], params[7], params[8]);
  return out;
}

/**
 * Step 3A: Identify Storm Events and Fit 3-Unit RTK Parameters per Event.
 */
function fitEventsRtk(
  gridStartMs: number,
  flow15m: Float64Array,
  rain15mInHr: Float64Array,
  rain15mIn: Float64Array,
  dwf15m: Float64Array,
  mgPerIn: number,
  gapHours: number,
  minEventIn: number,
  longTailThresholdHours: number
): StormEventRtk[] {
  const n = rain15mIn.length;
  const gapSteps = Math.max(1, Math.round((gapHours * 60) / 15));
  const rawClusters: Array<{ sIdx: number; eIdx: number }> = [];

  let curS = -1;
  let curE = -1;
  for (let i = 0; i < n; i++) {
    if (rain15mIn[i] > 0.002) {
      if (curS === -1) {
        curS = i;
        curE = i;
      } else if (i - curE <= gapSteps) {
        curE = i;
      } else {
        let sumIn = 0;
        for (let k = curS; k <= curE; k++) sumIn += rain15mIn[k];
        if (sumIn >= minEventIn) rawClusters.push({ sIdx: curS, eIdx: curE });
        curS = i;
        curE = i;
      }
    }
  }
  if (curS !== -1) {
    let sumIn = 0;
    for (let k = curS; k <= curE; k++) sumIn += rain15mIn[k];
    if (sumIn >= minEventIn) rawClusters.push({ sIdx: curS, eIdx: curE });
  }

  const dtDays = 15.0 / 1440.0;
  const rtkBounds: Bounds = [
    [0.0, 0.3],
    [0.5, 4.0],
    [0.5, 4.5],
    [0.0, 0.3],
    [2.5, 14.0],
    [0.5, 5.0],
    [0.0, 0.5],
    [12.0, 60.0],
    [1.0, 8.0],
  ];

  const seeds: ReadonlyArray<readonly number[]> = [
    [0.04, 1.5, 1.5, 0.04, 6.0, 2.0, 0.04, 24.0, 3.0],
    [0.08, 1.0, 2.0, 0.06, 8.0, 3.0, 0.15, 36.0, 5.0],
    [0.015, 1.2, 1.5, 0.015, 5.0, 2.0, 0.01, 20.0, 2.5],
  ];

  const results: StormEventRtk[] = [];

  for (let evIdx = 0; evIdx < rawClusters.length; evIdx++) {
    const { sIdx, eIdx } = rawClusters[evIdx];
    const nextStartIdx = evIdx + 1 < rawClusters.length ? rawClusters[evIdx + 1].sIdx : n - 1;
    const sixDaysSteps = 6 * 96;
    const winEndIdx = Math.min(nextStartIdx - 1, eIdx + sixDaysSteps, n - 1);
    if (winEndIdx <= sIdx + 2) continue;

    // Pre-storm 12-hour antecedent offset
    const preStart = Math.max(0, sIdx - 48);
    const preEnd = sIdx - 1;
    let preOffset = 0;
    if (preEnd >= preStart) {
      const diffs: number[] = [];
      for (let k = preStart; k <= preEnd; k++) diffs.push(flow15m[k] - dwf15m[k]);
      preOffset = Math.max(-0.15, Math.min(0.06, medianOfNumbers(diffs)));
    }

    const winLen = winEndIdx - sIdx + 1;
    const rEv = new Float64Array(winLen);
    const obsEv = new Float64Array(winLen);
    let totRainIn = 0;
    let peakInHr = 0;
    let peakRdii = 0;

    for (let k = 0; k < winLen; k++) {
      const gIdx = sIdx + k;
      if (gIdx <= eIdx) {
        rEv[k] = rain15mIn[gIdx];
        totRainIn += rain15mIn[gIdx];
        if (rain15mInHr[gIdx] > peakInHr) peakInHr = rain15mInHr[gIdx];
      }
      const rdii = Math.max(0, flow15m[gIdx] - dwf15m[gIdx] - preOffset);
      obsEv[k] = rdii;
      if (rdii > peakRdii) peakRdii = rdii;
    }

    const simBuf = new Float64Array(winLen);
    const objFn = (p: readonly number[]) => {
      simulateThreeUnitRtk(rEv, mgPerIn, p, simBuf);
      let sse = 0;
      for (let k = 0; k < winLen; k++) {
        const err = obsEv[k] - simBuf[k];
        sse += err * err;
      }
      return sse / winLen;
    };

    let best = boundedPatternSearch(objFn, seeds[0], rtkBounds, 85);
    for (let s = 1; s < seeds.length; s++) {
      const cand = boundedPatternSearch(objFn, seeds[s], rtkBounds, 85);
      if (cand.fx < best.fx) best = cand;
    }

    simulateThreeUnitRtk(rEv, mgPerIn, best.x, simBuf);
    let obsMean = 0;
    let volObsMg = 0;
    for (let k = 0; k < winLen; k++) {
      obsMean += obsEv[k];
      volObsMg += obsEv[k] * dtDays;
    }
    obsMean /= winLen;

    let sse = 0;
    let sst = 0;
    for (let k = 0; k < winLen; k++) {
      const e = obsEv[k] - simBuf[k];
      const d = obsEv[k] - obsMean;
      sse += e * e;
      sst += d * d;
    }
    const nse = sst > 1e-9 ? 1 - sse / sst : 0;
    const volRainMg = totRainIn * mgPerIn;
    const rEmp = volRainMg > 0 ? volObsMg / volRainMg : 0;

    // Measure continuous post-rain groundwater recession tail (> 0.10 MGD above baseline up to 12 days)
    // Stop accumulating once the 12-hour rolling mean excess flow returns to baseline (< 0.06 MGD)
    // after the storm peak so unrelated baseline drift days later is not attributed to an old storm.
    const postEndIdx = Math.min(nextStartIdx, eIdx + 12 * 96, n - 1);
    let tailPts = 0;
    let passedPeak = false;
    for (let k = eIdx; k <= postEndIdx; k++) {
      const ex = flow15m[k] - dwf15m[k] - preOffset;
      if (ex > 0.12) passedPeak = true;
      if (ex > 0.10) tailPts++;

      if (passedPeak && k >= eIdx + 24) {
        const w0 = Math.max(eIdx, k - 47);
        let rollSum = 0;
        for (let m = w0; m <= k; m++) {
          rollSum += flow15m[m] - dwf15m[m] - preOffset;
        }
        const rollMean = rollSum / (k - w0 + 1);
        if (rollMean < 0.06) break;
      }
    }
    const tailHrs = tailPts * 0.25;

    const startMs = gridStartMs + sIdx * MS_15M;
    const endMs = gridStartMs + eIdx * MS_15M;
    const fitEndMs = gridStartMs + winEndIdx * MS_15M;

    results.push({
      eventId: results.length + 1,
      startMs,
      endMs,
      fitWindowEndMs: fitEndMs,
      startIso: formatWallClockIso(startMs),
      endIso: formatWallClockIso(endMs),
      durationHours: Number(((eIdx - sIdx + 1) * 0.25).toFixed(2)),
      totalRainIn: Number(totRainIn.toFixed(3)),
      peakIntensityInHr: Number(peakInHr.toFixed(2)),
      peakRdiiMgd: Number(peakRdii.toFixed(3)),
      excessVolumeMg: Number(volObsMg.toFixed(3)),
      rEmpirical: Number(rEmp.toFixed(4)),
      rTotalFit: Number((best.x[0] + best.x[3] + best.x[6]).toFixed(4)),
      R1: Number(best.x[0].toFixed(4)),
      T1: Number(best.x[1].toFixed(2)),
      K1: Number(best.x[2].toFixed(2)),
      R2: Number(best.x[3].toFixed(4)),
      T2: Number(best.x[4].toFixed(2)),
      K2: Number(best.x[5].toFixed(2)),
      R3: Number(best.x[6].toFixed(4)),
      T3: Number(best.x[7].toFixed(2)),
      K3: Number(best.x[8].toFixed(2)),
      nse: Number(nse.toFixed(3)),
      tailHoursGt01Mgd: Number(tailHrs.toFixed(1)),
      hasLongGroundwaterTail: tailHrs >= longTailThresholdHours,
    });
  }

  return results;
}

/**
 * Simulate Coupled 2-Unit RTK + InfoWorks ICM 2-Store Ground Infiltration Module (GIM).
 */
export function simulateCoupledGim(
  params: readonly number[],
  rain15mIn: Float64Array,
  rainMgdPrescaled: Float64Array,
  dwf15m: Float64Array,
  mgPerIn: number,
  qModOut: Float64Array,
  qRtkOut: Float64Array,
  qGwiOut: Float64Array,
  soilOut?: Float64Array,
  gwOut?: Float64Array
): void {
  const [
    R1, T1, K1,
    R2, T2, K2,
    fInfil,
    sMax, sInit, sThresh, kPerc, pPerc, etDay,
    gInit, gThresh, kGwi, pGwi, gBfThresh, kBf, baseOff,
  ] = params;

  const n = rain15mIn.length;
  const dtDays = 15.0 / 1440.0;
  const invDtDaysMg = mgPerIn / dtDays;

  qRtkOut.fill(0);
  addConvolvedRtk(qRtkOut, rainMgdPrescaled, R1, T1, K1);
  addConvolvedRtk(qRtkOut, rainMgdPrescaled, R2, T2, K2);

  let s = sInit;
  let g = gInit;

  for (let i = 0; i < n; i++) {
    // 1. Soil Store mass balance
    s += fInfil * rain15mIn[i];
    if (s > sMax) s = sMax;

    const etLoss = etDay * dtDays * (s / sMax);
    s -= etLoss < s ? etLoss : s;

    let perc = 0;
    if (s > sThresh) {
      const excessS = s - sThresh;
      const rawPerc = kPerc * Math.pow(excessS, pPerc) * dtDays;
      perc = rawPerc < excessS ? rawPerc : excessS;
      s -= perc;
    }

    // 2. Groundwater Store mass balance
    g += perc;
    if (g > gBfThresh) {
      const excessBf = g - gBfThresh;
      const bfLoss = kBf * excessBf * dtDays;
      g -= bfLoss < excessBf ? bfLoss : excessBf;
    }

    let gwiRateMgd = 0;
    if (g > gThresh) {
      const excessG = g - gThresh;
      const rawGwiIn = kGwi * Math.pow(excessG, pGwi) * dtDays;
      const gwiIn = rawGwiIn < excessG ? rawGwiIn : excessG;
      g -= gwiIn;
      gwiRateMgd = gwiIn * invDtDaysMg;
    }

    qGwiOut[i] = gwiRateMgd;
    qModOut[i] = dwf15m[i] + baseOff + qRtkOut[i] + gwiRateMgd;
    if (soilOut) soilOut[i] = s;
    if (gwOut) gwOut[i] = g;
  }
}

/**
 * Step 3B: Continuous Coupled RTK + InfoWorks ICM Ground Infiltration Calibration
 * plus continuous 3-unit linear RTK benchmark for visual comparison.
 */
function calibrateCoupledSystem(
  gridStartMs: number,
  flow15m: Float64Array,
  rain15mIn: Float64Array,
  dwf15m: Float64Array,
  mgPerIn: number,
  areaAcres: number,
  dwfWeightedMgd: number,
  maxIter: number,
  runGim: boolean,
  reason: string,
  onProgress?: (pct: number, stage: string) => void
): {
  gim: CoupledGimResult;
  modeledTotalMgd: Float64Array;
  rtkFastMedMgd: Float64Array;
  gimGroundwaterMgd: Float64Array;
  pureLinearRtkTotalMgd: Float64Array;
  soilStorageIn: Float64Array;
  gwStorageIn: Float64Array;
} {
  const n = flow15m.length;
  const rainMgd = new Float64Array(n);
  for (let i = 0; i < n; i++) rainMgd[i] = rain15mIn[i] * mgPerIn * 96.0;

  // Precompute day-bucket index mapping for fast daily + 15-min hybrid objective
  const dayCodes = new Int32Array(n);
  let numDays = 0;
  let prevDay = -1;
  for (let i = 0; i < n; i++) {
    const dk = Math.floor((gridStartMs + i * MS_15M) / MS_DAY);
    if (dk !== prevDay) {
      prevDay = dk;
      numDays++;
    }
    dayCodes[i] = numDays - 1;
  }

  const dayCounts = new Int32Array(numDays);
  const obsDaily = new Float64Array(numDays);
  for (let i = 0; i < n; i++) {
    const dc = dayCodes[i];
    dayCounts[dc]++;
    obsDaily[dc] += flow15m[i];
  }
  for (let d = 0; d < numDays; d++) obsDaily[d] /= Math.max(1, dayCounts[d]);

  // Fit continuous 3-unit pure linear RTK benchmark for visual comparison
  const rtkOnlyBuf = new Float64Array(n);
  const rtkContBounds: Bounds = [
    [0.0, 0.25], [0.5, 4.0], [0.5, 4.5],
    [0.0, 0.25], [2.5, 14.0], [0.5, 5.0],
    [0.0, 0.35], [14.0, 72.0], [1.0, 8.0],
  ];
  const rtkContRes = boundedPatternSearch(
    (p) => {
      simulateThreeUnitRtk(rain15mIn, mgPerIn, p, rtkOnlyBuf);
      let sse = 0;
      for (let i = 0; i < n; i++) {
        const e = flow15m[i] - (dwf15m[i] + rtkOnlyBuf[i]);
        sse += e * e;
      }
      return sse / n;
    },
    [0.025, 1.5, 2.0, 0.03, 6.0, 2.5, 0.06, 36.0, 4.0],
    rtkContBounds,
    90
  );
  simulateThreeUnitRtk(rain15mIn, mgPerIn, rtkContRes.x, rtkOnlyBuf);
  const pureLinearRtkTotalMgd = new Float64Array(n);
  for (let i = 0; i < n; i++) pureLinearRtkTotalMgd[i] = dwf15m[i] + rtkOnlyBuf[i];

  const qMod = new Float64Array(n);
  const qRtk = new Float64Array(n);
  const qGwi = new Float64Array(n);
  const soilSt = new Float64Array(n);
  const gwSt = new Float64Array(n);

  if (!runGim) {
    // Use continuous 3-unit RTK when GIM is disabled or no long tails exist
    for (let i = 0; i < n; i++) {
      qRtk[i] = rtkOnlyBuf[i];
      qMod[i] = pureLinearRtkTotalMgd[i];
    }
    const metrics = computeFitMetrics(flow15m, qMod, dayCodes, dayCounts, obsDaily);
    return {
      gim: {
        enabled: false,
        reason,
        R1: Number(rtkContRes.x[0].toFixed(4)),
        T1: Number(rtkContRes.x[1].toFixed(2)),
        K1: Number(rtkContRes.x[2].toFixed(2)),
        R2: Number(rtkContRes.x[3].toFixed(4)),
        T2: Number(rtkContRes.x[4].toFixed(2)),
        K2: Number(rtkContRes.x[5].toFixed(2)),
        fInfil: 0,
        sMaxIn: 0,
        sInitIn: 0,
        sThreshIn: 0,
        kPercDay: 0,
        pPerc: 1,
        etInDay: 0,
        phiGw: 0.15,
        gInitIn: 0,
        gThreshIn: 0,
        kGwiDay: 0,
        pGwi: 1,
        gBfThreshIn: 0,
        kBfDay: 0,
        gInitFt: 0,
        gThreshFt: 0,
        gBfThreshFt: 0,
        baseOffsetMgd: 0,
        metrics,
        icmRows: [],
      },
      modeledTotalMgd: qMod,
      rtkFastMedMgd: qRtk,
      gimGroundwaterMgd: qGwi,
      pureLinearRtkTotalMgd,
      soilStorageIn: soilSt,
      gwStorageIn: gwSt,
    };
  }

  const modDaily = new Float64Array(numDays);
  const gimBounds: Bounds = [
    [0.005, 0.25], [0.5, 4.0], [0.5, 4.5],   // R1, T1, K1
    [0.000, 0.25], [2.0, 14.0], [0.5, 5.0],  // R2, T2, K2
    [0.30, 0.90],                            // fInfil
    [2.5, 8.0],                              // S_max (in)
    [0.0, 2.5],                              // S_init (in)
    [0.5, 3.5],                              // S_thresh (in)
    [0.10, 1.5],                             // k_perc (day^-1)
    [1.0, 2.0],                              // p_perc (-)
    [0.01, 0.12],                            // et_day (in/day)
    [0.0, 3.0],                              // G_init (in)
    [0.5, 6.0],                              // G_thresh (in)
    [0.05, 1.0],                             // k_gwi (day^-1)
    [1.0, 1.8],                              // p_gwi (-)
    [0.0, 3.5],                              // G_bf_thresh (in)
    [0.001, 0.10],                           // k_bf (day^-1)
    [-0.12, 0.06],                           // base_off (MGD)
  ];

  const objGim = (p: readonly number[]) => {
    simulateCoupledGim(p, rain15mIn, rainMgd, dwf15m, mgPerIn, qMod, qRtk, qGwi);
    modDaily.fill(0);
    let sse15 = 0;
    for (let i = 0; i < n; i++) {
      const e = flow15m[i] - qMod[i];
      sse15 += e * e;
      modDaily[dayCodes[i]] += qMod[i];
    }
    let sseDay = 0;
    for (let d = 0; d < numDays; d++) {
      const md = modDaily[d] / Math.max(1, dayCounts[d]);
      const ed = obsDaily[d] - md;
      sseDay += ed * ed;
    }
    return 0.5 * (sse15 / n) + 0.5 * (sseDay / numDays);
  };

  const opt = differentialEvolution(objGim, gimBounds, {
    maxIter,
    popSizeMultiplier: 5,
    seed: 42,
    onProgress: (iter, total) => {
      const pct = 35 + Math.round((iter / total) * 60);
      onProgress?.(pct, `Calibrating InfoWorks ICM 2-Store GIM (${iter}/${total})...`);
    },
  });

  simulateCoupledGim(opt.x, rain15mIn, rainMgd, dwf15m, mgPerIn, qMod, qRtk, qGwi, soilSt, gwSt);
  const metrics = computeFitMetrics(flow15m, qMod, dayCodes, dayCounts, obsDaily);

  const [
    R1, T1, K1,
    R2, T2, K2,
    fInfil,
    sMax, sInit, sThresh, kPerc, pPerc, etDay,
    gInit, gThresh, kGwi, pGwi, gBfThresh, kBf, baseOff,
  ] = opt.x;

  const phiGw = 0.15;
  const gInitFt = gInit / (12 * phiGw);
  const gThreshFt = gThresh / (12 * phiGw);
  const gBfThreshFt = gBfThresh / (12 * phiGw);

  const icmRows: IcmParameterRow[] = [
    {
      icmObject: 'Subcatchment',
      parameter: 'Total Contributing Area',
      value: areaAcres.toFixed(2),
      units: 'acres',
      notes: `${mgPerIn.toFixed(4)} MG per inch of rainfall`,
    },
    {
      icmObject: 'Wastewater Profile',
      parameter: 'Observed Clean-Day Weighted DWF',
      value: dwfWeightedMgd.toFixed(4),
      units: 'MGD',
      notes: '5/7 Weekday + 2/7 Weekend clean dry-day baseline',
    },
    {
      icmObject: 'Wastewater Profile',
      parameter: 'Calibrated Base Sanitary Flow',
      value: (dwfWeightedMgd + baseOff).toFixed(4),
      units: 'MGD',
      notes: `DWF ${baseOff >= 0 ? '+' : ''}${baseOff.toFixed(4)} MGD offset when GWI = 0`,
    },
    {
      icmObject: 'RTK Hydrograph',
      parameter: 'Fast Response (R1 / T1 / K1)',
      value: `${R1.toFixed(4)} / ${T1.toFixed(2)} hr / ${K1.toFixed(2)}`,
      units: '- / hr / -',
      notes: 'Direct inflow (manholes, roof leaders, connected drains)',
    },
    {
      icmObject: 'RTK Hydrograph',
      parameter: 'Medium Response (R2 / T2 / K2)',
      value: `${R2.toFixed(4)} / ${T2.toFixed(2)} hr / ${K2.toFixed(2)}`,
      units: '- / hr / -',
      notes: 'Shallow trench / service lateral interflow',
    },
    {
      icmObject: 'RTK Hydrograph',
      parameter: 'Slow Response (R3)',
      value: '0.0000',
      units: '-',
      notes: 'Replaced by physical InfoWorks ICM Ground Infiltration store',
    },
    {
      icmObject: 'Runoff Surface',
      parameter: 'Pervious Infiltration Fraction (f_infil)',
      value: fInfil.toFixed(4),
      units: '-',
      notes: `${(fInfil * areaAcres).toFixed(1)} effective pervious acres recharging Soil Store`,
    },
    {
      icmObject: 'GIM Soil Store',
      parameter: 'Soil Storage Capacity (S_max)',
      value: sMax.toFixed(3),
      units: 'in',
      notes: `Unsaturated root-zone capacity (e.g. ${(sMax / 0.32).toFixed(1)} in depth @ 32% porosity)`,
    },
    {
      icmObject: 'GIM Soil Store',
      parameter: 'Initial Soil Moisture (S_init)',
      value: sInit.toFixed(3),
      units: 'in',
      notes: `${((100 * sInit) / sMax).toFixed(1)}% of soil capacity at start of period`,
    },
    {
      icmObject: 'GIM Soil Store',
      parameter: 'Percolation Threshold (S_thresh)',
      value: sThresh.toFixed(3),
      units: 'in',
      notes: `Field capacity (${((100 * sThresh) / sMax).toFixed(1)}% of S_max) triggering recharge`,
    },
    {
      icmObject: 'GIM Soil Store',
      parameter: 'Percolation Coefficient (k_perc)',
      value: kPerc.toFixed(4),
      units: 'day⁻¹',
      notes: `Characteristic drainage residence ~${(1 / kPerc).toFixed(1)} days`,
    },
    {
      icmObject: 'GIM Soil Store',
      parameter: 'Percolation Power (p_perc)',
      value: pPerc.toFixed(3),
      units: '-',
      notes: 'Nonlinear soil drainage exponent',
    },
    {
      icmObject: 'GIM Soil Store',
      parameter: 'Soil Evapotranspiration (ET)',
      value: etDay.toFixed(4),
      units: 'in/day',
      notes: 'Actual ET = ET_max × (S / S_max) recovery between storms',
    },
    {
      icmObject: 'GIM Groundwater',
      parameter: 'Effective Aquifer Porosity (φ_gw)',
      value: phiGw.toFixed(2),
      units: '-',
      notes: 'Converts water-equivalent storage depth (in) to head (ft)',
    },
    {
      icmObject: 'GIM Groundwater',
      parameter: 'Initial Groundwater Level (G_init)',
      value: gInitFt.toFixed(3),
      units: 'ft',
      notes: `${gInit.toFixed(3)} in water equivalent above datum`,
    },
    {
      icmObject: 'GIM Groundwater',
      parameter: 'Sewer Infiltration Threshold (G_thresh)',
      value: gThreshFt.toFixed(3),
      units: 'ft',
      notes: `Pipe invert datum (${gThresh.toFixed(3)} in water eq.); zero GWI below level`,
    },
    {
      icmObject: 'GIM Groundwater',
      parameter: 'Infiltration Coefficient (k_gwi)',
      value: kGwi.toFixed(4),
      units: 'day⁻¹',
      notes: `≈ ${(kGwi * 12 * phiGw * mgPerIn).toFixed(3)} MGD/ft head above pipe invert`,
    },
    {
      icmObject: 'GIM Groundwater',
      parameter: 'Infiltration Power (p_gwi)',
      value: pGwi.toFixed(3),
      units: '-',
      notes: 'Defect orifice/joint head-infiltration exponent',
    },
    {
      icmObject: 'GIM Groundwater',
      parameter: 'Deep Baseflow Threshold (G_bf_thresh)',
      value: gBfThreshFt.toFixed(3),
      units: 'ft',
      notes: `${gBfThresh.toFixed(3)} in water equivalent regional drainage threshold`,
    },
    {
      icmObject: 'GIM Groundwater',
      parameter: 'Baseflow Loss Coefficient (k_bf)',
      value: kBf.toFixed(4),
      units: 'day⁻¹',
      notes: 'Aquifer loss to regional water table / streams',
    },
  ];

  return {
    gim: {
      enabled: true,
      reason,
      R1: Number(R1.toFixed(4)),
      T1: Number(T1.toFixed(2)),
      K1: Number(K1.toFixed(2)),
      R2: Number(R2.toFixed(4)),
      T2: Number(T2.toFixed(2)),
      K2: Number(K2.toFixed(2)),
      fInfil: Number(fInfil.toFixed(4)),
      sMaxIn: Number(sMax.toFixed(3)),
      sInitIn: Number(sInit.toFixed(3)),
      sThreshIn: Number(sThresh.toFixed(3)),
      kPercDay: Number(kPerc.toFixed(4)),
      pPerc: Number(pPerc.toFixed(3)),
      etInDay: Number(etDay.toFixed(4)),
      phiGw,
      gInitIn: Number(gInit.toFixed(3)),
      gThreshIn: Number(gThresh.toFixed(3)),
      kGwiDay: Number(kGwi.toFixed(4)),
      pGwi: Number(pGwi.toFixed(3)),
      gBfThreshIn: Number(gBfThresh.toFixed(3)),
      kBfDay: Number(kBf.toFixed(4)),
      gInitFt: Number(gInitFt.toFixed(3)),
      gThreshFt: Number(gThreshFt.toFixed(3)),
      gBfThreshFt: Number(gBfThreshFt.toFixed(3)),
      baseOffsetMgd: Number(baseOff.toFixed(4)),
      metrics,
      icmRows,
    },
    modeledTotalMgd: qMod,
    rtkFastMedMgd: qRtk,
    gimGroundwaterMgd: qGwi,
    pureLinearRtkTotalMgd,
    soilStorageIn: soilSt,
    gwStorageIn: gwSt,
  };
}

function computeFitMetrics(
  obs15m: Float64Array,
  mod15m: Float64Array,
  dayCodes: Int32Array,
  dayCounts: Int32Array,
  obsDaily: Float64Array
) {
  const n = obs15m.length;
  const numDays = obsDaily.length;
  const modDaily = new Float64Array(numDays);

  let obsSum = 0;
  let modSum = 0;
  for (let i = 0; i < n; i++) {
    obsSum += obs15m[i];
    modSum += mod15m[i];
    modDaily[dayCodes[i]] += mod15m[i];
  }
  const obsMean = obsSum / Math.max(1, n);

  let sse15 = 0;
  let sst15 = 0;
  for (let i = 0; i < n; i++) {
    const e = obs15m[i] - mod15m[i];
    const d = obs15m[i] - obsMean;
    sse15 += e * e;
    sst15 += d * d;
  }

  let obsDayMean = 0;
  for (let d = 0; d < numDays; d++) {
    modDaily[d] /= Math.max(1, dayCounts[d]);
    obsDayMean += obsDaily[d];
  }
  obsDayMean /= Math.max(1, numDays);

  let sseDay = 0;
  let sstDay = 0;
  for (let d = 0; d < numDays; d++) {
    const e = obsDaily[d] - modDaily[d];
    const v = obsDaily[d] - obsDayMean;
    sseDay += e * e;
    sstDay += v * v;
  }

  return {
    nse15m: Number((sst15 > 1e-9 ? 1 - sse15 / sst15 : 0).toFixed(4)),
    nseDaily: Number((sstDay > 1e-9 ? 1 - sseDay / sstDay : 0).toFixed(4)),
    rmse15mMgd: Number(Math.sqrt(sse15 / Math.max(1, n)).toFixed(4)),
    rmseDailyMgd: Number(Math.sqrt(sseDay / Math.max(1, numDays)).toFixed(4)),
    volumeErrorPct: Number(
      (obsSum > 1e-9 ? (100 * (modSum - obsSum)) / obsSum : 0).toFixed(2)
    ),
  };
}

/**
 * Master Pipeline: Run full sewer telemetry smoothing, DWF extraction, event RTK, and InfoWorks ICM GIM calibration.
 */
export function runFullHydrologyPipeline(
  flowRawText: string,
  rainRawText: string,
  config: AnalysisConfig,
  onProgress?: (pct: number, stage: string) => void
): FullAnalysisResult {
  onProgress?.(5, 'Parsing rainfall hyetograph & sewer flow telemetry...');
  const flowParsed: TimeSeriesData = parseTelemetryText(flowRawText, 'flow');
  const rainParsed: TimeSeriesData = parseTelemetryText(rainRawText, 'rain');

  const flowScale = FLOW_TO_MGD[config.flowUnit];
  const flowMgd = new Float64Array(flowParsed.values.length);
  for (let i = 0; i < flowParsed.values.length; i++) {
    flowMgd[i] = Math.max(0, flowParsed.values[i] * flowScale);
  }

  const rainInHrNative = convertRainToInHr(
    rainParsed.values,
    config.rainUnit,
    rainParsed.medianStepMin
  );

  const areaAcres = config.areaValue * AREA_TO_ACRES[config.areaUnit];
  if (!Number.isFinite(areaAcres) || areaAcres <= 0) {
    throw new Error('Enter a positive contributing service area greater than 0.');
  }
  const mgPerInchOverArea = (areaAcres * 43560.0 * 7.48051945) / (12.0 * 1e6);

  onProgress?.(14, 'Analyzing upstream pump cycling & smoothing raw flow...');
  const { smoothed: flowSmoothedNative, diagnostics: pump } = detectAndSmoothPumpFlow(
    flowParsed.timestampsMs,
    flowMgd,
    flowParsed.medianStepMin,
    config.enablePumpSmoothing,
    config.smoothWindowMinOverride
  );

  // Build overlapping 15-min uniform grid anchored to flow monitoring domain
  const gridStartMs = Math.floor(flowParsed.timestampsMs[0] / MS_15M) * MS_15M;
  const gridEndMs =
    Math.floor(flowParsed.timestampsMs[flowParsed.timestampsMs.length - 1] / MS_15M) * MS_15M;
  const nGrid = Math.floor((gridEndMs - gridStartMs) / MS_15M) + 1;

  if (nGrid < 96) {
    throw new Error('Flow dataset spans less than 24 hours. Upload at least 1 day of monitoring data.');
  }

  const flow15mSmooth = resampleFlowTo15m(
    flowParsed.timestampsMs,
    flowSmoothedNative,
    gridStartMs,
    nGrid
  );
  const flow15mRaw = resampleFlowTo15m(flowParsed.timestampsMs, flowMgd, gridStartMs, nGrid);
  const rain15mInHr = resampleRainTo15mInHr(
    rainParsed.timestampsMs,
    rainInHrNative,
    gridStartMs,
    nGrid
  );
  const rain15mIn = new Float64Array(nGrid);
  let totalRainDepthIn = 0;
  for (let i = 0; i < nGrid; i++) {
    rain15mIn[i] = rain15mInHr[i] * 0.25;
    totalRainDepthIn += rain15mIn[i];
  }

  onProgress?.(22, 'Extracting clean dry-weather days & 24-hr weekday/weekend diurnal profiles...');
  const { summary: dwf, dwf15m } = extractDwfAndDiurnal(gridStartMs, flow15mSmooth, rain15mIn);

  onProgress?.(30, 'Isolating storm events & fitting 3-unit RTK hydrographs...');
  const events = fitEventsRtk(
    gridStartMs,
    flow15mSmooth,
    rain15mInHr,
    rain15mIn,
    dwf15m,
    mgPerInchOverArea,
    config.interEventGapHours,
    config.minEventDepthIn,
    config.longTailThresholdHours
  );

  const maxTailHours = events.reduce((mx, e) => Math.max(mx, e.tailHoursGt01Mgd), 0);
  const shouldRunGim =
    config.enableCoupledGim === 'always' ||
    (config.enableCoupledGim === 'auto' && maxTailHours >= config.longTailThresholdHours);

  const gimReason = shouldRunGim
    ? config.enableCoupledGim === 'always'
      ? 'Coupled InfoWorks ICM Ground Infiltration Module forced ON by user setting.'
      : `Long groundwater recession tail detected (max ${maxTailHours.toFixed(
          1
        )} hr ≥ ${config.longTailThresholdHours.toFixed(0)} hr threshold) — InfoWorks ICM 2-Store GIM activated.`
    : config.enableCoupledGim === 'off'
    ? 'InfoWorks ICM Ground Infiltration Module disabled by user setting.'
    : `All storm recession tails (${maxTailHours.toFixed(
        1
      )} hr max) subsided within ${config.longTailThresholdHours.toFixed(
        0
      )} hr — standard 3-unit RTK is sufficient.`;

  const calibrated = calibrateCoupledSystem(
    gridStartMs,
    flow15mSmooth,
    rain15mIn,
    dwf15m,
    mgPerInchOverArea,
    areaAcres,
    dwf.weightedMeanMgd,
    config.optimizerIterations,
    shouldRunGim,
    gimReason,
    onProgress
  );

  onProgress?.(98, 'Packaging calibrated hydrographs & InfoWorks ICM tables...');

  const timestamps15m = new Array<number>(nGrid);
  const dwfBaselineMgd = new Array<number>(nGrid);
  const baseOff = calibrated.gim.baseOffsetMgd;
  for (let i = 0; i < nGrid; i++) {
    timestamps15m[i] = gridStartMs + i * MS_15M;
    dwfBaselineMgd[i] = dwf15m[i] + baseOff;
  }

  return {
    config,
    areaAcres,
    mgPerInchOverArea,
    periodStartIso: formatWallClockIso(gridStartMs),
    periodEndIso: formatWallClockIso(gridEndMs),
    totalRainDepthIn: Number(totalRainDepthIn.toFixed(3)),
    pump,
    dwf,
    events,
    maxTailHours,
    gim: calibrated.gim,
    series15m: {
      timestampsMs: timestamps15m,
      rainInHr: Array.from(rain15mInHr),
      rainDepthIn: Array.from(rain15mIn),
      flowObservedSmoothMgd: Array.from(flow15mSmooth),
      flowRawInterpMgd: Array.from(flow15mRaw),
      dwfBaselineMgd,
      modeledTotalMgd: Array.from(calibrated.modeledTotalMgd),
      rtkFastMedMgd: Array.from(calibrated.rtkFastMedMgd),
      gimGroundwaterMgd: Array.from(calibrated.gimGroundwaterMgd),
      pureLinearRtkTotalMgd: Array.from(calibrated.pureLinearRtkTotalMgd),
      soilStorageIn: Array.from(calibrated.soilStorageIn),
      gwStorageIn: Array.from(calibrated.gwStorageIn),
    },
    highResFlow: {
      timestampsMs: Array.from(flowParsed.timestampsMs),
      rawMgd: Array.from(flowMgd),
      smoothedMgd: Array.from(flowSmoothedNative),
    },
  };
}
