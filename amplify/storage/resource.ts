import { defineStorage } from '@aws-amplify/backend';
import { rtkGimCalibrator } from '../functions/rtk-gim-calibrator/resource';

export const storage = defineStorage({
  name: 'rtkHydrologyStorage',
  access: (allow) => ({
    'telemetry/*': [
      allow.guest.to(['read', 'write', 'delete']),
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.resource(rtkGimCalibrator).to(['read', 'write', 'delete']),
    ],
    'exports/*': [
      allow.guest.to(['read', 'write', 'delete']),
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.resource(rtkGimCalibrator).to(['read', 'write', 'delete']),
    ],
  }),
});
