import type { AreaUnit, FlowUnit, RainUnit, TimeSeriesData } from './types';

export const FLOW_TO_MGD: Record<FlowUnit, number> = {
  MGD: 1.0,
  cfs: 0.64631688,
  gpm: 0.00144,
  'L/s': 0.022824465,
  'm3/s': 22.824465,
};

export const AREA_TO_ACRES: Record<AreaUnit, number> = {
  acres: 1.0,
  hectares: 2.4710538,
  sq_mi: 640.0,
  km2: 247.10538,
};

/**
 * Parse naive wall-clock date strings into UTC epoch ms so DST shifts never distort hydraulic intervals.
 * Supports:
 *  - M/D/YYYY H:mm[:ss] [AM/PM]
 *  - M/D/YY H:mm[:ss] [AM/PM]
 *  - YYYY-MM-DD[T ]HH:mm[:ss]
 *  - YYYY/MM/DD HH:mm[:ss]
 */
export function parseWallClockTimestamp(raw: string): number | null {
  const s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s) return null;

  // Pattern 1: M/D/YY(YY) H:mm(:ss) (AM/PM)
  const usMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM|am|pm))?$/.exec(s);
  if (usMatch) {
    const month = Number(usMatch[1]);
    const day = Number(usMatch[2]);
    let year = Number(usMatch[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    let hour = Number(usMatch[4]);
    const minute = Number(usMatch[5]);
    const second = usMatch[6] ? Number(usMatch[6]) : 0;
    const ampm = usMatch[7]?.toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }

  // Pattern 2: YYYY-MM-DD or YYYY/MM/DD [T ] HH:mm(:ss)
  const isoMatch = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const hour = isoMatch[4] ? Number(isoMatch[4]) : 0;
    const minute = isoMatch[5] ? Number(isoMatch[5]) : 0;
    const second = isoMatch[6] ? Number(isoMatch[6]) : 0;
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }

  const fallback = Date.parse(s);
  return Number.isFinite(fallback) ? fallback : null;
}

export function formatWallClockIso(ms: number, includeTime = true): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (!includeTime) return `${yyyy}-${mm}-${dd}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function medianOfNumbers(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 !== 0 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/**
 * Parse InfoWorks CustomFile (.txt), TSV, or CSV rainfall/flow telemetry.
 */
export function parseTelemetryText(text: string, valueHint: 'flow' | 'rain'): TimeSeriesData {
  const lines = text.split(/\r?\n/);
  let startIdx = 0;
  while (startIdx < lines.length && !lines[startIdx].trim()) {
    startIdx++;
  }
  if (startIdx >= lines.length) {
    throw new Error('Uploaded file is empty. Select a two-column Date and Value text or CSV file.');
  }

  // Skip leading InfoWorks ICM "CustomFile" banner line if present
  if (lines[startIdx].trim().toLowerCase().startsWith('customfile')) {
    startIdx++;
  }
  while (startIdx < lines.length && !lines[startIdx].trim()) {
    startIdx++;
  }

  const headerLine = lines[startIdx] ?? '';
  const delimiter = headerLine.includes('\t') ? '\t' : headerLine.includes(',') ? ',' : /\s{2,}|\t|,/;
  const splitLine = (line: string) =>
    typeof delimiter === 'string' ? line.split(delimiter) : line.split(delimiter);

  const firstTokens = splitLine(headerLine).map((c) => c.trim());
  let dateCol = 0;
  let valCol = 1;
  let detectedHeader = 'Date, Value';

  const firstTs = firstTokens.length >= 2 ? parseWallClockTimestamp(firstTokens[0]) : null;
  const firstVal = firstTokens.length >= 2 ? Number(firstTokens[1]) : NaN;

  if (firstTs === null || !Number.isFinite(firstVal)) {
    // Header row present
    detectedHeader = firstTokens.join(' | ');
    for (let c = 0; c < firstTokens.length; c++) {
      const lc = firstTokens[c].toLowerCase();
      if (lc.includes('date') || lc.includes('time')) {
        dateCol = c;
        break;
      }
    }
    for (let c = 0; c < firstTokens.length; c++) {
      const lc = firstTokens[c].toLowerCase();
      if (lc.includes(valueHint) || (valueHint === 'rain' && lc.includes('precip'))) {
        valCol = c;
        break;
      }
    }
    if (valCol === dateCol) {
      valCol = dateCol === 0 ? 1 : 0;
    }
    startIdx++;
  }

  const pairs: Array<{ t: number; v: number }> = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = splitLine(line);
    if (cols.length <= Math.max(dateCol, valCol)) continue;
    const t = parseWallClockTimestamp(cols[dateCol]);
    const v = Number(cols[valCol].trim());
    if (t !== null && Number.isFinite(v)) {
      pairs.push({ t, v });
    }
  }

  if (pairs.length < 12) {
    throw new Error(
      `Only ${pairs.length} valid timestamped records were found. Verify that the file contains a timestamp column and numeric ${valueHint} column.`
    );
  }

  pairs.sort((a, b) => a.t - b.t);

  // Deduplicate identical timestamps (keep first)
  const dedupT: number[] = [pairs[0].t];
  const dedupV: number[] = [pairs[0].v];
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i].t > dedupT[dedupT.length - 1]) {
      dedupT.push(pairs[i].t);
      dedupV.push(pairs[i].v);
    }
  }

  const diffsMin: number[] = [];
  const sampleLimit = Math.min(dedupT.length - 1, 2000);
  for (let i = 0; i < sampleLimit; i++) {
    const dm = (dedupT[i + 1] - dedupT[i]) / 60_000;
    if (dm > 0) diffsMin.push(dm);
  }
  const medianStepMin = diffsMin.length > 0 ? medianOfNumbers(diffsMin) : 15;

  return {
    timestampsMs: Float64Array.from(dedupT),
    values: Float64Array.from(dedupV),
    medianStepMin,
    detectedHeader,
  };
}

/**
 * Convert raw rainfall values into intensity (in/hr) on the native rainfall series.
 */
export function convertRainToInHr(values: Float64Array, rainUnit: RainUnit, dtMin: number): Float64Array {
  const dtHr = Math.max(dtMin / 60.0, 1 / 60);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const raw = Math.max(0, values[i]);
    switch (rainUnit) {
      case 'in/hr':
        out[i] = raw;
        break;
      case 'in':
        out[i] = raw / dtHr;
        break;
      case 'mm/hr':
        out[i] = raw / 25.4;
        break;
      case 'mm':
        out[i] = raw / 25.4 / dtHr;
        break;
    }
  }
  return out;
}

export function convertFlowFromMgd(mgd: number, targetUnit: FlowUnit): number {
  return mgd / FLOW_TO_MGD[targetUnit];
}

export function convertRainIntensityFromInHr(inHr: number, targetUnit: RainUnit, stepHours = 0.25): number {
  switch (targetUnit) {
    case 'in/hr':
      return inHr;
    case 'in':
      return inHr * stepHours;
    case 'mm/hr':
      return inHr * 25.4;
    case 'mm':
      return inHr * 25.4 * stepHours;
  }
}
