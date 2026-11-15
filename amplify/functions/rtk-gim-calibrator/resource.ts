import { defineFunction } from '@aws-amplify/backend';

export const rtkGimCalibrator = defineFunction({
  name: 'rtk-gim-calibrator',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 60,
  memoryMB: 2048,
});
