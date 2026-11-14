import { runFullHydrologyPipeline } from '../engine/hydrology';
import type { AnalysisConfig, FullAnalysisResult } from '../engine/types';

export interface WorkerRunMessage {
  type: 'RUN_CALIBRATION';
  requestId: number;
  flowText: string;
  rainText: string;
  config: AnalysisConfig;
}

export type WorkerResponseMessage =
  | { type: 'PROGRESS'; requestId: number; pct: number; stage: string }
  | { type: 'RESULT'; requestId: number; result: FullAnalysisResult; durationMs: number }
  | { type: 'ERROR'; requestId: number; message: string };

self.onmessage = (ev: MessageEvent<WorkerRunMessage>) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'RUN_CALIBRATION') return;
  const t0 = performance.now();
  try {
    const result = runFullHydrologyPipeline(
      msg.flowText,
      msg.rainText,
      msg.config,
      (pct, stage) => {
        const progressMsg: WorkerResponseMessage = {
          type: 'PROGRESS',
          requestId: msg.requestId,
          pct,
          stage,
        };
        self.postMessage(progressMsg);
      }
    );
    const doneMsg: WorkerResponseMessage = {
      type: 'RESULT',
      requestId: msg.requestId,
      result,
      durationMs: Math.round(performance.now() - t0),
    };
    self.postMessage(doneMsg);
  } catch (err) {
    const errMsg: WorkerResponseMessage = {
      type: 'ERROR',
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(errMsg);
  }
};
