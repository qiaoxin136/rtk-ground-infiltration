import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cloud,
  CloudRain,
  Cpu,
  Database,
  Download,
  FileUp,
  Layers,
  Play,
  RefreshCw,
  Sliders,
  Waves,
} from 'lucide-react';
import CalibrationWorker from './worker/calibrationWorker?worker';
import type {
  WorkerResponseMessage,
  WorkerRunMessage,
} from './worker/calibrationWorker';
import { SplitHorizonCanvas } from './components/SplitHorizonCanvas';
import { StormEventsPanel } from './components/StormEventsPanel';
import { IcmGimPanel } from './components/IcmGimPanel';
import { DwfAndPumpPanel } from './components/DwfAndPumpPanel';
import { CloudSyncModal } from './components/CloudSyncModal';
import {
  buildEventRtkCsv,
  buildIcmParametersCsv,
  triggerTextDownload,
} from './engine/exporters';
import { convertFlowFromMgd } from './engine/parser';
import { invokeLambdaFullCalibration, isAmplifyConfigured } from './lib/amplifyCloud';
import type {
  AnalysisConfig,
  AreaUnit,
  FlowUnit,
  FullAnalysisResult,
  RainUnit,
  StormEventRtk,
} from './engine/types';

type ActiveTab = 'events' | 'icm' | 'dwf';
type ComputeEnginePreference = 'lambda' | 'worker';
type ExecutionSource = 'aws-lambda' | 'local-fallback' | 'browser-worker';

const DEFAULT_CONFIG: AnalysisConfig = {
  projectName: 'TFM02 Sewer Basin (268 ac)',
  flowUnit: 'MGD',
  rainUnit: 'in/hr',
  areaValue: 268,
  areaUnit: 'acres',
  smoothWindowMinOverride: null,
  enablePumpSmoothing: true,
  interEventGapHours: 24,
  minEventDepthIn: 0.1,
  longTailThresholdHours: 48,
  enableCoupledGim: 'auto',
  optimizerIterations: 36,
};

