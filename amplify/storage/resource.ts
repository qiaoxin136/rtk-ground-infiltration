import { defineStorage } from '@aws-amplify/backend';
import { rtkGimCalibrator } from '../functions/rtk-gim-calibrator/resource';

export const storage = defineStorage({
  name: 'rtkHydrologyStorage',
  access: (allow) => ({
    'telemetry/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.resource(rtkGimCalibrator).to(['read', 'write', 'delete']),
    ],
    'exports/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.resource(rtkGimCalibrator).to(['read', 'write', 'delete']),
    ],
  }),
});
