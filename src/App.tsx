import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cloud,
  CloudRain,
  Cpu,
  Database,
  Download,
  FileUp,
  HardDrive,
  Layers,
  LogOut,
  Play,
  RefreshCw,
  Sliders,
  UserCheck,
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
import { DataManagementPanel } from './components/DataManagementPanel';
import { CloudSyncModal } from './components/CloudSyncModal';
import { AuthScreen } from './components/AuthScreen';
import {
  buildEventRtkCsv,
  buildIcmParametersCsv,
  triggerTextDownload,
} from './engine/exporters';
import { convertFlowFromMgd } from './engine/parser';
import { invokeLambdaFullCalibration, isAmplifyConfigured } from './lib/amplifyCloud';
import {
  deleteTelemetryDataset,
  ensureSampleDatasetsSeeded,
  listTelemetryDatasets,
  loadTelemetryDatasetText,
  updateTelemetryDatasetUnit,
  uploadTelemetryDataset,
  type StoredTelemetryDataset,
  type TelemetryKind,
} from './lib/telemetryStorage';
import {
  getActiveAuthUser,
  signOutUser,
  type AuthSessionUser,
} from './lib/authService';
import type {
  AnalysisConfig,
  AreaUnit,
  FlowUnit,
  FullAnalysisResult,
  RainUnit,
  StormEventRtk,
} from './engine/types';

type ActiveTab = 'data' | 'events' | 'icm' | 'dwf';
type ComputeEnginePreference = 'lambda' | 'worker';
type ExecutionSource = 'aws-lambda' | 'local-fallback' | 'browser-worker';

const DEFAULT_CONFIG: AnalysisConfig = {
  projectName: 'TFM02 Sewer Basin (268 ac)',
  flowUnit: 'MGD',
  rainUnit: 'in/hr',
  areaValue: 268,
  areaUnit: 'acres',
  baselineFlowMgd: 0,
  smoothWindowMinOverride: null,
  enablePumpSmoothing: true,
  interEventGapHours: 24,
  minEventDepthIn: 0.1,
  longTailThresholdHours: 48,
  enableCoupledGim: 'auto',
  optimizerIterations: 36,
};

