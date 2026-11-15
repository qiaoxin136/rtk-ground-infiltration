import React, { useMemo, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import {
  buildAlignedSeriesCsv,
  buildIcmParametersCsv,
  triggerTextDownload,
} from '../engine/exporters';
import type { FullAnalysisResult } from '../engine/types';

interface IcmGimPanelProps {
  result: FullAnalysisResult;
}

export const IcmGimPanel: React.FC<IcmGimPanelProps> = ({ result }) => {
  const [copied, setCopied] = useState(false);
  const { gim, series15m } = result;

  const copyIcmTable = async () => {
    const csv = buildIcmParametersCsv(result);
    await navigator.clipboard.writeText(csv);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Build compact SVG path of continuous Soil Storage S(t) and Groundwater Storage G(t)
  const storageSpark = useMemo(() => {
    if (!gim.enabled || series15m.soilStorageIn.length === 0) return null;
    const w = 520;
    const h = 165;
    const padL = 42;
    const padR = 16;
    const padT = 14;
    const padB = 24;
    const pw = w - padL - padR;
    const ph = h - padT - padB;

    const n = series15m.soilStorageIn.length;
    const stride = Math.max(1, Math.floor(n / 260));
    let maxIn = Math.max(gim.sMaxIn, gim.gThreshIn * 1.35, 1.0);
    for (let i = 0; i < n; i += stride) {
      if (series15m.soilStorageIn[i] > maxIn) maxIn = series15m.soilStorageIn[i];
      if (series15m.gwStorageIn[i] > maxIn) maxIn = series15m.gwStorageIn[i];
    }
    maxIn *= 1.08;

    const xOf = (idx: number) => padL + (idx / Math.max(1, n - 1)) * pw;
    const yOf = (val: number) => padT + ph - (val / maxIn) * ph;

    const sPts: string[] = [];
    const gPts: string[] = [];
    for (let i = 0; i < n; i += stride) {
      sPts.push(`${xOf(i).toFixed(1)},${yOf(series15m.soilStorageIn[i]).toFixed(1)}`);
      gPts.push(`${xOf(i).toFixed(1)},${yOf(series15m.gwStorageIn[i]).toFixed(1)}`);
    }

    return {
      w,
      h,
      padL,
      padT,
      pw,
      ph,
      maxIn,
      soilPath: sPts.join(' '),
      gwPath: gPts.join(' '),
      ySThresh: yOf(gim.sThreshIn),
      yGThresh: yOf(gim.gThreshIn),
    };
  }, [gim, series15m]);

  if (!gim.enabled) {
    return (
      <div className="instrument-panel">
        <h3 className="panel-title">InfoWorks ICM Ground Infiltration Module (hw_ground_infiltration)</h3>
        <p className="panel-subtitle">{gim.reason}</p>
        <div className="empty-callout">
          Switch <strong>InfoWorks ICM GIM Mode</strong> in the left configuration panel to{' '}
          <strong>Always Calibrate</strong> if you want to fit 2-store soil &amp; groundwater
          parameters regardless of storm tail length.
        </div>
      </div>
    );
  }

  const soilFillPct = Math.min(100, Math.max(12, (gim.sThreshIn / gim.sMaxIn) * 100));

  return (
    <div className="icm-gim-stack">
      {/* Top Row: Two-Store Cross-Section Diagram + Subsurface Storage Trajectory */}
      <div className="workbench-grid icm-visual-grid">
        <div className="instrument-panel">
          <div className="eyebrow-tag">INFOWORKS ICM 2-STORE ARCHITECTURE</div>
          <h3 className="panel-title">Coupled RTK + Soil &amp; Groundwater Store Schematic</h3>
          <p className="panel-subtitle">
            {gim.reason} Superposition:{' '}
            <strong>Total Flow = Baseline ({result.baselineFlowMgd.toFixed(2)} MGD) + Diurnal + RTK + GWI</strong>.
          </p>

          <svg
            viewBox="0 0 540 250"
            className="icm-schematic-svg"
            role="img"
            aria-label="InfoWorks ICM two-store soil and groundwater cross-section schematic"
          >
            {/* Surface Rainfall Split */}
            <rect x="16" y="14" width="235" height="40" rx="6" fill="#E6F2FF" stroke="#0A66C2" />
            <text x="28" y="31" fontSize="11" fontWeight="700" fill="#0D2130">
              Pervious Runoff Surface
            </text>
            <text x="28" y="46" fontSize="10.5" fill="#0A66C2" fontFamily="JetBrains Mono, monospace">
              f_infil = {(gim.fInfil * 100).toFixed(1)}% ({(gim.fInfil * result.areaAcres).toFixed(1)} ac)
            </text>

            <rect x="285" y="14" width="238" height="40" rx="6" fill="#FFF4EC" stroke="#C95B12" />
            <text x="297" y="31" fontSize="11" fontWeight="700" fill="#0D2130">
              Fast + Medium RTK Hydrograph
            </text>
            <text x="297" y="46" fontSize="10" fill="#C95B12" fontFamily="JetBrains Mono, monospace">
              R1={gim.R1.toFixed(3)} ({gim.T1}h) · R2={gim.R2.toFixed(3)} ({gim.T2}h) · R3=0
            </text>

            {/* Soil Store Tank */}
            <rect x="16" y="76" width="235" height="72" rx="6" fill="#F4FBF9" stroke="#0B7A75" strokeWidth="1.4" />
            <rect
              x="17"
              y={76 + 72 * (1 - soilFillPct / 100)}
              width="233"
              height={(72 * soilFillPct) / 100 - 1}
              rx="4"
              fill="rgba(11, 122, 117, 0.16)"
            />
            <line
              x1="16"
              y1={76 + 72 * (1 - soilFillPct / 100)}
              x2="251"
              y2={76 + 72 * (1 - soilFillPct / 100)}
              stroke="#0B7A75"
              strokeDasharray="4 3"
            />
            <text x="28" y="94" fontSize="11" fontWeight="700" fill="#0D2130">
              1. Unsaturated Soil Store (S)
            </text>
            <text x="28" y="111" fontSize="10" fill="#1F3A4D" fontFamily="JetBrains Mono, monospace">
              S_max={gim.sMaxIn.toFixed(2)}&quot; · S_thresh={gim.sThreshIn.toFixed(2)}&quot;
            </text>
            <text x="28" y="126" fontSize="10" fill="#1F3A4D" fontFamily="JetBrains Mono, monospace">
              k_perc={gim.kPercDay.toFixed(3)}/d · p={gim.pPerc.toFixed(2)} · ET={gim.etInDay.toFixed(3)}&quot;/d
            </text>

            {/* Arrow Surface -> Soil */}
            <line x1="133" y1="54" x2="133" y2="74" stroke="#0A66C2" strokeWidth="2" />
            {/* Arrow Soil -> GW */}
            <line x1="133" y1="148" x2="133" y2="168" stroke="#0B7A75" strokeWidth="2" />
            <text x="142" y="162" fontSize="9.5" fill="#0B7A75" fontWeight="600">
              Percolation (S &gt; S_thresh)
            </text>

            {/* Groundwater Store Tank */}
            <rect x="16" y="170" width="235" height="68" rx="6" fill="#F5F3FF" stroke="#5842C3" strokeWidth="1.5" />
            <rect x="17" y="198" width="233" height="39" rx="4" fill="rgba(88, 66, 195, 0.18)" />
            <line x1="16" y1="198" x2="251" y2="198" stroke="#5842C3" strokeDasharray="4 3" />
            <text x="28" y="188" fontSize="11" fontWeight="700" fill="#0D2130">
              2. Aquifer Groundwater Store (G)
            </text>
            <text x="28" y="206" fontSize="10" fill="#32237A" fontFamily="JetBrains Mono, monospace">
              G_thresh={gim.gThreshFt.toFixed(2)} ft ({gim.gThreshIn.toFixed(2)}&quot; eq)
            </text>
            <text x="28" y="222" fontSize="10" fill="#32237A" fontFamily="JetBrains Mono, monospace">
              k_gwi={gim.kGwiDay.toFixed(3)}/d · p={gim.pGwi.toFixed(2)} · k_bf={gim.kBfDay.toFixed(3)}/d
            </text>

            {/* Sewer Interceptor Conduit */}
            <rect x="305" y="150" width="218" height="88" rx="8" fill="#F8FAFC" stroke="#334E68" strokeWidth="1.4" />
            <circle cx="344" cy="194" r="22" fill="#E2EBF2" stroke="#0D2130" strokeWidth="2.2" />
            <path d="M324 201 Q344 191 364 201 A22 22 0 0 1 324 201 Z" fill="#0B7A75" />
            <text x="378" y="176" fontSize="11" fontWeight="700" fill="#0D2130">
              Collection Sewer
            </text>
            <text x="378" y="193" fontSize="10" fill="#4A6275" fontFamily="JetBrains Mono, monospace">
              Daily NSE: {gim.metrics.nseDaily.toFixed(3)}
            </text>
            <text x="378" y="209" fontSize="10" fill="#4A6275" fontFamily="JetBrains Mono, monospace">
              15m NSE:   {gim.metrics.nse15m.toFixed(3)}
            </text>
            <text x="378" y="225" fontSize="10" fill="#4A6275" fontFamily="JetBrains Mono, monospace">
              Vol Err:   {gim.metrics.volumeErrorPct >= 0 ? '+' : ''}
              {gim.metrics.volumeErrorPct.toFixed(2)}%
            </text>

            {/* Arrow RTK -> Sewer & GW -> Sewer */}
            <path d="M404 54 L404 148" stroke="#C95B12" strokeWidth="2" />
            <path d="M251 202 L303 202" stroke="#5842C3" strokeWidth="2.4" />
            <text x="255" y="195" fontSize="9.5" fill="#5842C3" fontWeight="700">
              Q_GWI
            </text>
          </svg>
        </div>

        {/* Right Card: Continuous Subsurface State Trajectory */}
        <div className="instrument-panel">
          <div className="eyebrow-tag">STATE TRAJECTORY (WATER EQUIVALENT INCHES)</div>
          <h3 className="panel-title">Simulated Soil Moisture S(t) &amp; Groundwater Storage G(t)</h3>
          <p className="panel-subtitle">
            Groundwater infiltration activates only when perched storage G(t) rises above the pipe
            invert threshold ({gim.gThreshIn.toFixed(2)} in water eq. = {gim.gThreshFt.toFixed(2)} ft
            head).
          </p>

          {storageSpark && (
            <svg
              viewBox={`0 0 ${storageSpark.w} ${storageSpark.h}`}
              className="storage-spark-svg"
              role="img"
              aria-label="Soil and groundwater storage state variables over time"
            >
              <rect
                x={storageSpark.padL}
                y={storageSpark.padT}
                width={storageSpark.pw}
                height={storageSpark.ph}
                fill="#F7FAFC"
                stroke="#CFDCE6"
              />
              {/* Threshold lines */}
              <line
                x1={storageSpark.padL}
                y1={storageSpark.ySThresh}
                x2={storageSpark.padL + storageSpark.pw}
                y2={storageSpark.ySThresh}
                stroke="#0B7A75"
                strokeDasharray="3 3"
                strokeWidth="1.1"
              />
              <line
                x1={storageSpark.padL}
                y1={storageSpark.yGThresh}
                x2={storageSpark.padL + storageSpark.pw}
                y2={storageSpark.yGThresh}
                stroke="#5842C3"
                strokeDasharray="4 3"
                strokeWidth="1.2"
              />
              <polyline
                fill="none"
                stroke="#0B7A75"
                strokeWidth="1.8"
                points={storageSpark.soilPath}
              />
              <polyline
                fill="none"
                stroke="#5842C3"
                strokeWidth="2.0"
                points={storageSpark.gwPath}
              />
              <text
                x={storageSpark.padL - 6}
                y={storageSpark.padT + 8}
                textAnchor="end"
                fontSize="10"
                fill="#4A6275"
                fontFamily="JetBrains Mono, monospace"
              >
                {storageSpark.maxIn.toFixed(1)}&quot;
              </text>
              <text
                x={storageSpark.padL - 6}
                y={storageSpark.padT + storageSpark.ph}
                textAnchor="end"
                fontSize="10"
                fill="#4A6275"
                fontFamily="JetBrains Mono, monospace"
              >
                0.0&quot;
              </text>
              <text
                x={storageSpark.padL}
                y={storageSpark.h - 6}
                fontSize="10"
                fill="#4A6275"
                fontFamily="JetBrains Mono, monospace"
              >
                {result.periodStartIso.slice(0, 10)}
              </text>
              <text
                x={storageSpark.padL + storageSpark.pw}
                y={storageSpark.h - 6}
                textAnchor="end"
                fontSize="10"
                fill="#4A6275"
                fontFamily="JetBrains Mono, monospace"
              >
                {result.periodEndIso.slice(0, 10)}
              </text>
            </svg>
          )}

          <div className="storage-legend-row">
            <span>
              <i className="swatch swatch-obs" /> Soil Store S(t) (dashed = S_thresh{' '}
              {gim.sThreshIn.toFixed(2)}&quot;)
            </span>
            <span>
              <i className="swatch swatch-gwi" /> GW Store G(t) (dashed = G_thresh{' '}
              {gim.gThreshIn.toFixed(2)}&quot;)
            </span>
          </div>
        </div>
      </div>

      {/* Bottom Full-Width InfoWorks ICM Parameter Schedule */}
      <div className="instrument-panel">
        <div className="panel-header-row">
          <div>
            <h3 className="panel-title">
              Calibrated InfoWorks ICM Parameter Schedule (Subcatchment + RTK + Ground Infiltration)
            </h3>
            <p className="panel-subtitle">
              Ready for entry into InfoWorks ICM <code>hw_subcatchment</code>,{' '}
              <code>hw_runoff_surface</code>, and <code>hw_ground_infiltration</code> tables.
            </p>
          </div>
          <div className="panel-actions">
            <button type="button" className="btn-secondary" onClick={copyIcmTable}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied CSV' : 'Copy Table'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                triggerTextDownload('icm_parameters_summary.csv', buildIcmParametersCsv(result))
              }
            >
              <Download size={14} /> Export ICM Params CSV
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                triggerTextDownload('aligned_hydrographs_15m.csv', buildAlignedSeriesCsv(result))
              }
            >
              <Download size={14} /> Export 15-Min Series CSV
            </button>
          </div>
        </div>

        <div className="table-scroll-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>InfoWorks ICM Object</th>
                <th>Parameter</th>
                <th>Calibrated Value</th>
                <th>Units</th>
                <th>Engineering Notes &amp; Physical Interpretation</th>
              </tr>
            </thead>
            <tbody>
              {gim.icmRows.map((row, idx) => (
                <tr key={`${row.icmObject}-${row.parameter}-${idx}`}>
                  <td>
                    <span className="icm-obj-pill">{row.icmObject}</span>
                  </td>
                  <td className="strong-cell">{row.parameter}</td>
                  <td className="mono-cell strong">{row.value}</td>
                  <td className="mono-cell">{row.units}</td>
                  <td className="notes-cell">{row.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
