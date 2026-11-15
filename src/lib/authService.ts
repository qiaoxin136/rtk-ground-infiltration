import {
  confirmResetPassword,
  confirmSignIn,
  confirmSignUp,
  fetchUserAttributes,
  getCurrentUser,
  resendSignUpCode,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from 'aws-amplify/auth';
import { isAmplifyConfigured } from './amplifyCloud';

export interface AuthSessionUser {
  userId: string;
  email: string;
  displayName: string;
  provider: 'cognito' | 'local-preview';
}

export type SignInFlowResult =
  | { status: 'SIGNED_IN'; user: AuthSessionUser }
  | { status: 'CONFIRM_SIGN_UP'; email: string }
  | { status: 'NEW_PASSWORD_REQUIRED'; email: string };

interface LocalUserAccount {
  userId: string;
  email: string;
  displayName: string;
  passwordHash: string;
}

const LOCAL_USERS_KEY = 'rtk_gim_local_accounts_v1';
const LOCAL_SESSION_KEY = 'rtk_gim_local_session_v1';

function hashLocalSecret(raw: string): string {
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function readLocalAccounts(): LocalUserAccount[] {
  try {
    const raw = localStorage.getItem(LOCAL_USERS_KEY);
    return raw ? (JSON.parse(raw) as LocalUserAccount[]) : [];
  } catch {
    return [];
  }
}

function writeLocalAccounts(accounts: LocalUserAccount[]): void {
  try {
    localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(accounts));
  } catch {
    // Ignore storage quota errors in restricted frames
  }
}

function deriveNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'Engineer';
  return local
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatAuthError(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as { name?: string }).name);
    const msg = 'message' in err ? String((err as { message?: string }).message) : '';
    if (name === 'NotAuthorizedException') {
      return 'Incorrect email or password. Check your credentials and try again.';
    }
    if (name === 'UserNotFoundException') {
      return 'No account found for that email address. Create an account first.';
    }
    if (name === 'UsernameExistsException') {
      return 'An account with this email already exists. Sign in instead.';
    }
    if (name === 'CodeMismatchException') {
      return 'Verification code does not match. Check the 6-digit code sent to your email.';
    }
    if (name === 'ExpiredCodeException') {
      return 'Verification code expired. Request a fresh code below.';
    }
    if (name === 'InvalidPasswordException') {
      return 'Password must be at least 8 characters and include uppercase, lowercase, number, and symbol.';
    }
    if (name === 'LimitExceededException') {
      return 'Too many attempts. Wait a moment before requesting another code.';
    }
    if (msg) return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

async function buildCognitoSessionUser(emailFallback?: string): Promise<AuthSessionUser> {
  const current = await getCurrentUser();
  let email = emailFallback ?? current.signInDetails?.loginId ?? current.username;
  let displayName = '';

  try {
    const attrs = await fetchUserAttributes();
    if (attrs.email) email = attrs.email;
    if (attrs.preferred_username) displayName = attrs.preferred_username;
  } catch {
    // Attributes fetch is optional if token already resolved loginId
  }

  if (!displayName) {
    displayName = deriveNameFromEmail(email);
  }

  return {
    userId: current.userId,
    email,
    displayName,
    provider: 'cognito',
  };
}

export async function getActiveAuthUser(): Promise<AuthSessionUser | null> {
  if (isAmplifyConfigured) {
    try {
      return await buildCognitoSessionUser();
    } catch {
      return null;
    }
  }

  try {
    const raw = sessionStorage.getItem(LOCAL_SESSION_KEY);
    return raw ? (JSON.parse(raw) as AuthSessionUser) : null;
  } catch {
    return null;
  }
}

export async function signInWithEmail(
  rawEmail: string,
  password: string
): Promise<SignInFlowResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !password) {
    throw new Error('Enter both your email address and password.');
  }

  if (isAmplifyConfigured) {
    // Ensure any stale partial session is cleared if signing in fresh
    try {
      await getCurrentUser();
      await signOut();
    } catch {
      // Not signed in
    }

    const out = await signIn({
      username: email,
      password,
    });

    if (out.isSignedIn || out.nextStep.signInStep === 'DONE') {
      const user = await buildCognitoSessionUser(email);
      return { status: 'SIGNED_IN', user };
    }

    if (out.nextStep.signInStep === 'CONFIRM_SIGN_UP') {
      return { status: 'CONFIRM_SIGN_UP', email };
    }

    if (out.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      return { status: 'NEW_PASSWORD_REQUIRED', email };
    }

    throw new Error(`Additional authentication step required: ${out.nextStep.signInStep}`);
  }

  // Local preview mode (when amplify_outputs.json is not present locally)
  const accounts = readLocalAccounts();
  const found = accounts.find((a) => a.email === email);
  if (!found) {
    throw new Error('No local preview account found for this email. Switch to Create account or use Demo Access.');
  }
  if (found.passwordHash !== hashLocalSecret(password)) {
    throw new Error('Incorrect password for this local preview account.');
  }

  const sessionUser: AuthSessionUser = {
    userId: found.userId,
    email: found.email,
    displayName: found.displayName,
    provider: 'local-preview',
  };
  sessionStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(sessionUser));
  return { status: 'SIGNED_IN', user: sessionUser };
}

