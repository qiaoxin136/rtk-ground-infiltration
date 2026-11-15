import { downloadData, remove, uploadData } from 'aws-amplify/storage';
import {
  FLOW_TO_MGD,
  convertRainToInHr,
  formatWallClockIso,
  parseTelemetryText,
} from '../engine/parser';
import type { FlowUnit, RainUnit } from '../engine/types';
import { getAmplifyDataClient, isAmplifyConfigured } from './amplifyCloud';

export type TelemetryKind = 'rain' | 'flow';
export type TelemetryStorageSource = 'amplify-s3' | 'local-storage' | 'built-in-sample';

export interface StoredTelemetryDataset {
  id: string;
  name: string;
  kind: TelemetryKind;
  fileName: string;
  unit: RainUnit | FlowUnit;
  storagePath: string;
  sizeBytes: number;
  recordCount: number;
  intervalMin: number;
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
  peakValue: number;
  /** For rain: total depth in inches. For flow: mean flow in MGD. */
  summaryStat: number;
  createdAt: string;
  source: TelemetryStorageSource;
}

interface VaultEntry {
  id: string;
  meta: StoredTelemetryDataset;
  rawText: string;
}

const IDB_NAME = 'rtk_telemetry_vault_v1';
const IDB_STORE = 'datasets';
const SAMPLE_RAIN_ID = 'sample-rain-default';
const SAMPLE_FLOW_ID = 'sample-flow-default';
const DELETED_SAMPLES_KEY = 'rtk_gim_deleted_samples_v1';

// In-memory fallback for Node.js verification scripts where IndexedDB is unavailable
const memoryVault = new Map<string, VaultEntry>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB telemetry vault.'));
  });
}

async function idbPutEntry(entry: VaultEntry): Promise<void> {
  memoryVault.set(entry.id, entry);
  if (!hasIndexedDb()) return;
  const db = await openVaultDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(entry);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('IndexedDB write failed.'));
    };
  });
}

async function idbGetEntry(id: string): Promise<VaultEntry | null> {
  if (!hasIndexedDb()) {
    return memoryVault.get(id) ?? null;
  }
  const db = await openVaultDb();
  return new Promise<VaultEntry | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as VaultEntry | undefined) ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error ?? new Error('IndexedDB read failed.'));
    };
  });
}

async function idbGetAllEntries(): Promise<VaultEntry[]> {
  if (!hasIndexedDb()) {
    return Array.from(memoryVault.values());
  }
  const db = await openVaultDb();
  return new Promise<VaultEntry[]>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result as VaultEntry[] | undefined) ?? []);
    };
    req.onerror = () => {
      db.close();
      reject(req.error ?? new Error('IndexedDB list failed.'));
    };
  });
}

async function idbDeleteEntry(id: string): Promise<void> {
  memoryVault.delete(id);
  if (!hasIndexedDb()) return;
  const db = await openVaultDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('IndexedDB delete failed.'));
    };
  });
}

const memoryDeletedSamples = new Set<string>();

function getDeletedSampleIds(): Set<string> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return new Set(memoryDeletedSamples);
    }
    const raw = window.localStorage.getItem(DELETED_SAMPLES_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set(memoryDeletedSamples);
  }
}

function markSampleDeleted(id: string, deleted: boolean): void {
  if (deleted) memoryDeletedSamples.add(id);
  else memoryDeletedSamples.delete(id);
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const set = getDeletedSampleIds();
    if (deleted) set.add(id);
    else set.delete(id);
    window.localStorage.setItem(DELETED_SAMPLES_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Ignore storage unavailability in headless environments
  }
}

export function inspectTelemetryText(
  rawText: string,
  kind: TelemetryKind,
  unit: RainUnit | FlowUnit
): Omit<
  StoredTelemetryDataset,
  'id' | 'name' | 'fileName' | 'storagePath' | 'createdAt' | 'source'
