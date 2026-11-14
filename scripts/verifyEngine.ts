import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFullHydrologyPipeline } from '../src/engine/hydrology';
import type { AnalysisConfig } from '../src/engine/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.resolve(__dirname, '../public/sample-data');

const flowText = fs.readFileSync(path.join(sampleDir, 'TFM02.txt'), 'utf-8');
const rainText = fs.readFileSync(path.join(sampleDir, 'Rainfall.txt'), 'utf-8');

const config: AnalysisConfig = {
  projectName: 'TFM02 Basin Verification',
  flowUnit: 'MGD',
  rainUnit: 'in/hr',
  areaValue: 268,
  areaUnit: 'acres',
  smoothWindowMinOverride: null,
  enablePumpSmoothing: true,
  interEventGapHours: 24,
  minEventDepthIn: 0.10,
  longTailThresholdHours: 48,
  enableCoupledGim: 'auto',
  optimizerIterations: 38,
};

const t0 = Date.now();
const res = runFullHydrologyPipeline(flowText, rainText, config);
const elapsed = Date.now() - t0;

console.log(`Engine completed in ${elapsed} ms`);
console.log(
  `Pump: hasInfluence=${res.pump.hasPumpInfluence}, medianCycle=${res.pump.medianCycleMin} min, window=${res.pump.windowActualMin} min (${res.pump.windowPoints} pts), roughnessReduction=${res.pump.roughnessReductionPct.toFixed(1)}%`
);
console.log(
  `DWF (${res.dwf.cleanDryDayCount} clean days): Weekday=${res.dwf.weekdayMeanMgd.toFixed(4)} MGD, Weekend=${res.dwf.weekendMeanMgd.toFixed(4)} MGD, Weighted=${res.dwf.weightedMeanMgd.toFixed(4)} MGD`
);
console.log(
  `Rain Total: ${res.totalRainDepthIn} in | Events: ${res.events.length} | Max Tail: ${res.maxTailHours} hr`
);
console.log(
  `Coupled ICM GIM: enabled=${res.gim.enabled}, NSE_daily=${res.gim.metrics.nseDaily}, NSE_15m=${res.gim.metrics.nse15m}, RMSE_daily=${res.gim.metrics.rmseDailyMgd} MGD, VolErr=${res.gim.metrics.volumeErrorPct}%`
);

if (!res.pump.hasPumpInfluence || res.pump.windowActualMin !== 35) {
  throw new Error(`Unexpected pump detection: ${JSON.stringify(res.pump)}`);
}
if (res.dwf.weightedMeanMgd < 1.02 || res.dwf.weightedMeanMgd > 1.15) {
  throw new Error(`Unexpected weighted DWF: ${res.dwf.weightedMeanMgd}`);
}
if (res.events.length < 10) {
  throw new Error(`Expected >= 10 storm events, got ${res.events.length}`);
}
if (!res.gim.enabled || res.gim.metrics.nseDaily < 0.78) {
  throw new Error(`Expected coupled GIM NSE_daily >= 0.78, got ${res.gim.metrics.nseDaily}`);
}
console.log('ALL HYDROLOGY ENGINE VERIFICATION CHECKS PASSED!');
