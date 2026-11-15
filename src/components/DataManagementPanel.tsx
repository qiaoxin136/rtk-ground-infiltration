import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudRain,
  Download,
  Eye,
  EyeOff,
  FileUp,
  HardDrive,
  Play,
  RotateCcw,
  Trash2,
  Waves,
} from 'lucide-react';
import { triggerTextDownload } from '../engine/exporters';
import type { FlowUnit, RainUnit } from '../engine/types';
import { isAmplifyConfigured } from '../lib/amplifyCloud';
import {
  computeDatasetOverlap,
  loadTelemetryDatasetText,
  type StoredTelemetryDataset,
  type TelemetryKind,
} from '../lib/telemetryStorage';

interface DataManagementPanelProps {
  datasets: StoredTelemetryDataset[];
  selectedRainId: string | null;
  selectedFlowId: string | null;
  isCalibrating: boolean;
  onSelectRain: (dataset: StoredTelemetryDataset) => void;
  onSelectFlow: (dataset: StoredTelemetryDataset) => void;
  onUploadFiles: (params: {
    files: File[];
    kind: TelemetryKind;
    unit: RainUnit | FlowUnit;
    customName: string;
  }) => Promise<void>;
  onChangeDatasetUnit: (
    dataset: StoredTelemetryDataset,
    nextUnit: RainUnit | FlowUnit
  ) => Promise<void>;
  onDeleteDataset: (dataset: StoredTelemetryDataset) => Promise<void>;
  onRestoreSamples: () => Promise<void>;
  onAnalyzeSelectedPair: () => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sourceBadgeLabel(source: StoredTelemetryDataset['source']): string {
  if (source === 'amplify-s3') return 'AWS S3';
  if (source === 'built-in-sample') return 'Sample';
  return 'Local Vault';
}

export const DataManagementPanel: React.FC<DataManagementPanelProps> = ({
  datasets,
  selectedRainId,
  selectedFlowId,
  isCalibrating,
  onSelectRain,
  onSelectFlow,
  onUploadFiles,
  onChangeDatasetUnit,
  onDeleteDataset,
  onRestoreSamples,
  onAnalyzeSelectedPair,
}) => {
  const [rainUploadName, setRainUploadName] = useState('');
  const [rainUploadUnit, setRainUploadUnit] = useState<RainUnit>('in/hr');
  const [flowUploadName, setFlowUploadName] = useState('');
  const [flowUploadUnit, setFlowUploadUnit] = useState<FlowUnit>('MGD');

  const [dragTarget, setDragTarget] = useState<TelemetryKind | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [panelNotice, setPanelNotice] = useState<{
    tone: 'ok' | 'err';
    text: string;
  } | null>(null);

  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewLines, setPreviewLines] = useState<string[]>([]);

  const rainDatasets = useMemo(
    () => datasets.filter((d) => d.kind === 'rain'),
    [datasets]
  );
  const flowDatasets = useMemo(
    () => datasets.filter((d) => d.kind === 'flow'),
    [datasets]
  );

  const selectedRain = useMemo(
    () => rainDatasets.find((d) => d.id === selectedRainId) ?? null,
    [rainDatasets, selectedRainId]
  );
  const selectedFlow = useMemo(
    () => flowDatasets.find((d) => d.id === selectedFlowId) ?? null,
    [flowDatasets, selectedFlowId]
  );

  const overlap = useMemo(
    () => computeDatasetOverlap(selectedRain, selectedFlow),
    [selectedRain, selectedFlow]
  );