export const App: React.FC = () => {
  const [config, setConfig] = useState<AnalysisConfig>(DEFAULT_CONFIG);
  const [displayFlowUnit, setDisplayFlowUnit] = useState<FlowUnit>('MGD');
  const [displayRainUnit, setDisplayRainUnit] = useState<RainUnit>('in/hr');

  const [flowFileName, setFlowFileName] = useState<string>('TFM02.txt');
  const [rainFileName, setRainFileName] = useState<string>('Rainfall.txt');
  const [flowRawText, setFlowRawText] = useState<string>('');
  const [rainRawText, setRainRawText] = useState<string>('');

  const [result, setResult] = useState<FullAnalysisResult | null>(null);
  const [zoomDomain, setZoomDomain] = useState<[number, number]>([0, 1]);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [showRaw5m, setShowRaw5m] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('events');

  const [isCalibrating, setIsCalibrating] = useState<boolean>(false);
  const [progressPct, setProgressPct] = useState<number>(0);
  const [progressStage, setProgressStage] = useState<string>('');
  const [computeDurationMs, setComputeDurationMs] = useState<number | null>(null);
  const [computeEngine, setComputeEngine] = useState<ComputeEnginePreference>('lambda');
  const [executionSource, setExecutionSource] = useState<ExecutionSource>(
    isAmplifyConfigured ? 'aws-lambda' : 'local-fallback'
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cloudModalOpen, setCloudModalOpen] = useState<boolean>(false);

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef<number>(0);
  const workerSourceRef = useRef<ExecutionSource>('browser-worker');

  const applyCalibrationOutput = useCallback(
    (res: FullAnalysisResult, durationMs: number, source: ExecutionSource) => {
      setIsCalibrating(false);
      setProgressPct(100);
      setComputeDurationMs(durationMs);
      setExecutionSource(source);
      setResult(res);
      const ts = res.series15m.timestampsMs;
      setZoomDomain([ts[0], ts[ts.length - 1]]);
      // Preselect storm with longest continuous groundwater tail (or largest rainfall)
      const sortedByTail = [...res.events].sort(
        (a, b) => b.tailHoursGt01Mgd - a.tailHoursGt01Mgd || b.totalRainIn - a.totalRainIn
      );
      setSelectedEventId(sortedByTail[0]?.eventId ?? null);
    },
    []
  );

  // Initialize Web Worker (used only when offline/local dev or explicitly selected)
  useEffect(() => {
    const worker = new CalibrationWorker();
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<WorkerResponseMessage>) => {
      const msg = ev.data;
      if (msg.requestId !== reqIdRef.current) return;

      if (msg.type === 'PROGRESS') {
        setProgressPct(msg.pct);
        setProgressStage(msg.stage);
      } else if (msg.type === 'RESULT') {
        applyCalibrationOutput(msg.result, msg.durationMs, workerSourceRef.current);
      } else if (msg.type === 'ERROR') {
        setIsCalibrating(false);
        setErrorMsg(msg.message);
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [applyCalibrationOutput]);

  const executeCalibration = useCallback(
    async (
      fText: string,
      rText: string,
      cfg: AnalysisConfig,
      enginePref: ComputeEnginePreference = computeEngine
    ) => {
      if (!fText.trim() || !rText.trim()) {
        setErrorMsg('Upload both a Rainfall file and a Sewer Flow file before running calibration.');
        return;
      }
      setErrorMsg(null);
      setIsCalibrating(true);
      reqIdRef.current += 1;
      const myReqId = reqIdRef.current;

      // Default path: execute all hydrological & InfoWorks ICM GIM calculations in AWS Lambda
      if (enginePref === 'lambda' && isAmplifyConfigured) {
        try {
          setProgressPct(8);
          setProgressStage('Dispatching calibration job to AWS Lambda (rtk-gim-calibrator)...');
          const cloudRes = await invokeLambdaFullCalibration(fText, rText, cfg, (pct, stage) => {
            if (reqIdRef.current === myReqId) {
              setProgressPct(pct);
              setProgressStage(stage);
            }
          });
          if (reqIdRef.current !== myReqId) return;
          applyCalibrationOutput(cloudRes.result, cloudRes.computeMs, 'aws-lambda');
          return;
        } catch (err) {
          if (reqIdRef.current !== myReqId) return;
          setIsCalibrating(false);
          setErrorMsg(
            `AWS Lambda calibration error: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
      }

      // Local fallback only when running local Vite preview without amplify_outputs.json, or when user selects Browser Worker
      workerSourceRef.current = enginePref === 'lambda' ? 'local-fallback' : 'browser-worker';
      setProgressPct(2);
      setProgressStage(
        enginePref === 'lambda'
          ? 'Local dev preview (no amplify_outputs.json) — running fallback worker...'
          : 'Running in local browser Web Worker...'
      );

      const payload: WorkerRunMessage = {
        type: 'RUN_CALIBRATION',
        requestId: myReqId,
        flowText: fText,
        rainText: rText,
        config: cfg,
      };
      workerRef.current?.postMessage(payload);
    },
    [computeEngine, applyCalibrationOutput]
  );

  const loadBuiltInSample = useCallback(async () => {
    try {
      setErrorMsg(null);
      setIsCalibrating(true);
      setProgressStage('Loading built-in TFM02 & Rainfall telemetry...');
      const [fRes, rRes] = await Promise.all([
        fetch('/sample-data/TFM02.txt'),
        fetch('/sample-data/Rainfall.txt'),
      ]);
      if (!fRes.ok || !rRes.ok) {
        throw new Error('Sample telemetry files could not be fetched.');
      }
      const [fTxt, rTxt] = await Promise.all([fRes.text(), rRes.text()]);
      setFlowFileName('TFM02.txt');
      setRainFileName('Rainfall.txt');
      setFlowRawText(fTxt);
      setRainRawText(rTxt);
      setConfig(DEFAULT_CONFIG);
      setDisplayFlowUnit('MGD');
      setDisplayRainUnit('in/hr');
      void executeCalibration(fTxt, rTxt, DEFAULT_CONFIG, 'lambda');
    } catch (err) {
      setIsCalibrating(false);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [executeCalibration]);

  // Auto-load TFM02 sample basin on initial mount
  useEffect(() => {
    loadBuiltInSample();
  }, [loadBuiltInSample]);

  const handleFileUpload = async (
    file: File | undefined,
    kind: 'flow' | 'rain'
  ) => {
    if (!file) return;
    const text = await file.text();
    if (kind === 'flow') {
      setFlowFileName(file.name);
      setFlowRawText(text);
    } else {
      setRainFileName(file.name);
      setRainRawText(text);
    }
  };

  const handleSelectStormEvent = (ev: StormEventRtk) => {
    setSelectedEventId(ev.eventId);
    if (!result) return;
    const padBefore = 18 * 3600_000;
    const tailPad = ev.hasLongGroundwaterTail ? 8 * 86_400_000 : 3.5 * 86_400_000;
    const ts = result.series15m.timestampsMs;
    const d0 = Math.max(ts[0], ev.startMs - padBefore);
    const d1 = Math.min(ts[ts.length - 1], ev.endMs + tailPad);
    setZoomDomain([d0, d1]);
  };

  const handleZoomToWindow = (startMs: number, endMs: number, enableRaw: boolean) => {
    if (!result) return;
    const ts = result.series15m.timestampsMs;
    setZoomDomain([Math.max(ts[0], startMs), Math.min(ts[ts.length - 1], endMs)]);
    if (enableRaw) setShowRaw5m(true);
  };

  return (
    <div className="app-shell">
      {/* Top Engineering Instrument Bar */}
      <header className="top-header">
        <div className="brand-block">
          <div className="brand-glyph" aria-hidden="true">
            <Waves size={20} />
          </div>
          <div>
            <div className="brand-kicker">COLLECTION SYSTEM HYDROLOGY WORKBENCH</div>
            <h1 className="brand-title">
              RTK &amp; InfoWorks ICM Ground Infiltration Studio
            </h1>
          </div>
        </div>

        <div className="header-actions">
          <div className="display-unit-pill" title="Switch plotted display units instantly">
            <span>Plot Units:</span>
            <select
              value={displayFlowUnit}
              onChange={(e) => setDisplayFlowUnit(e.target.value as FlowUnit)}
              aria-label="Display flow unit"
            >
              <option value="MGD">MGD</option>
              <option value="cfs">cfs</option>
              <option value="gpm">gpm</option>
              <option value="L/s">L/s</option>
              <option value="m3/s">m³/s</option>
            </select>
            <span>/</span>
            <select
              value={displayRainUnit}
              onChange={(e) => setDisplayRainUnit(e.target.value as RainUnit)}
              aria-label="Display rainfall unit"
            >
              <option value="in/hr">in/hr</option>
              <option value="in">in/step</option>
              <option value="mm/hr">mm/hr</option>
              <option value="mm">mm/step</option>
            </select>
          </div>

          <div
            className={`engine-status-pill ${
              executionSource === 'aws-lambda' ? 'is-lambda' : ''
            }`}
            title="Default execution backend for all hydrological & InfoWorks ICM calibrations"
          >
            <Cpu size={13} />
            <span>
              {executionSource === 'aws-lambda'
                ? 'AWS Lambda Active'
                : computeEngine === 'lambda'
                  ? 'AWS Lambda Default'
                  : 'Browser Worker'}
            </span>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={loadBuiltInSample}
            disabled={isCalibrating}
          >
            <RefreshCw size={14} /> Load Sample (TFM02)
          </button>

          <button
            type="button"
            className="btn-cloud"
            onClick={() => setCloudModalOpen(true)}
          >
            <Cloud size={14} />
            {isAmplifyConfigured ? 'Amplify Cloud Connected' : 'AWS Amplify Sync'}
          </button>
        </div>
      </header>

      <div className="workspace-columns">
        {/* Left Rail: Telemetry Upload, Units, Basin Area & Calibration Controls */}
        <aside className="config-rail">
          <div className="instrument-panel rail-card">
            <div className="eyebrow-tag">1 · TELEMETRY &amp; UNITS</div>
            <label className="field-label">
              Basin / Meter Name
              <input
                type="text"
                className="text-input"
                value={config.projectName}
                onChange={(e) => setConfig({ ...config, projectName: e.target.value })}
              />
            </label>

            {/* Rainfall Upload + Input Unit */}
            <div className="upload-box">
              <div className="upload-box-top">
                <span className="upload-title">
                  <CloudRain size={14} /> Rainfall Hyetograph
                </span>
                <label className="file-btn">
                  <FileUp size={12} /> Upload
                  <input
                    type="file"
                    accept=".txt,.csv,.tsv,.dat"
                    onChange={(e) => handleFileUpload(e.target.files?.[0], 'rain')}
                  />
                </label>
              </div>
              <div className="file-name-chip" title={rainFileName}>
                {rainFileName} ({rainRawText ? `${(rainRawText.length / 1024).toFixed(0)} KB` : '...'})
              </div>
              <div className="inline-unit-row">
                <span>File Rain Unit</span>
                <select
                  value={config.rainUnit}
                  onChange={(e) => {
                    const nextU = e.target.value as RainUnit;
                    setConfig({ ...config, rainUnit: nextU });
                    setDisplayRainUnit(nextU);
                  }}
                >
                  <option value="in/hr">in/hr (Intensity)</option>
                  <option value="in">in (Depth per step)</option>
                  <option value="mm/hr">mm/hr (Intensity)</option>
                  <option value="mm">mm (Depth per step)</option>
                </select>
              </div>
            </div>

            {/* Flow Upload + Input Unit */}
            <div className="upload-box">
              <div className="upload-box-top">
                <span className="upload-title">
                  <Waves size={14} /> Sewer Flow Data
                </span>
                <label className="file-btn">
                  <FileUp size={12} /> Upload
                  <input
                    type="file"
                    accept=".txt,.csv,.tsv,.dat"
                    onChange={(e) => handleFileUpload(e.target.files?.[0], 'flow')}
                  />
                </label>
              </div>
              <div className="file-name-chip" title={flowFileName}>
                {flowFileName} ({flowRawText ? `${(flowRawText.length / 1024).toFixed(0)} KB` : '...'})
              </div>
              <div className="inline-unit-row">
                <span>File Flow Unit</span>
                <select
                  value={config.flowUnit}
                  onChange={(e) => {
                    const nextU = e.target.value as FlowUnit;
                    setConfig({ ...config, flowUnit: nextU });
                    setDisplayFlowUnit(nextU);
                  }}
                >
                  <option value="MGD">MGD</option>
                  <option value="cfs">cfs</option>
                  <option value="gpm">gpm</option>
                  <option value="L/s">L/s</option>
                  <option value="m3/s">m³/s</option>
                </select>
              </div>
            </div>

            {/* Contributing Service Area */}
            <div className="eyebrow-tag section-sep">2 · BASIN &amp; MODEL SETTINGS</div>
            <div className="split-field-row">
              <label className="field-label">
                Service Area
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  className="text-input mono-input"
                  value={config.areaValue}
                  onChange={(e) =>
                    setConfig({ ...config, areaValue: Math.max(0.1, Number(e.target.value)) })
                  }
                />
              </label>
              <label className="field-label">
                Area Unit
                <select
                  className="text-input"
                  value={config.areaUnit}
                  onChange={(e) => setConfig({ ...config, areaUnit: e.target.value as AreaUnit })}
                >
                  <option value="acres">acres</option>
                  <option value="hectares">hectares</option>
                  <option value="sq_mi">sq miles</option>
                  <option value="km2">km²</option>
                </select>
              </label>
            </div>

            <div className="split-field-row">
              <label className="field-label">
                Min Storm (in)
                <input
                  type="number"
                  min={0.02}
                  step={0.05}
                  className="text-input mono-input"
                  value={config.minEventDepthIn}
                  onChange={(e) =>
                    setConfig({ ...config, minEventDepthIn: Math.max(0.01, Number(e.target.value)) })
                  }
                />
              </label>
              <label className="field-label">
                Inter-Event Gap (hr)
                <input
                  type="number"
                  min={2}
                  max={72}
                  step={1}
                  className="text-input mono-input"
                  value={config.interEventGapHours}
                  onChange={(e) =>
                    setConfig({ ...config, interEventGapHours: Math.max(2, Number(e.target.value)) })
                  }
                />
              </label>
            </div>

            <div className="split-field-row">
              <label className="field-label">
                Pump Smooth (min)
                <input
                  type="number"
                  min={5}
                  max={180}
                  placeholder="Auto"
                  className="text-input mono-input"
                  value={config.smoothWindowMinOverride ?? ''}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      smoothWindowMinOverride: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </label>
              <label className="field-label">
                ICM GIM Mode
                <select
                  className="text-input"
                  value={config.enableCoupledGim}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      enableCoupledGim: e.target.value as AnalysisConfig['enableCoupledGim'],
                    })
                  }
                >
                  <option value="auto">Auto (Long Tail)</option>
                  <option value="always">Always Calibrate</option>
                  <option value="off">RTK Only</option>
                </select>
              </label>
            </div>

            <label className="field-label">
              Compute Engine
              <select
                className="text-input"
                value={computeEngine}
                onChange={(e) => setComputeEngine(e.target.value as ComputeEnginePreference)}
              >
                <option value="lambda">AWS Lambda (Cloud Default)</option>
                <option value="worker">Browser Worker (Local Offline)</option>
              </select>
            </label>

            <label className="filter-check pump-toggle">
              <input
                type="checkbox"
                checked={config.enablePumpSmoothing}
                onChange={(e) => setConfig({ ...config, enablePumpSmoothing: e.target.checked })}
              />
              Apply 2-pass zero-phase pump running average
            </label>

            <button
              type="button"
              className="btn-primary run-btn"
              disabled={isCalibrating}
              onClick={() => void executeCalibration(flowRawText, rainRawText, config)}
            >
              <Play size={15} />
              {isCalibrating
                ? computeEngine === 'lambda' && isAmplifyConfigured
                  ? 'Running on AWS Lambda...'
                  : 'Calibrating Model...'
                : computeEngine === 'lambda'
                  ? 'Calculate on AWS Lambda'
                  : 'Calculate RTK + ICM GIM'}
            </button>

            {isCalibrating && (
              <div className="progress-box" role="status">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="progress-caption">{progressStage}</div>
              </div>
            )}

            {errorMsg && <div className="error-banner">{errorMsg}</div>}
          </div>

          {/* Quick Export Card */}
          {result && (
            <div className="instrument-panel rail-card export-rail-card">
              <div className="eyebrow-tag">QUICK DELIVERABLES</div>
              <button
                type="button"
                className="btn-secondary full-w"
                onClick={() =>
                  triggerTextDownload('event_rtk_parameters.csv', buildEventRtkCsv(result))
                }
              >
                <Download size={14} /> Download Storm RTK CSV
              </button>
              {result.gim.enabled && (
                <button
                  type="button"
                  className="btn-secondary full-w"
                  onClick={() =>
                    triggerTextDownload('icm_parameters_summary.csv', buildIcmParametersCsv(result))
                  }
                >
                  <Download size={14} /> Download InfoWorks ICM CSV
                </button>
              )}
            </div>
          )}
        </aside>

        {/* Main Center/Right Stage: Ledger Strip + Split-Horizon Canvas + Analysis Tabs */}
        <main className="main-stage">
          {result ? (
            <>
              {/* Compact Engineering Title Ledger */}
              <div className="ledger-strip">
                <div className="ledger-cell">
                  <span className="ledger-label">MONITORING RECORD</span>
                  <strong className="mono-val">
                    {result.periodStartIso.slice(0, 10)} → {result.periodEndIso.slice(0, 10)}
                  </strong>
                  <small>
                    {result.totalRainDepthIn.toFixed(2)} in rain · {result.areaAcres.toFixed(1)} ac
                  </small>
                </div>

                <div className="ledger-cell">
                  <span className="ledger-label">PUMP CONDITIONING</span>
                  <strong className="mono-val">
                    {result.pump.hasPumpInfluence
                      ? `${result.pump.windowActualMin.toFixed(0)}-min 2-Pass Avg`
                      : 'Gravity (Unfiltered)'}
                  </strong>
                  <small>
                    {result.pump.hasPumpInfluence
                      ? `−${result.pump.roughnessReductionPct.toFixed(1)}% step noise`
                      : `ΔQ std = ${result.pump.rawDiffStdMgd.toFixed(3)} MGD`}
                  </small>
                </div>

                <div className="ledger-cell">
                  <span className="ledger-label">WEIGHTED DWF</span>
                  <strong className="mono-val accent-teal">
                    {convertFlowFromMgd(result.dwf.weightedMeanMgd, displayFlowUnit).toFixed(3)}{' '}
                    {displayFlowUnit}
                  </strong>
                  <small>{result.dwf.cleanDryDayCount} clean dry days isolated</small>
                </div>

                <div className="ledger-cell">
                  <span className="ledger-label">STORM EVENTS &amp; TAIL</span>
                  <strong className="mono-val">
                    {result.events.length} Storms · Max {result.maxTailHours.toFixed(1)} hr
                  </strong>
                  <small>
                    {result.events.filter((e) => e.hasLongGroundwaterTail).length} events trigger
                    ICM GWI
                  </small>
                </div>

                <div className="ledger-cell">
                  <span className="ledger-label">COUPLED MODEL FIT</span>
                  <strong className="mono-val accent-ochre">
                    Daily NSE {result.gim.metrics.nseDaily.toFixed(3)}
                  </strong>
                  <small>
                    15m NSE {result.gim.metrics.nse15m.toFixed(3)} ·{' '}
                    {executionSource === 'aws-lambda'
                      ? 'AWS Lambda'
                      : executionSource === 'local-fallback'
                        ? 'Lambda (Dev Local)'
                        : 'Local Worker'}
                    {computeDurationMs ? ` ${(computeDurationMs / 1000).toFixed(1)}s` : ''}
                  </small>
                </div>
              </div>

              {/* Signature Split-Horizon Interactive Zoomable Hyetograph-Hydrograph Canvas */}
              <SplitHorizonCanvas
                result={result}
                displayFlowUnit={displayFlowUnit}
                displayRainUnit={displayRainUnit}
                zoomDomain={zoomDomain}
                onZoomDomainChange={setZoomDomain}
                selectedEventId={selectedEventId}
                onSelectEvent={handleSelectStormEvent}
                showRaw5m={showRaw5m}
                onToggleRaw5m={setShowRaw5m}
              />

              {/* Subsurface & Hydrograph Calibration Workbench Tabs */}
              <div className="tab-navigation" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'events'}
                  className={activeTab === 'events' ? 'tab-btn active' : 'tab-btn'}
                  onClick={() => setActiveTab('events')}
                >
                  <Sliders size={14} /> Storm Events &amp; 3-Unit RTK ({result.events.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'icm'}
                  className={activeTab === 'icm' ? 'tab-btn active' : 'tab-btn'}
                  onClick={() => setActiveTab('icm')}
                >
                  <Layers size={14} /> InfoWorks ICM Ground Infiltration
                  {result.gim.enabled && <span className="tab-pill">ACTIVE</span>}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'dwf'}
                  className={activeTab === 'dwf' ? 'tab-btn active' : 'tab-btn'}
                  onClick={() => setActiveTab('dwf')}
                >
                  <Database size={14} /> 24-Hr DWF Diurnal &amp; Pump Filter
                </button>
              </div>

              {activeTab === 'events' && (
                <StormEventsPanel
                  result={result}
                  displayFlowUnit={displayFlowUnit}
                  selectedEventId={selectedEventId}
                  onSelectEvent={handleSelectStormEvent}
                />
              )}

              {activeTab === 'icm' && <IcmGimPanel result={result} />}

              {activeTab === 'dwf' && (
                <DwfAndPumpPanel
                  result={result}
                  displayFlowUnit={displayFlowUnit}
                  onZoomToWindow={handleZoomToWindow}
                />
              )}
            </>
          ) : (
            <div className="instrument-panel loading-stage">
              <h3>Preparing Hydraulic Telemetry Workbench...</h3>
              <p>{progressStage || 'Upload rainfall and flow data on the left to begin.'}</p>
            </div>
          )}
        </main>
      </div>

      <CloudSyncModal
        isOpen={cloudModalOpen}
        onClose={() => setCloudModalOpen(false)}
        currentResult={result}
        flowFileName={flowFileName}
        rainFileName={rainFileName}
        flowRawText={flowRawText}
        rainRawText={rainRawText}
        onLambdaResult={(res, ms) => applyCalibrationOutput(res, ms, 'aws-lambda')}
        onLoadCloudRecord={({
          flowText,
          rainText,
          flowFileName: fName,
          rainFileName: rName,
          partialConfig,
        }) => {
          const merged: AnalysisConfig = { ...config, ...partialConfig };
          setFlowFileName(fName);
          setRainFileName(rName);
          setFlowRawText(flowText);
          setRainRawText(rainText);
          setConfig(merged);
          setDisplayFlowUnit(merged.flowUnit);
          setDisplayRainUnit(merged.rainUnit);
          void executeCalibration(flowText, rainText, merged);
        }}
      />
    </div>
  );
};

export default App;
