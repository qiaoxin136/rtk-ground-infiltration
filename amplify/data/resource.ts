import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { rtkGimCalibrator } from '../functions/rtk-gim-calibrator/resource';

const schema = a.schema({
  TelemetryDataset: a
    .model({
      name: a.string().required(),
      kind: a.string().required(),
      fileName: a.string().required(),
      unit: a.string().required(),
      storagePath: a.string().required(),
      sizeBytes: a.integer().required(),
      recordCount: a.integer().required(),
      intervalMin: a.float().required(),
      startMs: a.float().required(),
      endMs: a.float().required(),
      startIso: a.string().required(),
      endIso: a.string().required(),
      peakValue: a.float(),
      summaryStat: a.float(),
    })
    .authorization((allow) => [allow.authenticated()]),

  CalibrationProject: a
    .model({
      projectName: a.string().required(),
      areaValue: a.float().required(),
      areaUnit: a.string().required(),
      baselineFlowMgd: a.float(),
      flowUnit: a.string().required(),
      rainUnit: a.string().required(),
      flowFileName: a.string(),
      rainFileName: a.string(),
      flowStoragePath: a.string(),
      rainStoragePath: a.string(),
      weightedDwfMgd: a.float(),
      eventCount: a.integer(),
      maxTailHours: a.float(),
      nseDaily: a.float(),
      nse15m: a.float(),
      volumeErrorPct: a.float(),
      eventsJson: a.string(),
      icmParametersJson: a.string(),
      diurnalJson: a.string(),
    })
    .authorization((allow) => [allow.authenticated()]),

  CloudCalibrationResponse: a.customType({
    ok: a.boolean().required(),
    resultGzipBase64: a.string(),
    s3OutputPath: a.string(),
    summaryJson: a.string(),
    computeMs: a.integer(),
    errorMessage: a.string(),
  }),

  runCloudCalibration: a
    .query()
    .arguments({
      configJson: a.string().required(),
      payloadGzipBase64: a.string(),
      s3InputPath: a.string(),
      flowStoragePath: a.string(),
      rainStoragePath: a.string(),
      flowText: a.string(),
      rainText: a.string(),
    })
    .returns(a.ref('CloudCalibrationResponse'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(rtkGimCalibrator)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
