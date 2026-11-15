import zlib from 'node:zlib';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Schema } from '../../data/resource';
import { runFullHydrologyPipeline } from '../../../src/engine/hydrology';
import type { AnalysisConfig, FullAnalysisResult } from '../../../src/engine/types';

const s3 = new S3Client({});
const MAX_INLINE_RESPONSE_B64 = 3_500_000; // Well under AppSync 5 MB & Lambda 6 MB limits

function roundArray5(arr: number[]): number[] {
  const out = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = Math.round(arr[i] * 100000) / 100000;
  }
  return out;
}

function compactFullResult(res: FullAnalysisResult): FullAnalysisResult {
  const s = res.series15m;
  return {
    ...res,
    series15m: {
      timestampsMs: s.timestampsMs,
      rainInHr: roundArray5(s.rainInHr),
      rainDepthIn: roundArray5(s.rainDepthIn),
      flowObservedSmoothMgd: roundArray5(s.flowObservedSmoothMgd),
      flowRawInterpMgd: roundArray5(s.flowRawInterpMgd),
      dwfBaselineMgd: roundArray5(s.dwfBaselineMgd),
      modeledTotalMgd: roundArray5(s.modeledTotalMgd),
      rtkFastMedMgd: roundArray5(s.rtkFastMedMgd),
      gimGroundwaterMgd: roundArray5(s.gimGroundwaterMgd),
      pureLinearRtkTotalMgd: roundArray5(s.pureLinearRtkTotalMgd),
      soilStorageIn: roundArray5(s.soilStorageIn),
      gwStorageIn: roundArray5(s.gwStorageIn),
    },
    highResFlow: {
      timestampsMs: res.highResFlow.timestampsMs,
      rawMgd: roundArray5(res.highResFlow.rawMgd),
      smoothedMgd: roundArray5(res.highResFlow.smoothedMgd),
    },
  };
}

export const handler: Schema['runCloudCalibration']['functionHandler'] = async (event) => {
  const t0 = Date.now();
  try {
    const rawConfig = JSON.parse(event.arguments.configJson) as Partial<AnalysisConfig>;
    const config: AnalysisConfig = {
      projectName: rawConfig.projectName ?? 'Basin Calibration',
      flowUnit: rawConfig.flowUnit ?? 'MGD',
      rainUnit: rawConfig.rainUnit ?? 'in/hr',
      areaValue: rawConfig.areaValue ?? 268,
      areaUnit: rawConfig.areaUnit ?? 'acres',
      smoothWindowMinOverride: rawConfig.smoothWindowMinOverride ?? null,
      enablePumpSmoothing: rawConfig.enablePumpSmoothing ?? true,
      interEventGapHours: rawConfig.interEventGapHours ?? 6,
      minEventDepthIn: rawConfig.minEventDepthIn ?? 0.1,
      longTailThresholdHours: rawConfig.longTailThresholdHours ?? 48,
      enableCoupledGim: rawConfig.enableCoupledGim ?? 'auto',
      optimizerIterations: rawConfig.optimizerIterations ?? 65,
    };
    const bucketName = process.env.RTK_HYDROLOGY_STORAGE_BUCKET_NAME;

    let flowText = event.arguments.flowText ?? '';
    let rainText = event.arguments.rainText ?? '';

    if (event.arguments.payloadGzipBase64) {
      const gzBuf = Buffer.from(event.arguments.payloadGzipBase64, 'base64');
      const rawJson = zlib.gunzipSync(gzBuf).toString('utf8');
      const parsed = JSON.parse(rawJson) as { flowText: string; rainText: string };
      flowText = parsed.flowText;
      rainText = parsed.rainText;
    } else if (event.arguments.s3InputPath) {
      if (!bucketName) {
        throw new Error('S3 bucket environment variable RTK_HYDROLOGY_STORAGE_BUCKET_NAME is not configured.');
      }
      const s3Obj = await s3.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: event.arguments.s3InputPath,
        })
      );
      const bytes = await s3Obj.Body?.transformToByteArray();
      if (!bytes) {
        throw new Error(`Empty S3 object at ${event.arguments.s3InputPath}`);
      }
      const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
      const jsonStr = isGzip
        ? zlib.gunzipSync(Buffer.from(bytes)).toString('utf8')
        : Buffer.from(bytes).toString('utf8');
      const parsed = JSON.parse(jsonStr) as { flowText: string; rainText: string };
      flowText = parsed.flowText;
      rainText = parsed.rainText;
    }

    if (!flowText.trim() || !rainText.trim()) {
      throw new Error('Both rainfall and sewer flow telemetry text are required.');
    }

    const full = compactFullResult(runFullHydrologyPipeline(flowText, rainText, config));
    const fullJson = JSON.stringify(full);
    const gzOut = zlib.gzipSync(Buffer.from(fullJson, 'utf8'), { level: 6 });
    const gzBase64 = gzOut.toString('base64');

    const summaryPayload = {
      periodStartIso: full.periodStartIso,
      periodEndIso: full.periodEndIso,
      areaAcres: full.areaAcres,
      totalRainDepthIn: full.totalRainDepthIn,
      dwfWeightedMgd: full.dwf.weightedMeanMgd,
      eventCount: full.events.length,
      maxTailHours: full.maxTailHours,
      nseDaily: full.gim.metrics.nseDaily,
    };

    if (gzBase64.length <= MAX_INLINE_RESPONSE_B64 || !bucketName) {
      return {
        ok: true,
        resultGzipBase64: gzBase64,
        s3OutputPath: null,
        summaryJson: JSON.stringify(summaryPayload),
        computeMs: Date.now() - t0,
        errorMessage: null,
      };
    }

    const s3OutKey = `exports/jobs/result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json.gz`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: s3OutKey,
        Body: gzOut,
        ContentType: 'application/gzip',
      })
    );

    return {
      ok: true,
      resultGzipBase64: null,
      s3OutputPath: s3OutKey,
      summaryJson: JSON.stringify(summaryPayload),
      computeMs: Date.now() - t0,
      errorMessage: null,
    };
  } catch (err) {
    return {
      ok: false,
      resultGzipBase64: null,
      s3OutputPath: null,
      summaryJson: '{}',
      computeMs: Date.now() - t0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
};
