import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Maximize2,
  MousePointerClick,
  MoveHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  convertFlowFromMgd,
  convertRainIntensityFromInHr,
  formatWallClockIso,
} from '../engine/parser';
import type {
  FlowUnit,
  FullAnalysisResult,
  RainUnit,
  StormEventRtk,
} from '../engine/types';

interface SplitHorizonCanvasProps {
  result: FullAnalysisResult;
  displayFlowUnit: FlowUnit;
  displayRainUnit: RainUnit;
  zoomDomain: [number, number];
  onZoomDomainChange: (domain: [number, number]) => void;
  selectedEventId: number | null;
  onSelectEvent: (ev: StormEventRtk) => void;
  showRaw5m: boolean;
  onToggleRaw5m: (val: boolean) => void;
}

interface HoverReadout {
  xPx: number;
  tsMs: number;
  rainVal: number;
  obsSmoothVal: number;
  rawFlowVal: number | null;
  dwfVal: number;
  modeledVal: number;
  rtkVal: number;
  gwiVal: number;
  activeEvent: StormEventRtk | null;
}

function binarySearchNearest(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1] - target) < Math.abs(arr[lo] - target)) {
    return lo - 1;
  }
  return lo;
}

function niceStep(range: number, targetTicks: number): number {
  if (range <= 0) return 1;
  const rough = range / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  if (norm < 1.5) return 1 * mag;
  if (norm < 3) return 2 * mag;
  if (norm < 7) return 5 * mag;
  return 10 * mag;
}

