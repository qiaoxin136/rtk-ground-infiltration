import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { uploadData, downloadData } from 'aws-amplify/storage';
import type { Schema } from '../../amplify/data/resource';
import type { AnalysisConfig, FullAnalysisResult } from '../engine/types';

// Dynamically detect amplify_outputs.json (present after `npx ampx sandbox` or AWS Amplify pipeline-deploy)
const globOutputs = import.meta.glob('../../amplify_outputs.json', {
  eager: true,
}) as Record<string, { default?: Record<string, unknown> }>;

const rawOutputs = Object.values(globOutputs)[0]?.default ?? Object.values(globOutputs)[0];
export const isAmplifyConfigured = Boolean(rawOutputs && Object.keys(rawOutputs).length > 0);

if (isAmplifyConfigured && rawOutputs) {
  try {
    Amplify.configure(rawOutputs as Parameters<typeof Amplify.configure>[0]);
  } catch (err) {
    console.warn('Amplify configuration warning:', err);
  }
}

let cachedClient: ReturnType<typeof generateClient<Schema>> | null = null;
function getClient() {
  if (!isAmplifyConfigured) return null;
  if (!cachedClient) {
    cachedClient = generateClient<Schema>();
  }
  return cachedClient;
}

export interface SavedBasinRecord {
  id: string;
  projectName: string;
  createdAt: string;
  areaValue: number;
  areaUnit: string;
  flowUnit: string;
  rainUnit: string;
  flowFileName: string;
  rainFileName: string;
  flowStoragePath?: string | null;
  rainStoragePath?: string | null;
  weightedDwfMgd: number;
  eventCount: number;
  maxTailHours: number;
  nseDaily: number;
  nse15m: number;
  volumeErrorPct: number;
  source: 'amplify-cloud' | 'local-cache';
}

const LOCAL_STORAGE_KEY = 'rtk_gim_saved_projects_v1';

export async function listSavedProjects(): Promise<SavedBasinRecord[]> {
  const client = getClient();
  if (client) {
    try {
      const { data } = await client.models.CalibrationProject.list();
      return data
        .map((item) => ({
          id: item.id,
          projectName: item.projectName,
          createdAt: item.createdAt ?? new Date().toISOString(),
          areaValue: item.areaValue,
          areaUnit: item.areaUnit,
          flowUnit: item.flowUnit,
          rainUnit: item.rainUnit,
          flowFileName: item.flowFileName ?? 'flow.txt',
          rainFileName: item.rainFileName ?? 'rain.txt',
          flowStoragePath: item.flowStoragePath,
          rainStoragePath: item.rainStoragePath,
          weightedDwfMgd: item.weightedDwfMgd ?? 0,
          eventCount: item.eventCount ?? 0,
          maxTailHours: item.maxTailHours ?? 0,
          nseDaily: item.nseDaily ?? 0,
          nse15m: item.nse15m ?? 0,
          volumeErrorPct: item.volumeErrorPct ?? 0,
          source: 'amplify-cloud' as const,
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (err) {
      console.warn('Cloud list fallback to local cache:', err);
    }
  }

  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedBasinRecord[]) : [];
  } catch {
    return [];
  }
}

export async function saveCalibrationRecord(
  result: FullAnalysisResult,
  flowFileName: string,
  rainFileName: string,
  flowRawText: string,
  rainRawText: string
): Promise<SavedBasinRecord> {
  const client = getClient();
  const stamp = Date.now();

  if (client) {
    let flowPath = `telemetry/${stamp}_${flowFileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    let rainPath = `telemetry/${stamp}_${rainFileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    try {
      await Promise.all([
        uploadData({
          path: flowPath,
          data: flowRawText,
          options: { contentType: 'text/plain' },
        }).result,
        uploadData({
          path: rainPath,
          data: rainRawText,
          options: { contentType: 'text/plain' },
        }).result,
      ]);
    } catch (storageErr) {
      console.warn('S3 telemetry upload skipped:', storageErr);
      flowPath = '';
      rainPath = '';
    }

    const created = await client.models.CalibrationProject.create({
      projectName: result.config.projectName,
      areaValue: result.config.areaValue,
      areaUnit: result.config.areaUnit,
      flowUnit: result.config.flowUnit,
      rainUnit: result.config.rainUnit,
      flowFileName,
      rainFileName,
      flowStoragePath: flowPath || undefined,
      rainStoragePath: rainPath || undefined,
      weightedDwfMgd: result.dwf.weightedMeanMgd,
      eventCount: result.events.length,
      maxTailHours: result.maxTailHours,
      nseDaily: result.gim.metrics.nseDaily,
      nse15m: result.gim.metrics.nse15m,
      volumeErrorPct: result.gim.metrics.volumeErrorPct,
      eventsJson: JSON.stringify(result.events),
      icmParametersJson: JSON.stringify(result.gim.icmRows),
      diurnalJson: JSON.stringify(result.dwf.diurnal),
    });

    if (created.data) {
      return {
        id: created.data.id,
        projectName: created.data.projectName,
        createdAt: created.data.createdAt ?? new Date().toISOString(),
        areaValue: created.data.areaValue,
        areaUnit: created.data.areaUnit,
        flowUnit: created.data.flowUnit,
        rainUnit: created.data.rainUnit,
        flowFileName,
        rainFileName,
        flowStoragePath: created.data.flowStoragePath,
        rainStoragePath: created.data.rainStoragePath,
        weightedDwfMgd: result.dwf.weightedMeanMgd,
        eventCount: result.events.length,
        maxTailHours: result.maxTailHours,
        nseDaily: result.gim.metrics.nseDaily,
        nse15m: result.gim.metrics.nse15m,
        volumeErrorPct: result.gim.metrics.volumeErrorPct,
        source: 'amplify-cloud',
      };
    }
  }

  // Fallback local persistence when running before `npx ampx sandbox`
  const record: SavedBasinRecord = {
    id: `local-${stamp}`,
    projectName: result.config.projectName,
    createdAt: new Date().toISOString(),
    areaValue: result.config.areaValue,
    areaUnit: result.config.areaUnit,
    flowUnit: result.config.flowUnit,
    rainUnit: result.config.rainUnit,
    flowFileName,
    rainFileName,
    weightedDwfMgd: result.dwf.weightedMeanMgd,
    eventCount: result.events.length,
    maxTailHours: result.maxTailHours,
    nseDaily: result.gim.metrics.nseDaily,
    nse15m: result.gim.metrics.nse15m,
    volumeErrorPct: result.gim.metrics.volumeErrorPct,
    source: 'local-cache',
  };

  const existing = await listSavedProjects();
  const updated = [record, ...existing.filter((r) => r.source === 'local-cache')].slice(0, 20);
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updated));
  return record;
}

export async function loadCloudTelemetryFiles(
  record: SavedBasinRecord
): Promise<{ flowText: string; rainText: string } | null> {
  if (!isAmplifyConfigured || !record.flowStoragePath || !record.rainStoragePath) {
    return null;
  }
  const [flowRes, rainRes] = await Promise.all([
    downloadData({ path: record.flowStoragePath }).result,
    downloadData({ path: record.rainStoragePath }).result,
  ]);
  const [flowText, rainText] = await Promise.all([flowRes.body.text(), rainRes.body.text()]);
  return { flowText, rainText };
}

const INLINE_GZIP_LIMIT_B64 = 620_000; // Safely below AppSync 1 MB HTTP payload limit

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    parts.push(String.fromCharCode(...sub));
  }
  return btoa(parts.join(''));
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function gzipStringToBytes(text: string): Promise<Uint8Array> {
  const rawBytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') {
    throw new Error('Browser CompressionStream API is unavailable.');
  }
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(rawBytes);
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
}