> {
  const series = parseTelemetryText(rawText, kind);
  const n = series.timestampsMs.length;
  const startMs = series.timestampsMs[0];
  const endMs = series.timestampsMs[n - 1];
  const intervalMin = series.medianStepMin;
  const sizeBytes = new TextEncoder().encode(rawText).byteLength;

  let peakValue = 0;
  for (let i = 0; i < series.values.length; i++) {
    if (series.values[i] > peakValue) peakValue = series.values[i];
  }

  let summaryStat = 0;
  if (kind === 'rain') {
    const rainUnit = unit as RainUnit;
    const inHr = convertRainToInHr(series.values, rainUnit, intervalMin);
    const dtHr = Math.max(intervalMin / 60, 1 / 60);
    let totalIn = 0;
    for (let i = 0; i < inHr.length; i++) {
      totalIn += inHr[i] * dtHr;
    }
    summaryStat = Math.round(totalIn * 1000) / 1000;
  } else {
    const flowUnit = unit as FlowUnit;
    const factor = FLOW_TO_MGD[flowUnit] ?? 1.0;
    let sumMgd = 0;
    for (let i = 0; i < series.values.length; i++) {
      sumMgd += Math.max(0, series.values[i]) * factor;
    }
    summaryStat = Math.round((sumMgd / Math.max(1, series.values.length)) * 10000) / 10000;
  }

  return {
    kind,
    unit,
    sizeBytes,
    recordCount: n,
    intervalMin: Math.round(intervalMin * 100) / 100,
    startMs,
    endMs,
    startIso: formatWallClockIso(startMs),
    endIso: formatWallClockIso(endMs),
    peakValue: Math.round(peakValue * 10000) / 10000,
    summaryStat,
  };
}

export async function ensureSampleDatasetsSeeded(
  sampleFlowText: string,
  sampleRainText: string,
  forceRestore = false
): Promise<{ rainId: string; flowId: string }> {
  if (forceRestore) {
    markSampleDeleted(SAMPLE_RAIN_ID, false);
    markSampleDeleted(SAMPLE_FLOW_ID, false);
  }
  const deleted = getDeletedSampleIds();

  if (!deleted.has(SAMPLE_RAIN_ID)) {
    const existingRain = await idbGetEntry(SAMPLE_RAIN_ID);
    if (!existingRain && sampleRainText.trim()) {
      const stats = inspectTelemetryText(sampleRainText, 'rain', 'in/hr');
      const meta: StoredTelemetryDataset = {
        ...stats,
        id: SAMPLE_RAIN_ID,
        name: 'Sample Rain Gauge (Rainfall.txt)',
        fileName: 'Rainfall.txt',
        storagePath: 'sample://Rainfall.txt',
        createdAt: '2021-12-08T00:00:00.000Z',
        source: 'built-in-sample',
      };
      await idbPutEntry({ id: SAMPLE_RAIN_ID, meta, rawText: sampleRainText });
    }
  }

  if (!deleted.has(SAMPLE_FLOW_ID)) {
    const existingFlow = await idbGetEntry(SAMPLE_FLOW_ID);
    if (!existingFlow && sampleFlowText.trim()) {
      const stats = inspectTelemetryText(sampleFlowText, 'flow', 'MGD');
      const meta: StoredTelemetryDataset = {
        ...stats,
        id: SAMPLE_FLOW_ID,
        name: 'TFM02 Trunk Sewer Meter (TFM02.txt)',
        fileName: 'TFM02.txt',
        storagePath: 'sample://TFM02.txt',
        createdAt: '2021-12-08T00:00:00.000Z',
        source: 'built-in-sample',
      };
      await idbPutEntry({ id: SAMPLE_FLOW_ID, meta, rawText: sampleFlowText });
    }
  }

  return { rainId: SAMPLE_RAIN_ID, flowId: SAMPLE_FLOW_ID };
}