export const SplitHorizonCanvas: React.FC<SplitHorizonCanvasProps> = ({
  result,
  displayFlowUnit,
  displayRainUnit,
  zoomDomain,
  onZoomDomainChange,
  selectedEventId,
  onSelectEvent,
  showRaw5m,
  onToggleRaw5m,
}) => {
  const mainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const miniCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({
    w: 960,
    h: 460,
  });
  const [interactionMode, setInteractionMode] = useState<'boxZoom' | 'pan'>('boxZoom');
  const [showSmoothed, setShowSmoothed] = useState(true);
  const [showModeled, setShowModeled] = useState(true);
  const [showDwf, setShowDwf] = useState(true);
  const [showGwiFill, setShowGwiFill] = useState(true);
  const [showPureRtk, setShowPureRtk] = useState(false);

  const [hover, setHover] = useState<HoverReadout | null>(null);
  const [dragBoxPx, setDragBoxPx] = useState<[number, number] | null>(null);

  const dragStateRef = useRef<{
    kind: 'box' | 'pan' | 'miniMove' | 'miniLeft' | 'miniRight';
    startX: number;
    origDomain: [number, number];
  } | null>(null);

  const s15 = result.series15m;
  const fullMinMs = s15.timestampsMs[0];
  const fullMaxMs = s15.timestampsMs[s15.timestampsMs.length - 1];
  const minSpanMs = 2 * 3600_000; // 2 hours minimum zoom

  const padLeft = 62;
  const padRight = 22;
  const padTop = 14;
  const padBottom = 30;

  // Track responsive container width
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(360, Math.floor(entry.contentRect.width));
        setCanvasSize({ w, h: w < 640 ? 390 : 465 });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clampDomain = useCallback(
    (d0: number, d1: number): [number, number] => {
      let span = Math.max(minSpanMs, d1 - d0);
      const maxSpan = fullMaxMs - fullMinMs;
      if (span >= maxSpan) return [fullMinMs, fullMaxMs];
      let a = d0;
      let b = a + span;
      if (a < fullMinMs) {
        a = fullMinMs;
        b = a + span;
      }
      if (b > fullMaxMs) {
        b = fullMaxMs;
        a = b - span;
      }
      return [a, b];
    },
    [fullMinMs, fullMaxMs, minSpanMs]
  );

  const zoomByFactor = useCallback(
    (factor: number, anchorMs?: number) => {
      const [z0, z1] = zoomDomain;
      const curSpan = z1 - z0;
      const pivot = anchorMs ?? 0.5 * (z0 + z1);
      const ratio = (pivot - z0) / Math.max(1, curSpan);
      const nextSpan = curSpan * factor;
      const next0 = pivot - ratio * nextSpan;
      onZoomDomainChange(clampDomain(next0, next0 + nextSpan));
    },
    [zoomDomain, clampDomain, onZoomDomainChange]
  );

  const applyPresetHours = (hours: number | null) => {
    if (hours === null) {
      onZoomDomainChange([fullMinMs, fullMaxMs]);
      return;
    }
    const center = 0.5 * (zoomDomain[0] + zoomDomain[1]);
    const half = hours * 3600_000 * 0.5;
    onZoomDomainChange(clampDomain(center - half, center + half));
  };

  // Visible storm pills in the current zoom window (horizontally de-collided by priority)
  const visibleEvents = useMemo(() => {
    const [z0, z1] = zoomDomain;
    const plotW = Math.max(1, canvasSize.w - padLeft - padRight);
    const candidates = result.events
      .filter((ev) => ev.endMs >= z0 && ev.startMs <= z1)
      .map((ev) => {
        const xStart = padLeft + Math.max(0, ((ev.startMs - z0) / (z1 - z0)) * plotW);
        const xEnd = padLeft + Math.min(plotW, ((ev.endMs - z0) / (z1 - z0)) * plotW);
        return {
          ev,
          xMid: 0.5 * (xStart + xEnd),
        };
      })
      .filter((item) => item.xMid >= padLeft + 14 && item.xMid <= canvasSize.w - padRight - 14);

    // Prioritize selected storm -> long GWI tail storms -> larger rainfall depths
    const prioritized = [...candidates].sort((a, b) => {
      const aSel = a.ev.eventId === selectedEventId ? 1 : 0;
      const bSel = b.ev.eventId === selectedEventId ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      const aGwi = a.ev.hasLongGroundwaterTail ? 1 : 0;
      const bGwi = b.ev.hasLongGroundwaterTail ? 1 : 0;
      if (aGwi !== bGwi) return bGwi - aGwi;
      return b.ev.totalRainIn - a.ev.totalRainIn;
    });

    const accepted: typeof candidates = [];
    const minGapPx = 33;
    for (const item of prioritized) {
      if (accepted.every((placed) => Math.abs(placed.xMid - item.xMid) >= minGapPx)) {
        accepted.push(item);
      }
    }
    return accepted.sort((a, b) => a.xMid - b.xMid);
  }, [result.events, zoomDomain, canvasSize.w, selectedEventId]);

  // Render Main Split-Horizon Canvas
  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = canvasSize;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;
    const rainBandH = Math.floor(plotH * 0.27);
    const gapBandH = 22;
    const flowTopY = padTop + rainBandH + gapBandH;
    const flowBandH = plotH - rainBandH - gapBandH;
    const flowBottomY = flowTopY + flowBandH;

    // Subtle instrument background bands
    ctx.fillStyle = '#F7FAFC';
    ctx.fillRect(padLeft, padTop, plotW, rainBandH);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(padLeft, flowTopY, plotW, flowBandH);

    const [z0, z1] = zoomDomain;
    const spanMs = Math.max(1, z1 - z0);
    const xOfMs = (ms: number) => padLeft + ((ms - z0) / spanMs) * plotW;

    const iStart = Math.max(0, binarySearchNearest(s15.timestampsMs, z0) - 1);
    const iEnd = Math.min(
      s15.timestampsMs.length - 1,
      binarySearchNearest(s15.timestampsMs, z1) + 1
    );

    // Determine dynamic Y ranges within visible zoom window
    let maxRain = 0.2;
    let maxFlow = 0.5;
    for (let i = iStart; i <= iEnd; i++) {
      const rDisp = convertRainIntensityFromInHr(s15.rainInHr[i], displayRainUnit, 0.25);
      if (rDisp > maxRain) maxRain = rDisp;

      if (showSmoothed) {
        const f = convertFlowFromMgd(s15.flowObservedSmoothMgd[i], displayFlowUnit);
        if (f > maxFlow) maxFlow = f;
      }
      if (showModeled) {
        const m = convertFlowFromMgd(s15.modeledTotalMgd[i], displayFlowUnit);
        if (m > maxFlow) maxFlow = m;
      }
      if (showPureRtk) {
        const p = convertFlowFromMgd(s15.pureLinearRtkTotalMgd[i], displayFlowUnit);
        if (p > maxFlow) maxFlow = p;
      }
      if (showDwf) {
        const d = convertFlowFromMgd(s15.dwfBaselineMgd[i], displayFlowUnit);
        if (d > maxFlow) maxFlow = d;
      }
    }

    if (showRaw5m) {
      const hrStart = Math.max(0, binarySearchNearest(result.highResFlow.timestampsMs, z0) - 1);
      const hrEnd = Math.min(
        result.highResFlow.timestampsMs.length - 1,
        binarySearchNearest(result.highResFlow.timestampsMs, z1) + 1
      );
      for (let i = hrStart; i <= hrEnd; i++) {
        const rf = convertFlowFromMgd(result.highResFlow.rawMgd[i], displayFlowUnit);
        if (rf > maxFlow) maxFlow = rf;
      }
    }

    maxRain *= 1.16;
    maxFlow *= 1.12;

    const yOfRain = (rVal: number) => padTop + Math.min(1, rVal / maxRain) * rainBandH;
    const yOfFlow = (fVal: number) =>
      flowBottomY - Math.min(1.05, Math.max(0, fVal / maxFlow)) * flowBandH;

    // Shaded storm event corridors
    for (const ev of result.events) {
      if (ev.fitWindowEndMs < z0 || ev.startMs > z1) continue;
      const xs = Math.max(padLeft, xOfMs(ev.startMs));
      const xeRain = Math.min(padLeft + plotW, xOfMs(ev.endMs));
      const isSel = ev.eventId === selectedEventId;

      if (xeRain > xs) {
        ctx.fillStyle = isSel
          ? 'rgba(10, 102, 194, 0.16)'
          : ev.hasLongGroundwaterTail
          ? 'rgba(88, 66, 195, 0.08)'
          : 'rgba(10, 102, 194, 0.05)';
        ctx.fillRect(xs, padTop, Math.max(2, xeRain - xs), rainBandH);
        ctx.fillRect(xs, flowTopY, Math.max(2, xeRain - xs), flowBandH);
      }

      if (isSel) {
        ctx.strokeStyle = 'rgba(10, 102, 194, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xs, padTop);
        ctx.lineTo(xs, flowBottomY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Horizontal gridlines & Y-axis labels (Rain - Left/Right)
    ctx.font = '500 10.5px "JetBrains Mono", monospace';
    const rainStep = niceStep(maxRain, 3);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let rv = 0; rv <= maxRain * 1.001; rv += rainStep) {
      const y = yOfRain(rv);
      ctx.strokeStyle = '#E2EBF2';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#0A66C2';
      ctx.fillText(rv.toFixed(rv < 1 ? 2 : 1), padLeft - 8, y);
    }

    // Horizontal gridlines & Y-axis labels (Flow - Left)
    const flowStep = niceStep(maxFlow, 5);
    for (let fv = 0; fv <= maxFlow * 1.001; fv += flowStep) {
      const y = yOfFlow(fv);
      ctx.strokeStyle = '#E2EBF2';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#334E68';
      ctx.fillText(fv.toFixed(maxFlow < 5 ? 2 : 1), padLeft - 8, y);
    }

    // Vertical time gridlines & X-axis labels
    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const showClock = spanMs < 6 * 86_400_000;
    const minTickPx = showClock ? 112 : 82;
    const targetTimeTicks = Math.max(2, Math.floor(plotW / minTickPx));
    const timeCandidatesMs = [
      15 * 60_000,
      30 * 60_000,
      3600_000,
      3 * 3600_000,
      6 * 3600_000,
      12 * 3600_000,
      24 * 3600_000,
      2 * 86_400_000,
      5 * 86_400_000,
      7 * 86_400_000,
      14 * 86_400_000,
      21 * 86_400_000,
      28 * 86_400_000,
    ];
    let tStep = timeCandidatesMs[timeCandidatesMs.length - 1];
    for (const c of timeCandidatesMs) {
      if (spanMs / c <= targetTimeTicks) {
        tStep = c;
        break;
      }
    }
    const firstTick = Math.ceil(z0 / tStep) * tStep;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = firstTick; t <= z1; t += tStep) {
      const x = xOfMs(t);
      ctx.strokeStyle = '#EBF1F5';
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, rainBandH + padTop);
      ctx.moveTo(x, flowTopY);
      ctx.lineTo(x, flowBottomY);
      ctx.stroke();

      if (x >= padLeft + 24 && x <= padLeft + plotW - 24) {
        const d = new Date(t);
        const mon = MONTHS_SHORT[d.getUTCMonth()];
        const day = String(d.getUTCDate()).padStart(2, '0');
        let label = `${mon} ${day}`;
        if (showClock) {
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const mm = String(d.getUTCMinutes()).padStart(2, '0');
          label = `${mon} ${day} ${hh}:${mm}`;
        }
        ctx.fillStyle = '#4A6275';
        ctx.fillText(label, x, flowBottomY + 8);
      }
    }

    // Clip to plot area for series rendering
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, plotW, plotH);
    ctx.clip();

    // 1. Draw Inverted Ceiling Hyetograph Bars
    const stepPx = (15 * 60_000 * plotW) / spanMs;
    if (stepPx >= 1.5) {
      const barW = Math.max(1.2, stepPx * 0.84);
      ctx.fillStyle = '#0A66C2';
      for (let i = iStart; i <= iEnd; i++) {
        const rv = convertRainIntensityFromInHr(s15.rainInHr[i], displayRainUnit, 0.25);
        if (rv <= 0) continue;
        const x = xOfMs(s15.timestampsMs[i]);
        const hBar = yOfRain(rv) - padTop;
        ctx.fillRect(x - barW * 0.5, padTop, barW, Math.max(1, hBar));
      }
    } else {
      // Pixel-column max bucketing when zoomed out so storm peaks never vanish
      const bucketMax = new Float64Array(plotW);
      for (let i = iStart; i <= iEnd; i++) {
        const rv = convertRainIntensityFromInHr(s15.rainInHr[i], displayRainUnit, 0.25);
        if (rv <= 0) continue;
        const px = Math.floor(((s15.timestampsMs[i] - z0) / spanMs) * plotW);
        if (px >= 0 && px < plotW && rv > bucketMax[px]) bucketMax[px] = rv;
      }
      ctx.fillStyle = '#0A66C2';
      for (let px = 0; px < plotW; px++) {
        if (bucketMax[px] > 0) {
          const hBar = yOfRain(bucketMax[px]) - padTop;
          ctx.fillRect(padLeft + px, padTop, 1.5, Math.max(1, hBar));
        }
      }
    }

    // 2. Draw Translucent Phreatic Aquifer Tail (ICM Ground Infiltration)
    if (showGwiFill && result.gim.enabled) {
      ctx.fillStyle = 'rgba(88, 66, 195, 0.18)';
      ctx.beginPath();
      let started = false;
      for (let i = iStart; i <= iEnd; i++) {
        const x = xOfMs(s15.timestampsMs[i]);
        const y = yOfFlow(convertFlowFromMgd(s15.gimGroundwaterMgd[i], displayFlowUnit));
        if (!started) {
          ctx.moveTo(x, flowBottomY);
          ctx.lineTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (started) {
        ctx.lineTo(xOfMs(s15.timestampsMs[iEnd]), flowBottomY);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = '#5842C3';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = iStart; i <= iEnd; i++) {
        const x = xOfMs(s15.timestampsMs[i]);
        const y = yOfFlow(convertFlowFromMgd(s15.gimGroundwaterMgd[i], displayFlowUnit));
        if (i === iStart) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 3. Draw Raw 5-min Pump Flow (min-max envelope when dense, exact polyline when zoomed in)
    if (showRaw5m) {
      const hrT = result.highResFlow.timestampsMs;
      const hrV = result.highResFlow.rawMgd;
      const h0 = Math.max(0, binarySearchNearest(hrT, z0) - 1);
      const h1 = Math.min(hrT.length - 1, binarySearchNearest(hrT, z1) + 1);
      const countVis = h1 - h0 + 1;

      if (countVis <= plotW * 2.5) {
        ctx.strokeStyle = 'rgba(120, 144, 165, 0.68)';
        ctx.lineWidth = 1.05;
        ctx.beginPath();
        for (let i = h0; i <= h1; i++) {
          const x = xOfMs(hrT[i]);
          const y = yOfFlow(convertFlowFromMgd(hrV[i], displayFlowUnit));
          if (i === h0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        const colMin = new Float64Array(plotW).fill(Infinity);
        const colMax = new Float64Array(plotW).fill(-Infinity);
        for (let i = h0; i <= h1; i++) {
          const px = Math.floor(((hrT[i] - z0) / spanMs) * plotW);
          if (px >= 0 && px < plotW) {
            const v = convertFlowFromMgd(hrV[i], displayFlowUnit);
            if (v < colMin[px]) colMin[px] = v;
            if (v > colMax[px]) colMax[px] = v;
          }
        }
        ctx.strokeStyle = 'rgba(120, 144, 165, 0.42)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let px = 0; px < plotW; px++) {
          if (colMin[px] <= colMax[px]) {
            ctx.moveTo(padLeft + px + 0.5, yOfFlow(colMax[px]));
            ctx.lineTo(padLeft + px + 0.5, yOfFlow(colMin[px]));
          }
        }
        ctx.stroke();
      }
    }

    // Helper for 15-min polylines (decimated to min/max per pixel if >2x plotW)
    const draw15mSeries = (
      arrMgd: number[],
      color: string,
      width: number,
      dash: number[] = []
    ) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      for (let i = iStart; i <= iEnd; i++) {
        const x = xOfMs(s15.timestampsMs[i]);
        const y = yOfFlow(convertFlowFromMgd(arrMgd[i], displayFlowUnit));
        if (i === iStart) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    if (showDwf) {
      draw15mSeries(s15.dwfBaselineMgd, '#2E7D32', 1.35, [5, 4]);
    }
    if (showPureRtk) {
      draw15mSeries(s15.pureLinearRtkTotalMgd, '#64748B', 1.4, [2, 3]);
    }
    if (showSmoothed) {
      draw15mSeries(s15.flowObservedSmoothMgd, '#0B7A75', 2.0);
    }
    if (showModeled) {
      draw15mSeries(s15.modeledTotalMgd, '#C95B12', 1.85);
    }

    // Marquee zoom selection box
    if (dragBoxPx) {
      const xA = Math.max(padLeft, Math.min(dragBoxPx[0], dragBoxPx[1]));
      const xB = Math.min(padLeft + plotW, Math.max(dragBoxPx[0], dragBoxPx[1]));
      ctx.fillStyle = 'rgba(10, 102, 194, 0.14)';
      ctx.fillRect(xA, padTop, xB - xA, plotH);
      ctx.strokeStyle = '#0A66C2';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(xA, padTop, xB - xA, plotH);
    }

    // Hover crosshair
    if (hover && hover.xPx >= padLeft && hover.xPx <= padLeft + plotW) {
      ctx.strokeStyle = 'rgba(13, 33, 48, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.xPx, padTop);
      ctx.lineTo(hover.xPx, flowBottomY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    // Crisp outer borders for Split-Horizon bands
    ctx.strokeStyle = '#CFDCE6';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, plotW, rainBandH);
    ctx.strokeRect(padLeft, flowTopY, plotW, flowBandH);

    // Rotated Y-axis unit titles
    ctx.save();
    ctx.fillStyle = '#0A66C2';
    ctx.font = '600 10.5px "Plus Jakarta Sans", sans-serif';
    ctx.translate(15, padTop + rainBandH * 0.5);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(`Rain (${displayRainUnit})`, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#0D2130';
    ctx.font = '600 11px "Plus Jakarta Sans", sans-serif';
    ctx.translate(15, flowTopY + flowBandH * 0.5);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(`Sewer Flow (${displayFlowUnit})`, 0, 0);
    ctx.restore();

    ctx.restore();
  }, [
    canvasSize,
    zoomDomain,
    s15,
    result,
    displayFlowUnit,
    displayRainUnit,
    showRaw5m,
    showSmoothed,
    showModeled,
    showDwf,
    showGwiFill,
    showPureRtk,
    selectedEventId,
    dragBoxPx,
    hover,
  ]);

  // Render Bottom Overview Minimap Scrubber
  useEffect(() => {
    const mini = miniCanvasRef.current;
    if (!mini) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvasSize.w;
    const h = 54;
    mini.width = Math.floor(w * dpr);
    mini.height = Math.floor(h * dpr);
    const ctx = mini.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const plotW = w - padLeft - padRight;
    const topY = 4;
    const innerH = h - 8;
    ctx.fillStyle = '#F5F8FB';
    ctx.fillRect(padLeft, topY, plotW, innerH);

    let maxF = 0.5;
    let maxR = 0.2;
    for (let i = 0; i < s15.flowObservedSmoothMgd.length; i++) {
      if (s15.flowObservedSmoothMgd[i] > maxF) maxF = s15.flowObservedSmoothMgd[i];
      if (s15.rainInHr[i] > maxR) maxR = s15.rainInHr[i];
    }

    const fullSpan = Math.max(1, fullMaxMs - fullMinMs);
    // Rain ticks from top of minimap
    ctx.fillStyle = 'rgba(10, 102, 194, 0.55)';
    for (let i = 0; i < s15.rainInHr.length; i++) {
      if (s15.rainInHr[i] <= 0) continue;
      const x = padLeft + ((s15.timestampsMs[i] - fullMinMs) / fullSpan) * plotW;
      const rh = (s15.rainInHr[i] / maxR) * (innerH * 0.42);
      ctx.fillRect(x, topY, 1.4, Math.max(1, rh));
    }

    // Flow silhouette along bottom of minimap
    ctx.strokeStyle = '#0B7A75';
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    const stride = Math.max(1, Math.floor(s15.timestampsMs.length / plotW));
    for (let i = 0; i < s15.timestampsMs.length; i += stride) {
      const x = padLeft + ((s15.timestampsMs[i] - fullMinMs) / fullSpan) * plotW;
      const y = topY + innerH - (s15.flowObservedSmoothMgd[i] / (maxF * 1.1)) * (innerH * 0.72);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Shaded outside-viewport curtains + draggable brush frame
    const vx0 = padLeft + ((zoomDomain[0] - fullMinMs) / fullSpan) * plotW;
    const vx1 = padLeft + ((zoomDomain[1] - fullMinMs) / fullSpan) * plotW;

    ctx.fillStyle = 'rgba(13, 33, 48, 0.12)';
    ctx.fillRect(padLeft, topY, Math.max(0, vx0 - padLeft), innerH);
    ctx.fillRect(vx1, topY, Math.max(0, padLeft + plotW - vx1), innerH);

    ctx.strokeStyle = '#0A66C2';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(vx0, topY + 0.5, Math.max(4, vx1 - vx0), innerH - 1);

    // Handle grips
    ctx.fillStyle = '#0A66C2';
    ctx.fillRect(vx0 - 3, topY + innerH * 0.25, 6, innerH * 0.5);
    ctx.fillRect(vx1 - 3, topY + innerH * 0.25, 6, innerH * 0.5);

    ctx.strokeStyle = '#CFDCE6';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, topY, plotW, innerH);
    ctx.restore();
  }, [canvasSize.w, s15, fullMinMs, fullMaxMs, zoomDomain]);

  // Native non-passive wheel listener for smooth cursor-anchored zoom
  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const plotW = canvasSize.w - padLeft - padRight;
      if (x < padLeft || x > padLeft + plotW) return;
      const frac = (x - padLeft) / plotW;
      const anchorMs = zoomDomain[0] + frac * (zoomDomain[1] - zoomDomain[0]);
      const factor = e.deltaY < 0 ? 0.78 : 1.28;
      zoomByFactor(factor, anchorMs);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasSize.w, zoomDomain, zoomByFactor]);

  const handleMainMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotW = canvasSize.w - padLeft - padRight;
    if (x < padLeft || x > padLeft + plotW) return;

    const usePan = interactionMode === 'pan' || e.shiftKey;
    dragStateRef.current = {
      kind: usePan ? 'pan' : 'box',
      startX: x,
      origDomain: [zoomDomain[0], zoomDomain[1]],
    };
    if (!usePan) setDragBoxPx([x, x]);
  };

  const handleMainMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotW = canvasSize.w - padLeft - padRight;

    const st = dragStateRef.current;
    if (st) {
      if (st.kind === 'box') {
        setDragBoxPx([st.startX, x]);
      } else if (st.kind === 'pan') {
        const dx = x - st.startX;
        const dt = (-dx / plotW) * (st.origDomain[1] - st.origDomain[0]);
        onZoomDomainChange(clampDomain(st.origDomain[0] + dt, st.origDomain[1] + dt));
      }
      return;
    }

    if (x < padLeft || x > padLeft + plotW) {
      setHover(null);
      return;
    }

    const targetMs =
      zoomDomain[0] + ((x - padLeft) / plotW) * (zoomDomain[1] - zoomDomain[0]);
    const idx = binarySearchNearest(s15.timestampsMs, targetMs);
    const tsMs = s15.timestampsMs[idx];
    const snapX =
      padLeft + ((tsMs - zoomDomain[0]) / Math.max(1, zoomDomain[1] - zoomDomain[0])) * plotW;

    let rawVal: number | null = null;
    if (showRaw5m) {
      const rIdx = binarySearchNearest(result.highResFlow.timestampsMs, tsMs);
      rawVal = convertFlowFromMgd(result.highResFlow.rawMgd[rIdx], displayFlowUnit);
    }

    const activeEvent =
      result.events.find((ev) => tsMs >= ev.startMs && tsMs <= ev.fitWindowEndMs) ?? null;

    setHover({
      xPx: snapX,
      tsMs,
      rainVal: convertRainIntensityFromInHr(s15.rainInHr[idx], displayRainUnit, 0.25),
      obsSmoothVal: convertFlowFromMgd(s15.flowObservedSmoothMgd[idx], displayFlowUnit),
      rawFlowVal: rawVal,
      dwfVal: convertFlowFromMgd(s15.dwfBaselineMgd[idx], displayFlowUnit),
      modeledVal: convertFlowFromMgd(s15.modeledTotalMgd[idx], displayFlowUnit),
      rtkVal: convertFlowFromMgd(s15.rtkFastMedMgd[idx], displayFlowUnit),
      gwiVal: convertFlowFromMgd(s15.gimGroundwaterMgd[idx], displayFlowUnit),
      activeEvent,
    });
  };

  const finishDrag = useCallback(() => {
    const st = dragStateRef.current;
    if (st && st.kind === 'box' && dragBoxPx) {
      const plotW = canvasSize.w - padLeft - padRight;
      const xA = Math.max(padLeft, Math.min(dragBoxPx[0], dragBoxPx[1]));
      const xB = Math.min(padLeft + plotW, Math.max(dragBoxPx[0], dragBoxPx[1]));
      if (xB - xA >= 10) {
        const [z0, z1] = st.origDomain;
        const n0 = z0 + ((xA - padLeft) / plotW) * (z1 - z0);
        const n1 = z0 + ((xB - padLeft) / plotW) * (z1 - z0);
        onZoomDomainChange(clampDomain(n0, n1));
      }
    }
    dragStateRef.current = null;
    setDragBoxPx(null);
  }, [dragBoxPx, canvasSize.w, clampDomain, onZoomDomainChange]);

  // Minimap drag interaction
  const handleMiniMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotW = canvasSize.w - padLeft - padRight;
    if (x < padLeft || x > padLeft + plotW) return;

    const fullSpan = Math.max(1, fullMaxMs - fullMinMs);
    const vx0 = padLeft + ((zoomDomain[0] - fullMinMs) / fullSpan) * plotW;
    const vx1 = padLeft + ((zoomDomain[1] - fullMinMs) / fullSpan) * plotW;

    if (Math.abs(x - vx0) <= 8) {
      dragStateRef.current = { kind: 'miniLeft', startX: x, origDomain: [...zoomDomain] };
    } else if (Math.abs(x - vx1) <= 8) {
      dragStateRef.current = { kind: 'miniRight', startX: x, origDomain: [...zoomDomain] };
    } else if (x > vx0 && x < vx1) {
      dragStateRef.current = { kind: 'miniMove', startX: x, origDomain: [...zoomDomain] };
    } else {
      const clickMs = fullMinMs + ((x - padLeft) / plotW) * fullSpan;
      const half = 0.5 * (zoomDomain[1] - zoomDomain[0]);
      onZoomDomainChange(clampDomain(clickMs - half, clickMs + half));
    }
  };

  useEffect(() => {
    const onWinMove = (e: MouseEvent) => {
      const st = dragStateRef.current;
      if (!st || (st.kind !== 'miniMove' && st.kind !== 'miniLeft' && st.kind !== 'miniRight')) {
        return;
      }
      const mini = miniCanvasRef.current;
      if (!mini) return;
      const rect = mini.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const plotW = canvasSize.w - padLeft - padRight;
      const fullSpan = Math.max(1, fullMaxMs - fullMinMs);
      const dt = ((x - st.startX) / plotW) * fullSpan;

      if (st.kind === 'miniMove') {
        onZoomDomainChange(clampDomain(st.origDomain[0] + dt, st.origDomain[1] + dt));
      } else if (st.kind === 'miniLeft') {
        const next0 = Math.max(fullMinMs, Math.min(st.origDomain[1] - minSpanMs, st.origDomain[0] + dt));
        onZoomDomainChange([next0, st.origDomain[1]]);
      } else if (st.kind === 'miniRight') {
        const next1 = Math.min(fullMaxMs, Math.max(st.origDomain[0] + minSpanMs, st.origDomain[1] + dt));
        onZoomDomainChange([st.origDomain[0], next1]);
      }
    };
    const onWinUp = () => {
      if (dragStateRef.current) finishDrag();
    };
    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);
    return () => {
      window.removeEventListener('mousemove', onWinMove);
      window.removeEventListener('mouseup', onWinUp);
    };
  }, [canvasSize.w, fullMinMs, fullMaxMs, minSpanMs, clampDomain, onZoomDomainChange, finishDrag]);

  const spanDays = (zoomDomain[1] - zoomDomain[0]) / 86_400_000;

  return (
    <section className="instrument-panel canvas-panel" ref={wrapRef}>
      {/* Top Toolbar: Zoom / Interaction Controls + Series Toggles */}
      <div className="canvas-toolbar">
        <div className="canvas-toolbar-group">
          <span className="eyebrow-tag">HYETOGRAPH × HYDROGRAPH</span>
          <div className="segmented-btns" role="group" aria-label="Drag behavior">
            <button
              type="button"
              className={interactionMode === 'boxZoom' ? 'active' : ''}
              onClick={() => setInteractionMode('boxZoom')}
              title="Drag across chart to zoom into time window"
            >
              <MousePointerClick size={13} /> Drag Zoom
            </button>
            <button
              type="button"
              className={interactionMode === 'pan' ? 'active' : ''}
              onClick={() => setInteractionMode('pan')}
              title="Drag left/right to pan across timeline"
            >
              <MoveHorizontal size={13} /> Pan
            </button>
          </div>

          <div className="zoom-btn-strip">
            <button type="button" onClick={() => zoomByFactor(0.68)} title="Zoom in">
              <ZoomIn size={14} />
            </button>
            <button type="button" onClick={() => zoomByFactor(1.45)} title="Zoom out">
              <ZoomOut size={14} />
            </button>
            <button type="button" onClick={() => applyPresetHours(48)}>
              48h
            </button>
            <button type="button" onClick={() => applyPresetHours(7 * 24)}>
              7d
            </button>
            <button type="button" onClick={() => applyPresetHours(30 * 24)}>
              30d
            </button>
            <button
              type="button"
              className="reset-zoom-btn"
              onClick={() => applyPresetHours(null)}
              title="Reset to full monitoring period"
            >
              <Maximize2 size={12} /> Full ({spanDays.toFixed(1)}d)
            </button>
          </div>
        </div>

        <div className="series-toggle-strip">
          <label className="series-chip">
            <input
              type="checkbox"
              checked={showRaw5m}
              onChange={(e) => onToggleRaw5m(e.target.checked)}
            />
            <span className="swatch swatch-raw" />
            Raw ({result.pump.dtMin}m)
          </label>
          <label className="series-chip">
            <input
              type="checkbox"
              checked={showSmoothed}
              onChange={(e) => setShowSmoothed(e.target.checked)}
            />
            <span className="swatch swatch-obs" />
            Smoothed Flow
          </label>
          <label className="series-chip">
            <input
              type="checkbox"
              checked={showModeled}
              onChange={(e) => setShowModeled(e.target.checked)}
            />
            <span className="swatch swatch-mod" />
            Coupled Model
          </label>
          <label className="series-chip">
            <input
              type="checkbox"
              checked={showDwf}
              onChange={(e) => setShowDwf(e.target.checked)}
            />
            <span className="swatch swatch-dwf" />
            DWF
          </label>
          {result.gim.enabled && (
            <label className="series-chip">
              <input
                type="checkbox"
                checked={showGwiFill}
                onChange={(e) => setShowGwiFill(e.target.checked)}
              />
              <span className="swatch swatch-gwi" />
              ICM GWI Tail
            </label>
          )}
          <label className="series-chip">
            <input
              type="checkbox"
              checked={showPureRtk}
              onChange={(e) => setShowPureRtk(e.target.checked)}
            />
            <span className="swatch swatch-rtk-linear" />
            Linear RTK Only
          </label>
        </div>
      </div>

      {/* Live Telemetry Readout Ribbon */}
      <div className="telemetry-readout-bar">
        {hover ? (
          <>
            <span className="mono-val ts-badge">{formatWallClockIso(hover.tsMs)}</span>
            <span className="mono-val rain-text">
              Rain: <strong>{hover.rainVal.toFixed(2)}</strong> {displayRainUnit}
            </span>
            <span className="mono-val obs-text">
              Smoothed: <strong>{hover.obsSmoothVal.toFixed(3)}</strong> {displayFlowUnit}
            </span>
            {hover.rawFlowVal !== null && (
              <span className="mono-val muted-text">
                Raw: <strong>{hover.rawFlowVal.toFixed(3)}</strong>
              </span>
            )}
            <span className="mono-val mod-text">
              Modeled: <strong>{hover.modeledVal.toFixed(3)}</strong> {displayFlowUnit}
            </span>
            <span className="mono-val dwf-text">
              DWF: <strong>{hover.dwfVal.toFixed(3)}</strong>
            </span>
            <span className="mono-val gwi-text">
              RTK / GWI: <strong>{hover.rtkVal.toFixed(3)}</strong> /{' '}
              <strong>{hover.gwiVal.toFixed(3)}</strong>
            </span>
            {hover.activeEvent && (
              <span className="event-hover-tag">
                Storm E{hover.activeEvent.eventId} ({hover.activeEvent.totalRainIn} in)
              </span>
            )}
          </>
        ) : (
          <span className="telemetry-hint">
            Scroll wheel to zoom around cursor · Drag across plot to zoom window · Click any E1–E
            {result.events.length} storm badge to inspect event & groundwater tail
          </span>
        )}
      </div>

      {/* Main Split-Horizon Canvas + Clickable Horizon Event Badges */}
      <div className="canvas-stage">
        <canvas
          ref={mainCanvasRef}
          style={{
            width: `${canvasSize.w}px`,
            height: `${canvasSize.h}px`,
            cursor: interactionMode === 'pan' ? 'grab' : 'crosshair',
          }}
          onMouseDown={handleMainMouseDown}
          onMouseMove={handleMainMouseMove}
          onMouseLeave={() => setHover(null)}
          onDoubleClick={() => applyPresetHours(null)}
        />

        {/* Storm Event Horizon Pills */}
        <div
          className="horizon-event-layer"
          style={{
            top: `${padTop + Math.floor((canvasSize.h - padTop - padBottom) * 0.27) + 2}px`,
          }}
        >
          {visibleEvents.map(({ ev, xMid }) => {
            if (xMid < padLeft + 14 || xMid > canvasSize.w - padRight - 14) return null;
            const isSel = ev.eventId === selectedEventId;
            return (
              <button
                key={ev.eventId}
                type="button"
                className={`horizon-pill ${ev.hasLongGroundwaterTail ? 'gwi-tail' : ''} ${
                  isSel ? 'selected' : ''
                }`}
                style={{ left: `${xMid}px` }}
                onClick={() => onSelectEvent(ev)}
                title={`Storm E${ev.eventId}: ${ev.totalRainIn} in rain, Tail=${ev.tailHoursGt01Mgd} hr — click to zoom`}
              >
                E{ev.eventId}
              </button>
            );
          })}
        </div>
      </div>

      {/* Overview Brush / Scrubber */}
      <div className="minimap-wrap">
        <canvas
          ref={miniCanvasRef}
          style={{ width: `${canvasSize.w}px`, height: '54px', cursor: 'ew-resize' }}
          onMouseDown={handleMiniMouseDown}
        />
      </div>
    </section>
  );
};
