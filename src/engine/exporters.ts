import { convertFlowFromMgd, formatWallClockIso } from './parser';
import type { FlowUnit, FullAnalysisResult, StormEventRtk } from './types';

function sanitizeTsvCell(val: string | number): string {
  return String(val).replace(/[\t\r\n]+/g, ' ').trim();
}

function execCommandCopyFallback(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const inIframe = typeof window !== 'undefined' && window !== window.top;
  if (inIframe) {
    const syncOk = execCommandCopyFallback(text);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => undefined);
    }
    if (syncOk) return true;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to synchronous textarea copy below
    }
  }
  return execCommandCopyFallback(text);
}

function escapeCsv(val: string | number): string {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildEventRtkCsv(res: FullAnalysisResult): string {
  const headers = [
    'Event',
    'Start',
    'End',
    'Duration_hr',
    'Rain_in',
    'Peak_in_hr',
    'Peak_RDII_MGD',
    'Excess_MG',
    'R_emp',
    'R_fit',
    'R1',
    'T1_hr',
    'K1',
    'R2',
    'T2_hr',
    'K2',
    'R3',
    'T3_hr',
    'K3',
    'NSE',
    'Tail_gt0.1_hr',
    'Long_GW_Tail',
  ];
  const lines = [headers.join(',')];
  for (const e of res.events) {
    lines.push(
      [
        e.eventId,
        e.startIso,
        e.endIso,
        e.durationHours,
        e.totalRainIn,
        e.peakIntensityInHr,
        e.peakRdiiMgd,
        e.excessVolumeMg,
        e.rEmpirical,
        e.rTotalFit,
        e.R1,
        e.T1,
        e.K1,
        e.R2,
        e.T2,
        e.K2,
        e.R3,
        e.T3,
        e.K3,
        e.nse,
        e.tailHoursGt01Mgd,
        e.hasLongGroundwaterTail ? 'YES' : 'NO',
      ]
        .map(escapeCsv)
        .join(',')
    );
  }
  return lines.join('\n');
}

export function buildIcmParametersCsv(res: FullAnalysisResult): string {
  const headers = ['ICM_Object', 'Parameter', 'Value', 'Units', 'Notes'];
  const lines = [headers.join(',')];
  for (const row of res.gim.icmRows) {
    lines.push(
      [row.icmObject, row.parameter, row.value, row.units, row.notes]
        .map(escapeCsv)
        .join(',')
    );
  }
  return lines.join('\n');
}

export function buildDiurnalCsv(res: FullAnalysisResult): string {
  const headers = [
    'Hour',
    'Weekday_Flow_MGD',
    'Weekday_Factor',
    'Weekend_Flow_MGD',
    'Weekend_Factor',
  ];
  const lines = [headers.join(',')];
  for (const row of res.dwf.diurnal) {
    lines.push(
      [
        row.hour,
        row.weekdayFlowMgd.toFixed(4),
        row.weekdayFactor.toFixed(4),
        row.weekendFlowMgd.toFixed(4),
        row.weekendFactor.toFixed(4),
      ].join(',')
    );
  }
  return lines.join('\n');
}

export function buildDiurnalTsv(
  res: FullAnalysisResult,
  displayFlowUnit: FlowUnit = 'MGD'
): string {
  const headers = [
    'Hour',
    `Weekday (${displayFlowUnit})`,
    'WD Factor',
    `Weekend (${displayFlowUnit})`,
    'WE Factor',
  ];
  const lines = [headers.join('\t')];
  for (const row of res.dwf.diurnal) {
    lines.push(
      [
        `${String(row.hour).padStart(2, '0')}:00`,
        convertFlowFromMgd(row.weekdayFlowMgd, displayFlowUnit).toFixed(3),
        row.weekdayFactor.toFixed(3),
        convertFlowFromMgd(row.weekendFlowMgd, displayFlowUnit).toFixed(3),
        row.weekendFactor.toFixed(3),
      ].join('\t')
    );
  }
  return lines.join('\n');
}

export function buildEventRtkTsv(
  events: StormEventRtk[],
  displayFlowUnit: FlowUnit = 'MGD'
): string {
  const headers = [
    'ID',
    'Storm Start',
    'Storm End',
    'Duration (hr)',
    'Rain (in)',
    'Peak (in/hr)',
    `Peak RDII (${displayFlowUnit})`,
    'Excess (MG)',
    'R_emp',
    'R_fit',
    'R1',
    'T1 (hr)',
    'K1',
    'R2',
    'T2 (hr)',
    'K2',
    'R3',
    'T3 (hr)',
    'K3',
    'NSE',
    'Tail >0.1 MGD (hr)',
    'Long GW Tail',
  ];
  const lines = [headers.join('\t')];
  for (const e of events) {
    lines.push(
      [
        `E${e.eventId}`,
        e.startIso,
        e.endIso,
        e.durationHours.toFixed(2),
        e.totalRainIn.toFixed(2),
        e.peakIntensityInHr.toFixed(2),
        convertFlowFromMgd(e.peakRdiiMgd, displayFlowUnit).toFixed(2),
        e.excessVolumeMg.toFixed(2),
        e.rEmpirical.toFixed(3),
        e.rTotalFit.toFixed(3),
        e.R1.toFixed(4),
        e.T1.toFixed(2),
        e.K1.toFixed(2),
        e.R2.toFixed(4),
        e.T2.toFixed(2),
        e.K2.toFixed(2),
        e.R3.toFixed(4),
        e.T3.toFixed(2),
        e.K3.toFixed(2),
        e.nse.toFixed(2),
        e.tailHoursGt01Mgd.toFixed(1),
        e.hasLongGroundwaterTail ? 'YES' : 'NO',
      ]
        .map(sanitizeTsvCell)
        .join('\t')
    );
  }
  return lines.join('\n');
}

export function buildIcmParametersTsv(res: FullAnalysisResult): string {
  const headers = [
    'InfoWorks ICM Object',
    'Parameter',
    'Calibrated Value',
    'Units',
    'Engineering Notes',
  ];
  const lines = [headers.join('\t')];
  for (const row of res.gim.icmRows) {
    lines.push(
      [row.icmObject, row.parameter, row.value, row.units, row.notes]
        .map(sanitizeTsvCell)
        .join('\t')
    );
  }
  return lines.join('\n');
}

export function buildAlignedSeriesCsv(res: FullAnalysisResult): string {
  const headers = [
    'Timestamp',
    'Rain_in_hr',
    'Rain_Depth_in',
    'Flow_Obs_Smoothed_MGD',
    'Baseline_Flow_MGD',
    'Diurnal_Flow_MGD',
    'Base_Plus_Diurnal_MGD',
    'RTK_RDII_MGD',
    'ICM_GWI_Tail_MGD',
    'Modeled_Total_MGD',
    'Soil_Store_in',
    'GW_Store_in',
  ];
  const lines = [headers.join(',')];
  const s = res.series15m;
  const baseStr = res.baselineFlowMgd.toFixed(4);
  for (let i = 0; i < s.timestampsMs.length; i++) {
    lines.push(
      [
        formatWallClockIso(s.timestampsMs[i]),
        s.rainInHr[i].toFixed(4),
        s.rainDepthIn[i].toFixed(4),
        s.flowObservedSmoothMgd[i].toFixed(4),
        baseStr,
        s.diurnalFlowMgd[i].toFixed(4),
        s.dwfBaselineMgd[i].toFixed(4),
        s.rtkFastMedMgd[i].toFixed(4),
        s.gimGroundwaterMgd[i].toFixed(4),
        s.modeledTotalMgd[i].toFixed(4),
        s.soilStorageIn[i].toFixed(4),
        s.gwStorageIn[i].toFixed(4),
      ].join(',')
    );
  }
  return lines.join('\n');
}

export function triggerTextDownload(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