export async function listTelemetryDatasets(): Promise<StoredTelemetryDataset[]> {
  const localEntries = await idbGetAllEntries();
  const byId = new Map<string, StoredTelemetryDataset>();
  const byPath = new Map<string, string>();

  for (const entry of localEntries) {
    byId.set(entry.id, entry.meta);
    if (entry.meta.storagePath) {
      byPath.set(entry.meta.storagePath, entry.id);
    }
  }

  const client = getAmplifyDataClient();
  if (client && isAmplifyConfigured) {
    try {
      const { data } = await client.models.TelemetryDataset.list();
      for (const item of data) {
        const cloudMeta: StoredTelemetryDataset = {
          id: item.id,
          name: item.name,
          kind: (item.kind === 'flow' ? 'flow' : 'rain') as TelemetryKind,
          fileName: item.fileName,
          unit: item.unit as RainUnit | FlowUnit,
          storagePath: item.storagePath,
          sizeBytes: item.sizeBytes,
          recordCount: item.recordCount,
          intervalMin: item.intervalMin,
          startMs: item.startMs,
          endMs: item.endMs,
          startIso: item.startIso,
          endIso: item.endIso,
          peakValue: item.peakValue ?? 0,
          summaryStat: item.summaryStat ?? 0,
          createdAt: item.createdAt ?? new Date().toISOString(),
          source: 'amplify-s3',
        };
        const dupLocalId = byPath.get(item.storagePath);
        if (dupLocalId && dupLocalId !== item.id) {
          byId.delete(dupLocalId);
        }
        byId.set(item.id, cloudMeta);
      }
    } catch (err) {
      console.warn('Cloud TelemetryDataset list fallback to local storage:', err);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.source === 'built-in-sample' && b.source !== 'built-in-sample') return 1;
    if (a.source !== 'built-in-sample' && b.source === 'built-in-sample') return -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export async function uploadTelemetryDataset(params: {
  rawText: string;
  fileName: string;
  customName?: string;
  kind: TelemetryKind;
  unit: RainUnit | FlowUnit;
}): Promise<StoredTelemetryDataset> {
  const { rawText, fileName, customName, kind, unit } = params;
  const stats = inspectTelemetryText(rawText, kind, unit);
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const baseLabel =
    customName?.trim() || fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || fileName;
  const safeFile = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

  const client = getAmplifyDataClient();
  if (client && isAmplifyConfigured) {
    const s3Path = `telemetry/${kind}/${stamp}_${rand}_${safeFile}`;
    await uploadData({
      path: s3Path,
      data: rawText,
      options: { contentType: 'text/plain;charset=utf-8' },
    }).result;

    const created = await client.models.TelemetryDataset.create({
      name: baseLabel,
      kind,
      fileName,
      unit,
      storagePath: s3Path,
      sizeBytes: stats.sizeBytes,
      recordCount: stats.recordCount,
      intervalMin: stats.intervalMin,
      startMs: stats.startMs,
      endMs: stats.endMs,
      startIso: stats.startIso,
      endIso: stats.endIso,
      peakValue: stats.peakValue,
      summaryStat: stats.summaryStat,
    });

    if (created.errors && created.errors.length > 0) {
      throw new Error(created.errors.map((e) => e.message).join('; '));
    }
    if (!created.data) {
      throw new Error('Failed to create TelemetryDataset metadata record in AWS Amplify.');
    }

    const cloudDataset: StoredTelemetryDataset = {
      ...stats,
      id: created.data.id,
      name: created.data.name,
      fileName: created.data.fileName,
      storagePath: created.data.storagePath,
      createdAt: created.data.createdAt ?? new Date().toISOString(),
      source: 'amplify-s3',
    };
    await idbPutEntry({ id: cloudDataset.id, meta: cloudDataset, rawText });
    return cloudDataset;
  }

  const localId = `local-${kind}-${stamp}-${rand}`;
  const localDataset: StoredTelemetryDataset = {
    ...stats,
    id: localId,
    name: baseLabel,
    fileName,
    storagePath: `local://${kind}/${safeFile}`,
    createdAt: new Date().toISOString(),
    source: 'local-storage',
  };
  await idbPutEntry({ id: localId, meta: localDataset, rawText });
  return localDataset;
}

export async function loadTelemetryDatasetText(dataset: StoredTelemetryDataset): Promise<string> {
  const cached = await idbGetEntry(dataset.id);
  if (cached?.rawText) {
    return cached.rawText;
  }

  if (dataset.storagePath.startsWith('sample://')) {
    const sampleFile = dataset.storagePath.replace('sample://', '');
    const res = await fetch(`/sample-data/${sampleFile}`);
    if (!res.ok) {
      throw new Error(`Sample file ${sampleFile} could not be loaded.`);
    }
    const text = await res.text();
    await idbPutEntry({ id: dataset.id, meta: dataset, rawText: text });
    return text;
  }

  if (dataset.source === 'amplify-s3' && isAmplifyConfigured) {
    const dl = await downloadData({ path: dataset.storagePath }).result;
    const text = await dl.body.text();
    await idbPutEntry({ id: dataset.id, meta: dataset, rawText: text });
    return text;
  }

  throw new Error(`Raw telemetry content for "${dataset.name}" was not found in storage.`);
}

export async function updateTelemetryDatasetUnit(
  dataset: StoredTelemetryDataset,
  nextUnit: RainUnit | FlowUnit
): Promise<StoredTelemetryDataset> {
  const rawText = await loadTelemetryDatasetText(dataset);
  const recomputed = inspectTelemetryText(rawText, dataset.kind, nextUnit);
  const updated: StoredTelemetryDataset = {
    ...dataset,
    ...recomputed,
    unit: nextUnit,
  };

  const client = getAmplifyDataClient();
  if (dataset.source === 'amplify-s3' && client && isAmplifyConfigured) {
    await client.models.TelemetryDataset.update({
      id: dataset.id,
      unit: nextUnit,
      peakValue: updated.peakValue,
      summaryStat: updated.summaryStat,
    });
  }

  await idbPutEntry({ id: updated.id, meta: updated, rawText });
  return updated;
}

export async function deleteTelemetryDataset(dataset: StoredTelemetryDataset): Promise<void> {
  if (dataset.source === 'built-in-sample') {
    markSampleDeleted(dataset.id, true);
  }
  const client = getAmplifyDataClient();
  if (dataset.source === 'amplify-s3' && client && isAmplifyConfigured) {
    try {
      await remove({ path: dataset.storagePath });
    } catch (err) {
      console.warn('S3 delete warning:', err);
    }
    await client.models.TelemetryDataset.delete({ id: dataset.id });
  }
  await idbDeleteEntry(dataset.id);
}

export function computeDatasetOverlap(
  rain: StoredTelemetryDataset | null,
  flow: StoredTelemetryDataset | null
): {
  hasOverlap: boolean;
  overlapDays: number;
  overlapStartIso: string;
  overlapEndIso: string;
} {
  if (!rain || !flow) {
    return {
      hasOverlap: false,
      overlapDays: 0,
      overlapStartIso: '',
      overlapEndIso: '',
    };
  }
  const startMs = Math.max(rain.startMs, flow.startMs);
  const endMs = Math.min(rain.endMs, flow.endMs);
  if (endMs <= startMs) {
    return {
      hasOverlap: false,
      overlapDays: 0,
      overlapStartIso: '',
      overlapEndIso: '',
    };
  }
  return {
    hasOverlap: true,
    overlapDays: Math.round(((endMs - startMs) / 86_400_000) * 10) / 10,
    overlapStartIso: formatWallClockIso(startMs, false),
    overlapEndIso: formatWallClockIso(endMs, false),
  };
}
