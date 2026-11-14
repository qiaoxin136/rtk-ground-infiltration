import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { rtkGimCalibrator } from './functions/rtk-gim-calibrator/resource';

export const backend = defineBackend({
  auth,
  data,
  storage,
  rtkGimCalibrator,
});
