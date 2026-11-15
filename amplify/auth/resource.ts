import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: {
      verificationEmailStyle: 'CODE',
      verificationEmailSubject: 'RTK & InfoWorks ICM Studio — Verification Code',
      verificationEmailBody: (createCode) =>
        `Your RTK & InfoWorks ICM Ground Infiltration Studio verification code is: ${createCode()}`,
    },
  },
  userAttributes: {
    preferredUsername: {
      mutable: true,
      required: false,
    },
  },
});