export async function gunzipBytesToString(gzBytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser DecompressionStream API is unavailable.');
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(gzBytes as unknown as BufferSource);
  writer.close();
  const ab = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(ab);
}

export async function invokeLambdaFullCalibration(
  flowText: string,
  rainText: string,
  config: AnalysisConfig,
  onProgress?: (pct: number, stage: string) => void
): Promise<{
  result: FullAnalysisResult;
  computeMs: number;
  transport: 'inline-gzip' | 's3-gzip';
}> {
  const client = getClient();
  if (!client) {
    throw new Error(
      'AWS Amplify backend is not connected (`amplify_outputs.json` missing). Deploy via AWS Amplify Hosting or run `npx ampx sandbox`.'
    );
  }

  onProgress?.(12, 'Compressing rainfall & sewer flow telemetry for AWS Lambda...');
  const inputJson = JSON.stringify({ flowText, rainText });
  const gzInputBytes = await gzipStringToBytes(inputJson);
  const gzInputB64 = uint8ToBase64(gzInputBytes);

  let transport: 'inline-gzip' | 's3-gzip' = 'inline-gzip';
  let payloadGzipBase64: string | undefined = gzInputB64;
  let s3InputPath: string | undefined;

  if (gzInputB64.length > INLINE_GZIP_LIMIT_B64) {
    transport = 's3-gzip';
    s3InputPath = `telemetry/jobs/input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json.gz`;
    payloadGzipBase64 = undefined;
    onProgress?.(24, 'Uploading large compressed telemetry to AWS S3...');
    await uploadData({
      path: s3InputPath,
      data: gzInputBytes,
      options: { contentType: 'application/gzip' },
    }).result;
  }

  onProgress?.(45, 'Executing RTK + InfoWorks ICM 2-Store GIM on AWS Lambda...');
  const res = await client.queries.runCloudCalibration({
    configJson: JSON.stringify(config),
    payloadGzipBase64,
    s3InputPath,
  });

  if (res.errors && res.errors.length > 0) {
    throw new Error(res.errors.map((e) => e.message).join('; '));
  }
  if (!res.data || !res.data.ok) {
    throw new Error(res.data?.errorMessage ?? 'AWS Lambda calibration failed.');
  }

  onProgress?.(86, 'Decompressing calibrated hydrographs from AWS Lambda...');
  let outGzBytes: Uint8Array;
  if (res.data.resultGzipBase64) {
    outGzBytes = base64ToUint8(res.data.resultGzipBase64);
  } else if (res.data.s3OutputPath) {
    transport = 's3-gzip';
    const dl = await downloadData({ path: res.data.s3OutputPath }).result;
    const blob = await dl.body.blob();
    const ab = await blob.arrayBuffer();
    outGzBytes = new Uint8Array(ab);
  } else {
    throw new Error('AWS Lambda returned an empty calibration payload.');
  }

  const outJson = await gunzipBytesToString(outGzBytes);
  const fullResult = JSON.parse(outJson) as FullAnalysisResult;

  return {
    result: fullResult,
    computeMs: res.data.computeMs ?? 0,
    transport,
  };
}
