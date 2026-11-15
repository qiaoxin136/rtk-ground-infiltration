import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, Focus } from 'lucide-react';
import {
  buildEventRtkCsv,
  buildEventRtkTsv,
  copyTextToClipboard,
  triggerTextDownload,
} from '../engine/exporters';
import { convertFlowFromMgd } from '../engine/parser';
import type { FlowUnit, FullAnalysisResult, StormEventRtk } from '../engine/types';

interface StormEventsPanelProps {
  result: FullAnalysisResult;
  displayFlowUnit: FlowUnit;
  selectedEventId: number | null;
  onSelectEvent: (ev: StormEventRtk) => void;
}

export const StormEventsPanel: React.FC<StormEventsPanelProps> = ({
  result,
  displayFlowUnit,
  selectedEventId,
  onSelectEvent,
}) => {
  const [onlyLongTail, setOnlyLongTail] = useState(false);
  const [copiedEvents, setCopiedEvents] = useState(false);

  const filtered = useMemo(
    () =>
      onlyLongTail
        ? result.events.filter((e) => e.hasLongGroundwaterTail)
        : result.events,
    [result.events, onlyLongTail]
  );

  const handleCopyEventsTable = async () => {
    const ok = await copyTextToClipboard(buildEventRtkTsv(filtered, displayFlowUnit));
    if (ok) {
      setCopiedEvents(true);
      setTimeout(() => setCopiedEvents(false), 2000);
    }
  };

  const activeEvent = useMemo(
    () =>
      result.events.find((e) => e.eventId === selectedEventId) ??
      result.events[0] ??
      null,
    [result.events, selectedEventId]
  );

  // Build SVG paths for the 3 RTK triangular unit hydrographs of the active event
  const triangleKernelPlot = useMemo(() => {
    if (!activeEvent) return null;
    const maxTimeHr = Math.min(
      140,
      Math.max(
        24,
        activeEvent.T1 * (1 + activeEvent.K1),
        activeEvent.T2 * (1 + activeEvent.K2),
        activeEvent.R3 > 0.001 ? activeEvent.T3 * (1 + activeEvent.K3) : 24
      )
    );

    const w = 360;
    const h = 155;
    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 26;
    const pw = w - padL - padR;
    const ph = h - padT - padB;

    const peak1 =
      activeEvent.R1 > 0 ? (2 * activeEvent.R1) / (activeEvent.T1 * (1 + activeEvent.K1)) : 0;
    const peak2 =
      activeEvent.R2 > 0 ? (2 * activeEvent.R2) / (activeEvent.T2 * (1 + activeEvent.K2)) : 0;
    const peak3 =
      activeEvent.R3 > 0 ? (2 * activeEvent.R3) / (activeEvent.T3 * (1 + activeEvent.K3)) : 0;
    const maxPeak = Math.max(0.002, peak1, peak2, peak3) * 1.15;

    const xOf = (hr: number) => padL + Math.min(1, hr / maxTimeHr) * pw;
    const yOf = (u: number) => padT + ph - (u / maxPeak) * ph;

    const triPts = (r: number, t: number, k: number) => {
      if (r <= 0.0002) return '';
      const pk = (2 * r) / (t * (1 + k));
      const end = t * (1 + k);
      return `${xOf(0)},${yOf(0)} ${xOf(t)},${yOf(pk)} ${xOf(end)},${yOf(0)}`;
    };

    return {
      w,
      h,
      padL,
      padT,
      pw,
      ph,
      maxTimeHr,
      maxPeak,
      pts1: triPts(activeEvent.R1, activeEvent.T1, activeEvent.K1),
      pts2: triPts(activeEvent.R2, activeEvent.T2, activeEvent.K2),
      pts3: triPts(activeEvent.R3, activeEvent.T3, activeEvent.K3),
    };
  }, [activeEvent]);

  return (
    <div className="workbench-grid events-layout">
      <div className="instrument-panel">
        <div className="panel-header-row">
          <div>
            <h3 className="panel-title">
              Identified Storm Events & 3-Unit RTK Calibration ({filtered.length} of{' '}
              {result.events.length})
            </h3>
            <p className="panel-subtitle">
              Click any storm row to zoom the Split-Horizon Canvas to that event and inspect its
              post-storm recession tail.
            </p>
          </div>
          <div className="panel-actions">
            <label className="filter-check">
              <input
                type="checkbox"
                checked={onlyLongTail}
                onChange={(e) => setOnlyLongTail(e.target.checked)}
              />
              Long GW tails only (≥{result.config.longTailThresholdHours}h)
            </label>
            <button
              type="button"
              className={`btn-secondary ${copiedEvents ? 'btn-copied' : ''}`}
              onClick={handleCopyEventsTable}
              disabled={filtered.length === 0}
            >
              {copiedEvents ? <Check size={14} /> : <Copy size={14} />}
              {copiedEvents ? `Copied ${filtered.length} Rows` : 'Copy Table'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                triggerTextDownload('event_rtk_parameters.csv', buildEventRtkCsv(result))
              }
            >
              <Download size={14} /> Export RTK CSV
            </button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-callout">
            No storm events matched the current filter criteria. Lower minimum storm depth or
            uncheck the long-tail filter.
          </div>
        ) : (
          <div className="table-scroll-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Storm Start</th>
                  <th>Rain (in)</th>
                  <th>Peak (in/hr)</th>
                  <th>Peak RDII ({displayFlowUnit})</th>
                  <th>R_emp</th>
                  <th>R_fit</th>
                  <th>R1 / T1 / K1</th>
                  <th>R2 / T2 / K2</th>
                  <th>R3 / T3 / K3</th>
                  <th>NSE</th>
                  <th>Tail &gt;0.1 MGD</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((ev) => {
                  const isSel = ev.eventId === activeEvent?.eventId;
                  return (
                    <tr
                      key={ev.eventId}
                      className={`${isSel ? 'selected-row' : ''} ${
                        ev.hasLongGroundwaterTail ? 'long-tail-row' : ''
                      }`}
                      onClick={() => onSelectEvent(ev)}
                    >
                      <td className="mono-cell">
                        <span className="ev-id-badge">E{ev.eventId}</span>
                      </td>
                      <td className="mono-cell">{ev.startIso}</td>
                      <td className="mono-cell num">{ev.totalRainIn.toFixed(2)}</td>
                      <td className="mono-cell num">{ev.peakIntensityInHr.toFixed(2)}</td>
                      <td className="mono-cell num">
                        {convertFlowFromMgd(ev.peakRdiiMgd, displayFlowUnit).toFixed(2)}
                      </td>
                      <td className="mono-cell num">{ev.rEmpirical.toFixed(3)}</td>
                      <td className="mono-cell num strong">{ev.rTotalFit.toFixed(3)}</td>
                      <td className="mono-cell">
                        {ev.R1.toFixed(3)} / {ev.T1.toFixed(1)}h / {ev.K1.toFixed(1)}
                      </td>
                      <td className="mono-cell">
                        {ev.R2.toFixed(3)} / {ev.T2.toFixed(1)}h / {ev.K2.toFixed(1)}
                      </td>
                      <td className="mono-cell">
                        {ev.R3.toFixed(3)} / {ev.T3.toFixed(0)}h / {ev.K3.toFixed(1)}
                      </td>
                      <td className="mono-cell num">{ev.nse.toFixed(2)}</td>
                      <td className="mono-cell num">
                        <span
                          className={`tail-badge ${
                            ev.hasLongGroundwaterTail ? 'tail-alert' : 'tail-normal'
                          }`}
                        >
                          {ev.tailHoursGt01Mgd.toFixed(1)} hr
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="icon-zoom-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectEvent(ev);
                          }}
                          title="Zoom chart to storm"
                        >
                          <Focus size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Right Inspector: 3-Triangle RTK Unit Hydrograph Decomposition */}
      {activeEvent && triangleKernelPlot && (
        <aside className="instrument-panel rtk-kernel-card">
          <div className="eyebrow-tag">UNIT HYDROGRAPH KERNEL</div>
          <h4 className="panel-title">
            Storm E{activeEvent.eventId} · {activeEvent.startIso.slice(0, 10)}
          </h4>
          <p className="panel-subtitle">
            Total Rain: <strong>{activeEvent.totalRainIn} in</strong> · Capture R_fit ={' '}
            <strong>{(activeEvent.rTotalFit * 100).toFixed(1)}%</strong> · Excess ={' '}
            <strong>{activeEvent.excessVolumeMg.toFixed(2)} MG</strong>
          </p>

          <svg
            viewBox={`0 0 ${triangleKernelPlot.w} ${triangleKernelPlot.h}`}
            className="kernel-svg"
            role="img"
            aria-label="Three-triangle RTK unit hydrograph decomposition"
          >
            <rect
              x={triangleKernelPlot.padL}
              y={triangleKernelPlot.padT}
              width={triangleKernelPlot.pw}
              height={triangleKernelPlot.ph}
              fill="#F7FAFC"
              stroke="#CFDCE6"
            />
            {triangleKernelPlot.pts3 && (
              <polygon
                points={triangleKernelPlot.pts3}
                fill="rgba(88, 66, 195, 0.20)"
                stroke="#5842C3"
                strokeWidth="1.6"
              />
            )}
            {triangleKernelPlot.pts2 && (
              <polygon
                points={triangleKernelPlot.pts2}
                fill="rgba(11, 122, 117, 0.22)"
                stroke="#0B7A75"
                strokeWidth="1.7"
              />
            )}
            {triangleKernelPlot.pts1 && (
              <polygon
                points={triangleKernelPlot.pts1}
                fill="rgba(201, 91, 18, 0.24)"
                stroke="#C95B12"
                strokeWidth="1.8"
              />
            )}
            <text
              x={triangleKernelPlot.padL}
              y={triangleKernelPlot.h - 6}
              fontSize="10"
              fill="#4A6275"
              fontFamily="JetBrains Mono, monospace"
            >
              0 hr
            </text>
            <text
              x={triangleKernelPlot.padL + triangleKernelPlot.pw}
              y={triangleKernelPlot.h - 6}
              textAnchor="end"
              fontSize="10"
              fill="#4A6275"
              fontFamily="JetBrains Mono, monospace"
            >
              {triangleKernelPlot.maxTimeHr.toFixed(0)} hr base
            </text>
          </svg>

          <div className="tri-breakdown-list">
            <div className="tri-row">
              <span className="swatch swatch-mod" />
              <div>
                <strong>UH1 Fast Inflow</strong>
                <div className="mono-small">
                  R1={activeEvent.R1.toFixed(4)} · T1={activeEvent.T1}h · K1={activeEvent.K1}
                </div>
              </div>
            </div>
            <div className="tri-row">
              <span className="swatch swatch-obs" />
              <div>
                <strong>UH2 Trench Interflow</strong>
                <div className="mono-small">
                  R2={activeEvent.R2.toFixed(4)} · T2={activeEvent.T2}h · K2={activeEvent.K2}
                </div>
              </div>
            </div>
            <div className="tri-row">
              <span className="swatch swatch-gwi" />
              <div>
                <strong>UH3 Slow Recession</strong>
                <div className="mono-small">
                  R3={activeEvent.R3.toFixed(4)} · T3={activeEvent.T3}h · K3={activeEvent.K3}
                </div>
              </div>
            </div>
          </div>

          {activeEvent.hasLongGroundwaterTail && (
            <div className="gim-callout-note">
              <strong>Groundwater Tail Alert ({activeEvent.tailHoursGt01Mgd} hr):</strong> Elevated
              flow persists well beyond linear UH3 base time. Use the{' '}
              <strong>InfoWorks ICM Ground Infiltration</strong> tab for physical 2-store soil &amp;
              aquifer parameters.
            </div>
          )}
        </aside>
      )}
    </div>
  );
};