export const App: React.FC = () => {
  const [authUser, setAuthUser] = useState<AuthSessionUser | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);

  const [config, setConfig] = useState<AnalysisConfig>(DEFAULT_CONFIG);
  const [baselineInput, setBaselineInput] = useState<string>('0');
  const [displayFlowUnit, setDisplayFlowUnit] = useState<FlowUnit>('MGD');
  const [displayRainUnit, setDisplayRainUnit] = useState<RainUnit>('in/hr');

  const [flowFileName, setFlowFileName] = useState<string>('TFM02.txt');
  const [rainFileName, setRainFileName] = useState<string>('Rainfall.txt');
  const [flowRawText, setFlowRawText] = useState<string>('');
  const [rainRawText, setRainRawText] = useState<string>('');

  const [datasets, setDatasets] = useState<StoredTelemetryDataset[]>([]);
  const [selectedRainId, setSelectedRainId] = useState<string | null>(null);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);

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
  const tabsSectionRef = useRef<HTMLDivElement | null>(null);

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
      enginePref: ComputeEnginePreference = computeEngine,
      s3StoragePair?: { flowStoragePath?: string; rainStoragePath?: string }
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
          const cloudRes = await invokeLambdaFullCalibration(
            fText,
            rText,
            cfg,
            (pct, stage) => {
              if (reqIdRef.current === myReqId) {
                setProgressPct(pct);
                setProgressStage(stage);
              }
            },
            s3StoragePair
          );
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
      const seeded = await ensureSampleDatasetsSeeded(fTxt, rTxt, true);
      const catalog = await listTelemetryDatasets();
      setDatasets(catalog);
      setSelectedRainId(seeded.rainId);
      setSelectedFlowId(seeded.flowId);

      setFlowFileName('TFM02.txt');
      setRainFileName('Rainfall.txt');
      setFlowRawText(fTxt);
      setRainRawText(rTxt);
      setConfig(DEFAULT_CONFIG);
      setBaselineInput(String(DEFAULT_CONFIG.baselineFlowMgd));
      setDisplayFlowUnit('MGD');
      setDisplayRainUnit('in/hr');
      void executeCalibration(fTxt, rTxt, DEFAULT_CONFIG, 'lambda');
    } catch (err) {
      setIsCalibrating(false);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [executeCalibration]);

  // Restore active Amazon Cognito / local preview session on startup
  useEffect(() => {
    let active = true;
    getActiveAuthUser()
      .then((user) => {
        if (active) {
          setAuthUser(user);
          setAuthChecking(false);
        }
      })
      .catch(() => {
        if (active) setAuthChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Auto-load TFM02 sample basin only after user is authenticated
  const hasLoadedForUserRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authUser) {
      hasLoadedForUserRef.current = null;
      return;
    }
    if (hasLoadedForUserRef.current !== authUser.userId) {
      hasLoadedForUserRef.current = authUser.userId;
      void loadBuiltInSample();
    }
  }, [authUser, loadBuiltInSample]);

  const handleSignOut = async () => {
    reqIdRef.current += 1;
    setIsCalibrating(false);
    await signOutUser();
    setAuthUser(null);
  };

  const openDataManagementPanel = () => {
    setActiveTab('data');
    setTimeout(() => {
      tabsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 40);
  };

  const handleSelectRainDataset = async (ds: StoredTelemetryDataset) => {
    setSelectedRainId(ds.id);
    try {
      const text = await loadTelemetryDatasetText(ds);
      const unit = ds.unit as RainUnit;
      setRainFileName(ds.fileName);
      setRainRawText(text);
      setConfig((prev) => ({ ...prev, rainUnit: unit }));
      setDisplayRainUnit(unit);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectFlowDataset = async (ds: StoredTelemetryDataset) => {
    setSelectedFlowId(ds.id);
    try {
      const text = await loadTelemetryDatasetText(ds);
      const unit = ds.unit as FlowUnit;
      setFlowFileName(ds.fileName);
      setFlowRawText(text);
      setConfig((prev) => ({ ...prev, flowUnit: unit }));
      setDisplayFlowUnit(unit);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleVaultUpload = async ({
    files,
    kind,
    unit,
    customName,
  }: {
    files: File[];
    kind: TelemetryKind;
    unit: RainUnit | FlowUnit;
    customName: string;
  }) => {
    let lastCreated: StoredTelemetryDataset | null = null;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const rawText = await f.text();
      const label =
        files.length === 1
          ? customName
          : customName.trim()
            ? `${customName.trim()} (${i + 1})`
            : '';
      lastCreated = await uploadTelemetryDataset({
        rawText,
        fileName: f.name,
        customName: label,
        kind,
        unit,
      });
    }
    const catalog = await listTelemetryDatasets();
    setDatasets(catalog);
    if (lastCreated) {
      if (kind === 'rain') {
        await handleSelectRainDataset(lastCreated);
      } else {
        await handleSelectFlowDataset(lastCreated);
      }
    }
  };

  const handleChangeDatasetUnit = async (
    ds: StoredTelemetryDataset,
    nextUnit: RainUnit | FlowUnit
  ) => {
    const updated = await updateTelemetryDatasetUnit(ds, nextUnit);
    const catalog = await listTelemetryDatasets();
    setDatasets(catalog);
    if (ds.kind === 'rain' && ds.id === selectedRainId) {
      setConfig((prev) => ({ ...prev, rainUnit: updated.unit as RainUnit }));
      setDisplayRainUnit(updated.unit as RainUnit);
    } else if (ds.kind === 'flow' && ds.id === selectedFlowId) {
      setConfig((prev) => ({ ...prev, flowUnit: updated.unit as FlowUnit }));
      setDisplayFlowUnit(updated.unit as FlowUnit);
    }
  };

  const handleDeleteDataset = async (ds: StoredTelemetryDataset) => {
    await deleteTelemetryDataset(ds);
    const catalog = await listTelemetryDatasets();
    setDatasets(catalog);
    if (ds.kind === 'rain' && ds.id === selectedRainId) {
      const nextRain = catalog.find((item) => item.kind === 'rain') ?? null;
      if (nextRain) {
        await handleSelectRainDataset(nextRain);
      } else {
        setSelectedRainId(null);
        setRainFileName('');
        setRainRawText('');
      }
    } else if (ds.kind === 'flow' && ds.id === selectedFlowId) {
      const nextFlow = catalog.find((item) => item.kind === 'flow') ?? null;
      if (nextFlow) {
        await handleSelectFlowDataset(nextFlow);
      } else {
        setSelectedFlowId(null);
        setFlowFileName('');
        setFlowRawText('');
      }
    }
  };

  const handleRestoreSampleDatasets = async () => {
    const [fRes, rRes] = await Promise.all([
      fetch('/sample-data/TFM02.txt'),
      fetch('/sample-data/Rainfall.txt'),
    ]);
    if (!fRes.ok || !rRes.ok) {
      throw new Error('Sample files could not be fetched.');
    }
    const [fTxt, rTxt] = await Promise.all([fRes.text(), rRes.text()]);
    const seeded = await ensureSampleDatasetsSeeded(fTxt, rTxt, true);
    const catalog = await listTelemetryDatasets();
    setDatasets(catalog);
    if (!selectedRainId) {
      const rDs = catalog.find((d) => d.id === seeded.rainId);
      if (rDs) await handleSelectRainDataset(rDs);
    }
    if (!selectedFlowId) {
      const fDs = catalog.find((d) => d.id === seeded.flowId);
      if (fDs) await handleSelectFlowDataset(fDs);
    }
  };

  const handleAnalyzeSelectedPair = async () => {
    const selRain = datasets.find((d) => d.id === selectedRainId && d.kind === 'rain');
    const selFlow = datasets.find((d) => d.id === selectedFlowId && d.kind === 'flow');
    if (!selRain || !selFlow) {
      setErrorMsg('Select both one Rainfall dataset and one Sewer Flow dataset to analyze.');
      return;
    }
    try {
      const [rTxt, fTxt] = await Promise.all([
        loadTelemetryDatasetText(selRain),
        loadTelemetryDatasetText(selFlow),
      ]);
      const nextCfg: AnalysisConfig = {
        ...config,
        rainUnit: selRain.unit as RainUnit,
        flowUnit: selFlow.unit as FlowUnit,
      };
      setConfig(nextCfg);
      setRainFileName(selRain.fileName);
      setFlowFileName(selFlow.fileName);
      setRainRawText(rTxt);
      setFlowRawText(fTxt);
      setDisplayRainUnit(selRain.unit as RainUnit);
      setDisplayFlowUnit(selFlow.unit as FlowUnit);
      setActiveTab('events');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await executeCalibration(fTxt, rTxt, nextCfg, computeEngine, {
        flowStoragePath: selFlow.source === 'amplify-s3' ? selFlow.storagePath : undefined,
        rainStoragePath: selRain.source === 'amplify-s3' ? selRain.storagePath : undefined,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFileUpload = async (
    file: File | undefined,
    kind: 'flow' | 'rain'
  ) => {
    if (!file) return;
    try {
      setErrorMsg(null);
      const unit = kind === 'rain' ? config.rainUnit : config.flowUnit;
      await handleVaultUpload({
        files: [file],
        kind,
        unit,
        customName: '',
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
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

  if (authChecking) {
    return (
      <div className="auth-checking-screen" role="status">
        <div className="brand-glyph">
          <Waves size={20} />
        </div>
        <span>Verifying session credentials...</span>
      </div>
    );
  }

  if (!authUser) {
    return <AuthScreen onAuthenticated={(user) => setAuthUser(user)} />;
  }

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
            className={`btn-secondary ${activeTab === 'data' ? 'btn-active-data' : ''}`}
            onClick={openDataManagementPanel}
          >
            <HardDrive size={14} /> Data Management ({datasets.length})
          </button>

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

          <div className="user-session-pill" title={`Signed in as ${authUser.email}`}>
            <UserCheck size={13} />
            <span className="user-session-email">{authUser.displayName}</span>
            <button
              type="button"
              className="user-signout-btn"
              onClick={() => void handleSignOut()}
              title="Sign out"
            >
              <LogOut size={13} />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <div className="workspace-columns">
        {/* Left Rail: Telemetry Upload, Units, Basin Area & Calibration Controls */}
        <aside className="config-rail">
          <div className="instrument-panel rail-card">
            <div className="rail-section-head">
              <div className="eyebrow-tag">1 · TELEMETRY &amp; UNITS</div>
              <button
                type="button"
                className="rail-vault-link"
                onClick={openDataManagementPanel}
              >
                <HardDrive size={11} /> Manage Storage ({datasets.length})
              </button>
            </div>
            <label className="field-label">
              Basin / Meter Name
              <input
                type="text"
                className="text-input"
                value={config.projectName}
                onChange={(e) => setConfig({ ...config, projectName: e.target.value })}
              />
            </label>

            {/* Rainfall Upload + Stored Selector + Input Unit */}
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
                    onChange={(e) => {
                      void handleFileUpload(e.target.files?.[0], 'rain');
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              {datasets.some((d) => d.kind === 'rain') ? (
                <select
                  aria-label="Stored rainfall dataset"
                  className="stored-select"
                  value={selectedRainId ?? ''}
                  onChange={(e) => {
                    const ds = datasets.find((d) => d.id === e.target.value);
                    if (ds) void handleSelectRainDataset(ds);
                  }}
                >
                  {datasets
                    .filter((d) => d.kind === 'rain')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.unit})
                      </option>
                    ))}
                </select>
              ) : (
                <div className="file-name-chip" title={rainFileName}>
                  {rainFileName || 'No rainfall file selected'}
                </div>
              )}
              <div className="inline-unit-row">
                <span>File Rain Unit</span>
                <select
                  value={config.rainUnit}
                  onChange={(e) => {
                    const nextU = e.target.value as RainUnit;
                    setConfig({ ...config, rainUnit: nextU });
                    setDisplayRainUnit(nextU);
                    const cur = datasets.find((d) => d.id === selectedRainId);
                    if (cur) void handleChangeDatasetUnit(cur, nextU);
                  }}
                >
                  <option value="in/hr">in/hr (Intensity)</option>
                  <option value="in">in (Depth per step)</option>
                  <option value="mm/hr">mm/hr (Intensity)</option>
                  <option value="mm">mm (Depth per step)</option>
                </select>
              </div>
            </div>

            {/* Flow Upload + Stored Selector + Input Unit */}
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
                    onChange={(e) => {
                      void handleFileUpload(e.target.files?.[0], 'flow');
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              {datasets.some((d) => d.kind === 'flow') ? (
                <select
                  aria-label="Stored sewer flow dataset"
                  className="stored-select"
                  value={selectedFlowId ?? ''}
                  onChange={(e) => {
                    const ds = datasets.find((d) => d.id === e.target.value);
                    if (ds) void handleSelectFlowDataset(ds);
                  }}
                >
                  {datasets
                    .filter((d) => d.kind === 'flow')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.unit})
                      </option>
                    ))}
                </select>
              ) : (
                <div className="file-name-chip" title={flowFileName}>
                  {flowFileName || 'No flow file selected'}
                </div>
              )}
              <div className="inline-unit-row">
                <span>File Flow Unit</span>
                <select
                  value={config.flowUnit}
                  onChange={(e) => {
                    const nextU = e.target.value as FlowUnit;
                    setConfig({ ...config, flowUnit: nextU });
                    setDisplayFlowUnit(nextU);
                    const cur = datasets.find((d) => d.id === selectedFlowId);
                    if (cur) void handleChangeDatasetUnit(cur, nextU);
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

            {/* Contributing Service Area & Baseline Flow */}
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

            <label className="field-label">
              Baseline Flow (MGD)
              <input
                type="number"
                step="0.05"
                className="text-input mono-input"
                value={baselineInput}
                onChange={(e) => {
                  const raw = e.target.value;
                  setBaselineInput(raw);
                  const parsed = raw === '' || raw === '-' ? 0 : Number(raw);
                  if (Number.isFinite(parsed)) {
                    setConfig({ ...config, baselineFlowMgd: parsed });
                  }
                }}
              />
            </label>
            <div className="formula-pill-note">
              Total Flow = Baseline + Diurnal + RTK + Groundwater Infiltration
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
                  <span className="ledger-label">BASELINE + DIURNAL</span>
                  <strong className="mono-val accent-teal">
                    {convertFlowFromMgd(
                      result.baselineFlowMgd + result.dwf.weightedMeanMgd,
                      displayFlowUnit
                    ).toFixed(3)}{' '}
                    {displayFlowUnit}
                  </strong>
                  <small>
                    Base {convertFlowFromMgd(result.baselineFlowMgd, displayFlowUnit).toFixed(2)} +
                    Diurnal {convertFlowFromMgd(result.dwf.weightedMeanMgd, displayFlowUnit).toFixed(3)}{' '}
                    ({result.dwf.cleanDryDayCount}d)
                  </small>
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
              <div ref={tabsSectionRef} className="tab-navigation" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'data'}
                  className={activeTab === 'data' ? 'tab-btn active' : 'tab-btn'}
                  onClick={() => setActiveTab('data')}
                >
                  <HardDrive size={14} /> Data Management ({datasets.length})
                </button>
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

              {activeTab === 'data' && (
                <DataManagementPanel
                  datasets={datasets}
                  selectedRainId={selectedRainId}
                  selectedFlowId={selectedFlowId}
                  isCalibrating={isCalibrating}
                  onSelectRain={handleSelectRainDataset}
                  onSelectFlow={handleSelectFlowDataset}
                  onUploadFiles={handleVaultUpload}
                  onChangeDatasetUnit={handleChangeDatasetUnit}
                  onDeleteDataset={handleDeleteDataset}
                  onRestoreSamples={handleRestoreSampleDatasets}
                  onAnalyzeSelectedPair={handleAnalyzeSelectedPair}
                />
              )}

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
          ) : activeTab === 'data' ? (
            <div ref={tabsSectionRef}>
              <DataManagementPanel
                datasets={datasets}
                selectedRainId={selectedRainId}
                selectedFlowId={selectedFlowId}
                isCalibrating={isCalibrating}
                onSelectRain={handleSelectRainDataset}
                onSelectFlow={handleSelectFlowDataset}
                onUploadFiles={handleVaultUpload}
                onChangeDatasetUnit={handleChangeDatasetUnit}
                onDeleteDataset={handleDeleteDataset}
                onRestoreSamples={handleRestoreSampleDatasets}
                onAnalyzeSelectedPair={handleAnalyzeSelectedPair}
              />
            </div>
          ) : (
            <div className="instrument-panel loading-stage">
              <h3>Preparing Hydraulic Telemetry Workbench...</h3>
              <p>{progressStage || 'Open Data Management to upload and select rainfall & flow files.'}</p>
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
          setBaselineInput(String(merged.baselineFlowMgd ?? 0));
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