export async function completeNewPasswordChallenge(
  newPassword: string,
  emailHint: string
): Promise<AuthSessionUser> {
  const out = await confirmSignIn({
    challengeResponse: newPassword,
  });
  if (!out.isSignedIn) {
    throw new Error(`Additional step required: ${out.nextStep.signInStep}`);
  }
  return buildCognitoSessionUser(emailHint);
}

export async function signUpWithEmail(
  rawEmail: string,
  password: string,
  rawDisplayName: string
): Promise<{ status: 'CONFIRM_SIGN_UP' | 'SIGNED_IN'; user?: AuthSessionUser }> {
  const email = rawEmail.trim().toLowerCase();
  const displayName = rawDisplayName.trim() || deriveNameFromEmail(email);

  if (!email.includes('@')) {
    throw new Error('Enter a valid work or personal email address.');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  if (isAmplifyConfigured) {
    const out = await signUp({
      username: email,
      password,
      options: {
        userAttributes: {
          email,
          preferred_username: displayName,
        },
      },
    });

    if (out.isSignUpComplete && out.nextStep.signUpStep === 'DONE') {
      const loginRes = await signInWithEmail(email, password);
      if (loginRes.status === 'SIGNED_IN') {
        return { status: 'SIGNED_IN', user: loginRes.user };
      }
    }

    return { status: 'CONFIRM_SIGN_UP' };
  }

  // Local preview mode registration
  const accounts = readLocalAccounts();
  if (accounts.some((a) => a.email === email)) {
    throw new Error('An account with this email already exists in local preview. Sign in instead.');
  }
  const newAcc: LocalUserAccount = {
    userId: `local-${Date.now()}`,
    email,
    displayName,
    passwordHash: hashLocalSecret(password),
  };
  accounts.push(newAcc);
  writeLocalAccounts(accounts);

  const sessionUser: AuthSessionUser = {
    userId: newAcc.userId,
    email: newAcc.email,
    displayName: newAcc.displayName,
    provider: 'local-preview',
  };
  sessionStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(sessionUser));
  return { status: 'SIGNED_IN', user: sessionUser };
}

export async function confirmEmailSignUp(email: string, code: string): Promise<void> {
  if (!code.trim()) {
    throw new Error('Enter the 6-digit verification code from your email.');
  }
  await confirmSignUp({
    username: email.trim().toLowerCase(),
    confirmationCode: code.trim(),
  });
}

export async function resendEmailSignUpCode(email: string): Promise<void> {
  await resendSignUpCode({
    username: email.trim().toLowerCase(),
  });
}

export async function requestPasswordResetCode(email: string): Promise<void> {
  if (!email.trim()) {
    throw new Error('Enter your account email address first.');
  }
  if (!isAmplifyConfigured) {
    throw new Error('Email password reset requires AWS Cognito (`amplify_outputs.json`). Create a new local account or use Demo Access.');
  }
  await resetPassword({
    username: email.trim().toLowerCase(),
  });
}

export async function submitPasswordReset(
  email: string,
  code: string,
  newPassword: string
): Promise<void> {
  if (!code.trim() || !newPassword) {
    throw new Error('Enter both the 6-digit reset code and your new password.');
  }
  await confirmResetPassword({
    username: email.trim().toLowerCase(),
    confirmationCode: code.trim(),
    newPassword,
  });
}

export function enterLocalPreviewSession(): AuthSessionUser {
  const demoUser: AuthSessionUser = {
    userId: 'preview-engineer-01',
    email: 'engineer@hydrology.studio',
    displayName: 'Hydraulic Engineer',
    provider: 'local-preview',
  };
  try {
    sessionStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(demoUser));
  } catch {
    // Ignore
  }
  return demoUser;
}

export async function signOutUser(): Promise<void> {
  if (isAmplifyConfigured) {
    await signOut();
  }
  try {
    sessionStorage.removeItem(LOCAL_SESSION_KEY);
  } catch {
    // Ignore
  }
}
