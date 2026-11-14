import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'rtkHydrologyStorage',
  access: (allow) => ({
    'telemetry/*': [
      allow.guest.to(['read', 'write', 'delete']),
      allow.authenticated.to(['read', 'write', 'delete']),
    ],
    'exports/*': [
      allow.guest.to(['read', 'write', 'delete']),
      allow.authenticated.to(['read', 'write', 'delete']),
    ],
  }),
});