  const handleFilesChosen = async (
    fileList: FileList | null,
    kind: TelemetryKind
  ) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const unit = kind === 'rain' ? rainUploadUnit : flowUploadUnit;
    const customName = kind === 'rain' ? rainUploadName : flowUploadName;
    setPanelNotice(null);
    setBusyMessage(
      `Validating & storing ${files.length} ${
        kind === 'rain' ? 'rainfall' : 'sewer flow'
      } file${files.length > 1 ? 's' : ''}...`
    );
    try {
      await onUploadFiles({ files, kind, unit, customName });
      if (kind === 'rain') setRainUploadName('');
      else setFlowUploadName('');
      setPanelNotice({
        tone: 'ok',
        text: `Stored ${files.length} ${
          kind === 'rain' ? 'rainfall' : 'flow'
        } dataset${files.length > 1 ? 's' : ''} in ${
          isAmplifyConfigured ? 'AWS Amplify S3 Storage' : 'Telemetry Storage Vault'
        }.`,
      });
    } catch (err) {
      setPanelNotice({
        tone: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyMessage(null);
    }
  };

  const handleTogglePreview = async (ds: StoredTelemetryDataset) => {
    if (previewId === ds.id) {
      setPreviewId(null);
      setPreviewLines([]);
      return;
    }
    try {
      const text = await loadTelemetryDatasetText(ds);
      const lines = text
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .slice(0, 10);
      setPreviewId(ds.id);
      setPreviewLines(lines);
    } catch (err) {
      setPanelNotice({
        tone: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDownloadRaw = async (ds: StoredTelemetryDataset) => {
    try {
      const text = await loadTelemetryDatasetText(ds);
      triggerTextDownload(ds.fileName, text, 'text/plain;charset=utf-8');
    } catch (err) {
      setPanelNotice({
        tone: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDelete = async (ds: StoredTelemetryDataset) => {
    setBusyMessage(`Removing "${ds.name}" from storage...`);
    setPanelNotice(null);
    try {
      if (previewId === ds.id) {
        setPreviewId(null);
        setPreviewLines([]);
      }
      await onDeleteDataset(ds);
      setPanelNotice({
        tone: 'ok',
        text: `Removed "${ds.name}" from storage.`,
      });
    } catch (err) {
      setPanelNotice({
        tone: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyMessage(null);
    }
  };

  return (
    <div className="data-mgmt-stack">
      {/* Top Pairing & Execution Ribbon */}
      <div className="instrument-panel pairing-banner-panel">
        <div className="panel-header-row pairing-top-row">
          <div>
            <div className="eyebrow-tag">TELEMETRY STORAGE &amp; ACTIVE PAIR SELECTION</div>
            <h3 className="panel-title">
              Select One Rainfall Dataset &amp; One Sewer Flow Dataset to Analyze
            </h3>
            <p className="panel-subtitle">
              {isAmplifyConfigured ? (
                <>
                  <Cloud size={13} className="inline-icon" /> Connected to{' '}
                  <strong>AWS Amplify S3 + DynamoDB</strong> — uploaded telemetry persists across
                  sessions and streams directly into AWS Lambda.
                </>
              ) : (
                <>
                  <HardDrive size={13} className="inline-icon" /> Persistent{' '}
                  <strong>IndexedDB Telemetry Vault</strong> active — automatically syncs to AWS S3{' '}
                  <code className="dm-inline-code">telemetry/*</code> when{' '}
                  <code className="dm-inline-code">amplify_outputs.json</code> is deployed.
                </>
              )}
            </p>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={Boolean(busyMessage) || isCalibrating}
              onClick={() => void onRestoreSamples()}
              title="Ensure built-in Rainfall.txt and TFM02.txt sample datasets are available in storage"
            >
              <RotateCcw size={14} /> Restore Sample Datasets
            </button>
          </div>
        </div>

        <div className="selected-pair-grid">
          {/* Selected Rainfall Card */}
          <div className={`pair-slot-card ${selectedRain ? 'has-rain' : 'is-empty'}`}>
            <div className="pair-slot-kicker">
              <CloudRain size={14} /> ACTIVE RAINFALL INPUT
            </div>
            {selectedRain ? (
              <>
                <div className="pair-slot-title">{selectedRain.name}</div>
                <div className="pair-slot-meta mono-val">
                  {selectedRain.fileName} · <strong>{selectedRain.unit}</strong> ·{' '}
                  {selectedRain.intervalMin}m step · {selectedRain.recordCount.toLocaleString()} pts
                </div>
                <div className="pair-slot-span mono-val">
                  {selectedRain.startIso.slice(0, 10)} → {selectedRain.endIso.slice(0, 10)} · Total{' '}
                  {selectedRain.summaryStat.toFixed(2)} in
                </div>
              </>
            ) : (
              <div className="pair-slot-empty">
                No rainfall dataset selected. Upload or choose one below.
              </div>
            )}
          </div>

          {/* Selected Flow Card */}
          <div className={`pair-slot-card ${selectedFlow ? 'has-flow' : 'is-empty'}`}>
            <div className="pair-slot-kicker">
              <Waves size={14} /> ACTIVE SEWER FLOW INPUT
            </div>
            {selectedFlow ? (
              <>
                <div className="pair-slot-title">{selectedFlow.name}</div>
                <div className="pair-slot-meta mono-val">
                  {selectedFlow.fileName} · <strong>{selectedFlow.unit}</strong> ·{' '}
                  {selectedFlow.intervalMin}m step · {selectedFlow.recordCount.toLocaleString()} pts
                </div>
                <div className="pair-slot-span mono-val">
                  {selectedFlow.startIso.slice(0, 10)} → {selectedFlow.endIso.slice(0, 10)} · Mean{' '}
                  {selectedFlow.summaryStat.toFixed(3)} MGD
                </div>
              </>
            ) : (
              <div className="pair-slot-empty">
                No sewer flow dataset selected. Upload or choose one below.
              </div>
            )}
          </div>

          {/* Overlap Check & Run CTA */}
          <div className="pair-action-box">
            {selectedRain && selectedFlow ? (
              overlap.hasOverlap ? (
                <div className="overlap-status ok">
                  <CheckCircle2 size={15} />
                  <div>
                    <strong>{overlap.overlapDays.toFixed(1)} days overlapping telemetry</strong>
                    <span>
                      {overlap.overlapStartIso} → {overlap.overlapEndIso}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="overlap-status warn">
                  <AlertTriangle size={15} />
                  <div>
                    <strong>No date overlap between selected files</strong>
                    <span>Choose rainfall and flow datasets from the same monitoring period.</span>
                  </div>
                </div>
              )
            ) : (
              <div className="overlap-status neutral">
                <HardDrive size={15} />
                <div>
                  <strong>Pair incomplete</strong>
                  <span>Select 1 rainfall file and 1 flow file from storage below.</span>
                </div>
              </div>
            )}

            <button
              type="button"
              className="btn-primary full-w"
              disabled={!overlap.hasOverlap || isCalibrating || Boolean(busyMessage)}
              onClick={() => void onAnalyzeSelectedPair()}
            >
              <Play size={15} />
              {isCalibrating ? 'Analyzing Selected Telemetry...' : 'Analyze Selected Rainfall & Flow'}
            </button>
          </div>
        </div>

        {busyMessage && <div className="cloud-notice busy">{busyMessage}</div>}
        {panelNotice && (
          <div className={`dm-notice ${panelNotice.tone === 'err' ? 'is-err' : 'is-ok'}`}>
            {panelNotice.text}
          </div>
        )}
      </div>

      {/* Two-Column Storage Vaults */}
      <div className="workbench-grid dm-vault-grid">
        {/* LEFT VAULT: RAINFALL HYETOGRAPH STORAGE */}
        <section className="instrument-panel">
          <div className="panel-header-row">
            <div>
              <div className="eyebrow-tag">STORAGE BUCKET · RAINFALL GAUGES</div>
              <h3 className="panel-title">
                Rainfall Datasets ({rainDatasets.length})
              </h3>
              <p className="panel-subtitle">
                Upload rain gauge time series (.txt, .csv, .tsv) and select one gauge for basin
                analysis.
              </p>
            </div>
          </div>

          {/* Rainfall Upload Composer */}
          <div
            className={`dm-upload-zone rain-zone ${dragTarget === 'rain' ? 'is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragTarget('rain');
            }}
            onDragLeave={() => setDragTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragTarget(null);
              void handleFilesChosen(e.dataTransfer.files, 'rain');
            }}
          >
            <div className="dm-upload-inputs">
              <label className="field-label">
                Gauge Label (optional)
                <input
                  type="text"
                  className="text-input"
                  placeholder="e.g. North Rain Gauge RG-01"
                  value={rainUploadName}
                  onChange={(e) => setRainUploadName(e.target.value)}
                />
              </label>
              <label className="field-label">
                File Rainfall Unit
                <select
                  className="text-input"
                  value={rainUploadUnit}
                  onChange={(e) => setRainUploadUnit(e.target.value as RainUnit)}
                >
                  <option value="in/hr">in/hr (Intensity)</option>
                  <option value="in">in (Depth / step)</option>
                  <option value="mm/hr">mm/hr (Intensity)</option>
                  <option value="mm">mm (Depth / step)</option>
                </select>
              </label>
            </div>
            <div className="dm-upload-trigger-row">
              <span className="dm-drop-hint">
                Drop .txt or .csv rainfall files here, or browse:
              </span>
              <label className="btn-primary dm-upload-btn">
                <FileUp size={14} /> Upload Rainfall to Storage
                <input
                  type="file"
                  accept=".txt,.csv,.tsv,.dat"
                  multiple
                  onChange={(e) => {
                    void handleFilesChosen(e.target.files, 'rain');
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>

          {/* Stored Rainfall List */}
          {rainDatasets.length === 0 ? (
            <div className="empty-callout">
              No rainfall files stored yet. Upload a rainfall hyetograph above to add it to storage.
            </div>
          ) : (
            <div className="dm-dataset-list" role="radiogroup" aria-label="Stored rainfall datasets">
              {rainDatasets.map((ds) => {
                const isSelected = ds.id === selectedRainId;
                const isPreviewing = previewId === ds.id;
                return (
                  <div
                    key={ds.id}
                    className={`dm-dataset-card rain-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => onSelectRain(ds)}
                  >
                    <div className="dm-card-main">
                      <div className="dm-card-left">
                        <label className="dm-radio-wrap" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="radio"
                            name="selected-rain-dataset"
                            checked={isSelected}
                            onChange={() => onSelectRain(ds)}
                          />
                          <span className="sr-only">Select {ds.name}</span>
                        </label>

                        <div className="dm-card-info">
                          <div className="dm-card-title-row">
                            <strong className="dm-card-name">{ds.name}</strong>
                            {isSelected && <span className="dm-selected-pill rain">SELECTED</span>}
                            <span className={`dm-source-pill src-${ds.source}`}>
                              {sourceBadgeLabel(ds.source)}
                            </span>
                          </div>

                          <div className="dm-card-meta mono-val">
                            <span>{ds.fileName}</span>
                            <span>·</span>
                            <span>
                              {ds.startIso.slice(0, 10)} → {ds.endIso.slice(0, 10)}
                            </span>
                            <span>·</span>
                            <span>{ds.intervalMin}m</span>
                            <span>·</span>
                            <span>{ds.recordCount.toLocaleString()} pts</span>
                            <span>·</span>
                            <span>Total {ds.summaryStat.toFixed(2)} in</span>
                            <span>·</span>
                            <span>{formatBytes(ds.sizeBytes)}</span>
                          </div>
                        </div>
                      </div>

                      <div
                        className="dm-card-controls"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <select
                          aria-label={`Rainfall unit for ${ds.name}`}
                          className="dm-unit-select"
                          value={ds.unit}
                          onChange={(e) =>
                            void onChangeDatasetUnit(ds, e.target.value as RainUnit)
                          }
                        >
                          <option value="in/hr">in/hr</option>
                          <option value="in">in</option>
                          <option value="mm/hr">mm/hr</option>
                          <option value="mm">mm</option>
                        </select>

                        <button
                          type="button"
                          className="icon-zoom-btn"
                          title={isPreviewing ? 'Hide raw preview' : 'Preview first 10 rows'}
                          onClick={() => void handleTogglePreview(ds)}
                        >
                          {isPreviewing ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>

                        <button
                          type="button"
                          className="icon-zoom-btn"
                          title="Download raw file from storage"
                          onClick={() => void handleDownloadRaw(ds)}
                        >
                          <Download size={13} />
                        </button>

                        <button
                          type="button"
                          className="icon-zoom-btn dm-delete-btn"
                          title="Delete dataset from storage"
                          onClick={() => void handleDelete(ds)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {isPreviewing && (
                      <pre
                        className="dm-raw-preview"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {previewLines.join('\n')}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* RIGHT VAULT: SEWER FLOW METER STORAGE */}
        <section className="instrument-panel">
          <div className="panel-header-row">
            <div>
              <div className="eyebrow-tag">STORAGE BUCKET · SEWER FLOW METERS</div>
              <h3 className="panel-title">
                Sewer Flow Datasets ({flowDatasets.length})
              </h3>
              <p className="panel-subtitle">
                Upload trunk meter or lift-station telemetry (.txt, .csv, .tsv) and select one meter
                for analysis.
              </p>
            </div>
          </div>

          {/* Flow Upload Composer */}
          <div
            className={`dm-upload-zone flow-zone ${dragTarget === 'flow' ? 'is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragTarget('flow');
            }}
            onDragLeave={() => setDragTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragTarget(null);
              void handleFilesChosen(e.dataTransfer.files, 'flow');
            }}
          >
            <div className="dm-upload-inputs">
              <label className="field-label">
                Meter Label (optional)
                <input
                  type="text"
                  className="text-input"
                  placeholder="e.g. Interceptor Meter TFM-02"
                  value={flowUploadName}
                  onChange={(e) => setFlowUploadName(e.target.value)}
                />
              </label>
              <label className="field-label">
                File Flow Unit
                <select
                  className="text-input"
                  value={flowUploadUnit}
                  onChange={(e) => setFlowUploadUnit(e.target.value as FlowUnit)}
                >
                  <option value="MGD">MGD</option>
                  <option value="cfs">cfs</option>
                  <option value="gpm">gpm</option>
                  <option value="L/s">L/s</option>
                  <option value="m3/s">m³/s</option>
                </select>
              </label>
            </div>
            <div className="dm-upload-trigger-row">
              <span className="dm-drop-hint">
                Drop .txt or .csv flow files here, or browse:
              </span>
              <label className="btn-primary dm-upload-btn flow-btn">
                <FileUp size={14} /> Upload Flow to Storage
                <input
                  type="file"
                  accept=".txt,.csv,.tsv,.dat"
                  multiple
                  onChange={(e) => {
                    void handleFilesChosen(e.target.files, 'flow');
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>

          {/* Stored Flow List */}
          {flowDatasets.length === 0 ? (
            <div className="empty-callout">
              No sewer flow files stored yet. Upload a flow meter file above to add it to storage.
            </div>
          ) : (
            <div className="dm-dataset-list" role="radiogroup" aria-label="Stored sewer flow datasets">
              {flowDatasets.map((ds) => {
                const isSelected = ds.id === selectedFlowId;
                const isPreviewing = previewId === ds.id;
                return (
                  <div
                    key={ds.id}
                    className={`dm-dataset-card flow-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => onSelectFlow(ds)}
                  >
                    <div className="dm-card-main">
                      <div className="dm-card-left">
                        <label className="dm-radio-wrap" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="radio"
                            name="selected-flow-dataset"
                            checked={isSelected}
                            onChange={() => onSelectFlow(ds)}
                          />
                          <span className="sr-only">Select {ds.name}</span>
                        </label>

                        <div className="dm-card-info">
                          <div className="dm-card-title-row">
                            <strong className="dm-card-name">{ds.name}</strong>
                            {isSelected && <span className="dm-selected-pill flow">SELECTED</span>}
                            <span className={`dm-source-pill src-${ds.source}`}>
                              {sourceBadgeLabel(ds.source)}
                            </span>
                          </div>

                          <div className="dm-card-meta mono-val">
                            <span>{ds.fileName}</span>
                            <span>·</span>
                            <span>
                              {ds.startIso.slice(0, 10)} → {ds.endIso.slice(0, 10)}
                            </span>
                            <span>·</span>
                            <span>{ds.intervalMin}m</span>
                            <span>·</span>
                            <span>{ds.recordCount.toLocaleString()} pts</span>
                            <span>·</span>
                            <span>Mean {ds.summaryStat.toFixed(3)} MGD</span>
                            <span>·</span>
                            <span>{formatBytes(ds.sizeBytes)}</span>
                          </div>
                        </div>
                      </div>

                      <div
                        className="dm-card-controls"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <select
                          aria-label={`Flow unit for ${ds.name}`}
                          className="dm-unit-select"
                          value={ds.unit}
                          onChange={(e) =>
                            void onChangeDatasetUnit(ds, e.target.value as FlowUnit)
                          }
                        >
                          <option value="MGD">MGD</option>
                          <option value="cfs">cfs</option>
                          <option value="gpm">gpm</option>
                          <option value="L/s">L/s</option>
                          <option value="m3/s">m³/s</option>
                        </select>

                        <button
                          type="button"
                          className="icon-zoom-btn"
                          title={isPreviewing ? 'Hide raw preview' : 'Preview first 10 rows'}
                          onClick={() => void handleTogglePreview(ds)}
                        >
                          {isPreviewing ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>

                        <button
                          type="button"
                          className="icon-zoom-btn"
                          title="Download raw file from storage"
                          onClick={() => void handleDownloadRaw(ds)}
                        >
                          <Download size={13} />
                        </button>

                        <button
                          type="button"
                          className="icon-zoom-btn dm-delete-btn"
                          title="Delete dataset from storage"
                          onClick={() => void handleDelete(ds)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {isPreviewing && (
                      <pre
                        className="dm-raw-preview"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {previewLines.join('\n')}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
