import type { Schema } from '../../data/resource';
import { runFullHydrologyPipeline } from '../../../src/engine/hydrology';
import type { AnalysisConfig } from '../../../src/engine/types';

export const handler: Schema['runCloudCalibration']['functionHandler'] = async (event) => {
  const t0 = Date.now();
  try {
    const config: AnalysisConfig = JSON.parse(event.arguments.configJson);
    const full = runFullHydrologyPipeline(
      event.arguments.flowText,
      event.arguments.rainText,
      config
    );

    const summaryPayload = {
      periodStartIso: full.periodStartIso,
      periodEndIso: full.periodEndIso,
      areaAcres: full.areaAcres,
      totalRainDepthIn: full.totalRainDepthIn,
      pump: full.pump,
      dwf: full.dwf,
      events: full.events,
      maxTailHours: full.maxTailHours,
      gim: full.gim,
    };

    return {
      ok: true,
      summaryJson: JSON.stringify(summaryPayload),
      computeMs: Date.now() - t0,
      errorMessage: null,
    };
  } catch (err) {
    return {
      ok: false,
      summaryJson: '{}',
      computeMs: Date.now() - t0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
};
