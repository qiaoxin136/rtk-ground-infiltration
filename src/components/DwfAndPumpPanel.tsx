import React from 'react';
import { Activity, Download, Focus } from 'lucide-react';
import { buildDiurnalCsv, triggerTextDownload } from '../engine/exporters';
import { convertFlowFromMgd, formatWallClockIso } from '../engine/parser';
import type { FlowUnit, FullAnalysisResult } from '../engine/types';

interface DwfAndPumpPanelProps {
  result: FullAnalysisResult;
  displayFlowUnit: FlowUnit;
  onZoomToWindow: (startMs: number, endMs: number, enableRaw5m: boolean) => void;
}

export const DwfAndPumpPanel: React.FC<DwfAndPumpPanelProps> = ({
  result,
  displayFlowUnit,
  onZoomToWindow,
}) => {
  const { dwf, pump } = result;

  // Build 24-hour diurnal multiplier SVG coordinates
  const w = 480;
  const h = 205;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const pw = w - padL - padR;
  const ph = h - padT - padB;

  const factors = dwf.diurnal.flatMap((d) => [d.weekdayFactor, d.weekendFactor]);
  const minF = Math.min(0.4, ...factors) * 0.92;
  const maxF = Math.max(1.4, ...factors) * 1.08;

  const xOfHr = (hr: number) => padL + (hr / 23) * pw;
  const yOfFac = (fac: number) => padT + ph - ((fac - minF) / (maxF - minF)) * ph;

  const wdPath = dwf.diurnal
    .map((d) => `${xOfHr(d.hour).toFixed(1)},${yOfFac(d.weekdayFactor).toFixed(1)}`)
    .join(' ');
  const wePath = dwf.diurnal
    .map((d) => `${xOfHr(d.hour).toFixed(1)},${yOfFac(d.weekendFactor).toFixed(1)}`)
    .join(' ');

  return (
    <div className="workbench-grid dwf-pump-grid">
      {/* Left: 24-Hr Diurnal Curves & Hourly Multipliers */}
      <div className="instrument-panel">
        <div className="panel-header-row">
          <div>
            <div className="eyebrow-tag">DRY-WEATHER SANITARY BASELINE</div>
            <h3 className="panel-title">
              24-Hour Weekday vs. Weekend Diurnal Pattern ({dwf.cleanDryDayCount} Clean Dry Days)
            </h3>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              triggerTextDownload('diurnal_patterns_24hr.csv', buildDiurnalCsv(result))
            }
          >
            <Download size={14} /> Export 24-Hr CSV
          </button>
        </div>

        <div className="dwf-stat-strip">
          <div>
            <span>Weekday Mean</span>
            <strong className="mono-val">
              {convertFlowFromMgd(dwf.weekdayMeanMgd, displayFlowUnit).toFixed(3)} {displayFlowUnit}
            </strong>
          </div>
          <div>
            <span>Weekend Mean</span>
            <strong className="mono-val">
              {convertFlowFromMgd(dwf.weekendMeanMgd, displayFlowUnit).toFixed(3)} {displayFlowUnit}
            </strong>
          </div>
          <div>
            <span>Weighted Average DWF</span>
            <strong className="mono-val accent-teal">
              {convertFlowFromMgd(dwf.weightedMeanMgd, displayFlowUnit).toFixed(3)} {displayFlowUnit}
            </strong>
          </div>
        </div>

        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="diurnal-svg"
          role="img"
          aria-label="24-hour weekday and weekend normalized diurnal multipliers"
        >
          <rect x={padL} y={padT} width={pw} height={ph} fill="#F7FAFC" stroke="#CFDCE6" />
          <line
            x1={padL}
            y1={yOfFac(1.0)}
            x2={padL + pw}
            y2={yOfFac(1.0)}
            stroke="#64748B"
            strokeDasharray="4 3"
          />
          <polyline fill="none" stroke="#0A66C2" strokeWidth="2.1" points={wdPath} />
          <polyline fill="none" stroke="#C95B12" strokeWidth="2.1" points={wePath} />
          {dwf.diurnal.map((d) => (
            <g key={d.hour}>
              <circle cx={xOfHr(d.hour)} cy={yOfFac(d.weekdayFactor)} r="2.6" fill="#0A66C2" />
              <circle cx={xOfHr(d.hour)} cy={yOfFac(d.weekendFactor)} r="2.6" fill="#C95B12" />
              {d.hour % 3 === 0 && (
                <text
                  x={xOfHr(d.hour)}
                  y={h - 8}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#4A6275"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {String(d.hour).padStart(2, '0')}:00
                </text>
              )}
            </g>
          ))}
          <text
            x={padL - 6}
            y={yOfFac(1.0) + 3}
            textAnchor="end"
            fontSize="10"
            fill="#4A6275"
            fontFamily="JetBrains Mono, monospace"
          >
            1.00×
          </text>
          <text
            x={padL - 6}
            y={padT + 8}
            textAnchor="end"
            fontSize="10"
            fill="#4A6275"
            fontFamily="JetBrains Mono, monospace"
          >
            {maxF.toFixed(2)}×
          </text>
          <text
            x={padL - 6}
            y={padT + ph}
            textAnchor="end"
            fontSize="10"
            fill="#4A6275"
            fontFamily="JetBrains Mono, monospace"
          >
            {minF.toFixed(2)}×
          </text>
        </svg>

        <div className="storage-legend-row">
          <span>
            <i className="swatch swatch-rain" /> Weekday Diurnal Factor
          </span>
          <span>
            <i className="swatch swatch-mod" /> Weekend Diurnal Factor
          </span>
        </div>
      </div>

      {/* Right: Upstream Pump-Cycle Diagnostics & Interactive Sample Zoom */}
      <div className="instrument-panel">
        <div className="eyebrow-tag">SIGNAL CONDITIONING &amp; PUMP DETECTION</div>
        <h3 className="panel-title">Upstream Lift-Station Pump Influence &amp; Running Average</h3>
        <p className="panel-subtitle">
          Zero-phase 2-pass centered running average eliminates lift-station sawtooth waves while
          preserving daily volume and storm hydrograph peak timing.
        </p>

        <div className="pump-kv-grid">
          <div className="pump-kv-item">
            <span>Pump Cycling Detected</span>
            <strong className={pump.hasPumpInfluence ? 'status-yes' : 'status-no'}>
              {pump.hasPumpInfluence ? 'YES — Active Lift Station' : 'Minimal / Gravity Flow'}
            </strong>
          </div>
          <div className="pump-kv-item">
            <span>Median Cycle Period</span>
            <strong className="mono-val">
              {pump.medianCycleMin !== null ? `${pump.medianCycleMin.toFixed(1)} min` : 'N/A'}
            </strong>
          </div>
          <div className="pump-kv-item">
            <span>Filter Kernel Applied</span>
            <strong className="mono-val">
              {pump.smoothingApplied
                ? `2-Pass ${pump.windowActualMin.toFixed(0)}-min (${pump.windowPoints}-pt)`
                : 'Bypassed (Raw)'}
            </strong>
          </div>
          <div className="pump-kv-item">
            <span>Step Roughness Reduction</span>
            <strong className="mono-val accent-teal">
              {pump.roughnessReductionPct.toFixed(1)}% ({pump.rawDiffStdMgd.toFixed(3)} →{' '}
              {pump.smoothDiffStdMgd.toFixed(3)} MGD)
            </strong>
          </div>
        </div>

        <div className="sample-zoom-box">
          <div className="sample-zoom-title">
            <Activity size={15} /> Inspect Raw Sawtooth vs. Smoothed Curve on Main Canvas
          </div>
          <p>
            Jump directly to a 24-hour dry-weather day or peak storm window with the{' '}
            <strong>Raw ({pump.dtMin}m)</strong> trace enabled:
          </p>
          <div className="sample-zoom-btns">
            <button
              type="button"
              className="btn-primary-outline"
              onClick={() =>
                onZoomToWindow(
                  dwf.sampleDryDayStartMs,
                  dwf.sampleDryDayStartMs + 24 * 3600_000,
                  true
                )
              }
            >
              <Focus size={14} /> Zoom Dry-Day Pump Sample (
              {formatWallClockIso(dwf.sampleDryDayStartMs, false)})
            </button>
            <button
              type="button"
              className="btn-primary-outline"
              onClick={() =>
                onZoomToWindow(
                  dwf.sampleStormStartMs,
                  dwf.sampleStormStartMs + 60 * 3600_000,
                  true
                )
              }
            >
              <Focus size={14} /> Zoom Peak Storm Sample (
              {formatWallClockIso(dwf.sampleStormStartMs, false)})
            </button>
          </div>
        </div>

        <div className="table-scroll-wrap compact-diurnal-table">
          <table className="data-table">
            <thead>
              <tr>
                <th>Hour</th>
                <th>Weekday ({displayFlowUnit})</th>
                <th>WD Factor</th>
                <th>Weekend ({displayFlowUnit})</th>
                <th>WE Factor</th>
              </tr>
            </thead>
            <tbody>
              {dwf.diurnal.map((r) => (
                <tr key={r.hour}>
                  <td className="mono-cell">{String(r.hour).padStart(2, '0')}:00</td>
                  <td className="mono-cell num">
                    {convertFlowFromMgd(r.weekdayFlowMgd, displayFlowUnit).toFixed(3)}
                  </td>
                  <td className="mono-cell num">{r.weekdayFactor.toFixed(3)}</td>
                  <td className="mono-cell num">
                    {convertFlowFromMgd(r.weekendFlowMgd, displayFlowUnit).toFixed(3)}
                  </td>
                  <td className="mono-cell num">{r.weekendFactor.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
