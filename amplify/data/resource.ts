import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { rtkGimCalibrator } from '../functions/rtk-gim-calibrator/resource';

const schema = a.schema({
  CalibrationProject: a
    .model({
      projectName: a.string().required(),
      areaValue: a.float().required(),
      areaUnit: a.string().required(),
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
    .authorization((allow) => [
      allow.guest(),
      allow.authenticated(),
      allow.publicApiKey(),
    ]),

  CloudCalibrationResponse: a.customType({
    ok: a.boolean().required(),
    summaryJson: a.string().required(),
    computeMs: a.integer(),
    errorMessage: a.string(),
  }),

  runCloudCalibration: a
    .query()
    .arguments({
      flowText: a.string().required(),
      rainText: a.string().required(),
      configJson: a.string().required(),
    })
    .returns(a.ref('CloudCalibrationResponse'))
    .authorization((allow) => [
      allow.guest(),
      allow.authenticated(),
      allow.publicApiKey(),
    ])
    .handler(a.handler.function(rtkGimCalibrator)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'apiKey',
    apiKeyAuthorizationMode: {
      expiresInDays: 30,
    },
  },
});
