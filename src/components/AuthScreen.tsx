import React, { useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Cpu,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  User,
  Waves,
} from 'lucide-react';
import { isAmplifyConfigured } from '../lib/amplifyCloud';
import {
  completeNewPasswordChallenge,
  confirmEmailSignUp,
  enterLocalPreviewSession,
  formatAuthError,
  requestPasswordResetCode,
  resendEmailSignUpCode,
  signInWithEmail,
  signUpWithEmail,
  submitPasswordReset,
  type AuthSessionUser,
} from '../lib/authService';

type AuthViewMode =
  | 'sign-in'
  | 'sign-up'
  | 'verify-code'
  | 'new-password-challenge'
  | 'forgot-request'
  | 'forgot-confirm';

interface AuthScreenProps {
  onAuthenticated: (user: AuthSessionUser) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<AuthViewMode>('sign-in');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [verificationCode, setVerificationCode] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);

  const [busy, setBusy] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [noticeText, setNoticeText] = useState<string | null>(null);

  const switchMode = (next: AuthViewMode) => {
    setMode(next);
    setErrorText(null);
    setNoticeText(null);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText(null);
    setNoticeText(null);
    setBusy(true);
    try {
      const res = await signInWithEmail(email, password);
      if (res.status === 'SIGNED_IN') {
        onAuthenticated(res.user);
      } else if (res.status === 'CONFIRM_SIGN_UP') {
        setMode('verify-code');
        setNoticeText(
          `Your account needs email verification. Enter the 6-digit code sent to ${res.email}.`
        );
      } else if (res.status === 'NEW_PASSWORD_REQUIRED') {
        setPassword('');
        setConfirmPassword('');
        setMode('new-password-challenge');
        setNoticeText('Set a permanent password to complete your first sign-in.');
      }
    } catch (err) {
      setErrorText(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText(null);
    setNoticeText(null);

    if (password !== confirmPassword) {
      setErrorText('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const res = await signUpWithEmail(email, password, displayName);
      if (res.status === 'SIGNED_IN' && res.user) {
        onAuthenticated(res.user);
      } else {
        setMode('verify-code');
        setNoticeText(
          `We sent a 6-digit verification code to ${email.trim().toLowerCase()}. Enter it below to activate your account.`
        );
      }
    } catch (err) {
      setErrorText(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVerifySignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText(null);
    setNoticeText(null);
    setBusy(true);
    try {
      await confirmEmailSignUp(email, verificationCode);
      if (password) {
        const loginRes = await signInWithEmail(email, password);
        if (loginRes.status === 'SIGNED_IN') {
          onAuthenticated(loginRes.user);
          return;
        }
      }
      setMode('sign-in');
      setNoticeText('Email verified. Sign in with your password to open the workbench.');
    } catch (err) {
      setErrorText(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleNewPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText(null);
    if (password !== confirmPassword) {
      setErrorText('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const user = await completeNewPasswordChallenge(password, email);
      onAuthenticated(user);
    } catch (err) {
      setErrorText(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText(null);
    setNoticeText(null);
    setBusy(true);
    try {
      await requestPasswordResetCode(email);
      setVerificationCode('');
      setPassword('');
      setConfirmPassword('');
      setMode('forgot-confirm');
      setNoticeText(`Password reset code sent to ${email.trim().toLowerCase()}.`);
    } catch (err) {
      setErrorText(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText(null);
    if (password !== confirmPassword) {
      setErrorText('New passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await submitPasswordReset(email, verificationCode, password);
      setMode('sign-in');
      setNoticeText('Password updated. Sign in with your new password.');
    } catch (err) {
      setErrorText(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleResendCode = async () => {
    setErrorText(null);
    setBusy(true);
    try {
      await resendEmailSignUpCode(email);
      setNoticeText(`Sent a fresh 6-digit verification code to ${email.trim().toLowerCase()}.`);
    } catch (err) {
      setErrorText(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-viewport">
      <div className="auth-frame">
        {/* Left Subsurface Telemetry & Architecture Specimen */}
        <section className="auth-specimen" aria-label="Workbench overview">
          <div className="auth-brand-top">
            <div className="brand-glyph" aria-hidden="true">
              <Waves size={20} />
            </div>
            <div>
              <div className="brand-kicker">COLLECTION SYSTEM HYDROLOGY WORKBENCH</div>
              <h1 className="auth-specimen-title">
                RTK &amp; InfoWorks ICM Ground Infiltration Studio
              </h1>
            </div>
          </div>

          <p className="auth-specimen-lead">
            Sign in to upload rainfall hyetographs and sewer flow-meter telemetry, isolate wet-weather
            events, and run coupled 3-unit RTK + InfoWorks ICM 2-Store Ground Infiltration calibrations
            on AWS Lambda.
          </p>

          {/* Signature Hydrograph & Subsurface Store Schematic */}
          <div className="auth-hydro-diagram" aria-hidden="true">
            <div className="auth-diagram-header">
              <span>COUPLED RDII + SUBSURFACE RECESSION PROFILE</span>
              <span className="auth-diagram-tag">hw_ground_infiltration</span>
            </div>
            <svg viewBox="0 0 460 162" className="auth-diagram-svg">
              <defs>
                <linearGradient id="rtkFillGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.34" />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
                </linearGradient>
                <linearGradient id="gwiFillGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.36" />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.04" />
                </linearGradient>
              </defs>

              {/* Horizontal datum rules */}
              <line x1="12" y1="42" x2="448" y2="42" stroke="rgba(148,163,184,0.22)" strokeDasharray="3 3" />
              <line x1="12" y1="138" x2="448" y2="138" stroke="rgba(148,163,184,0.3)" />

              {/* Inverted ceiling rainfall hyetograph bars */}
              <g fill="#38bdf8" opacity="0.88">
                <rect x="64" y="8" width="7" height="12" rx="1" />
                <rect x="75" y="8" width="7" height="28" rx="1" />
                <rect x="86" y="8" width="7" height="32" rx="1" />
                <rect x="97" y="8" width="7" height="19" rx="1" />
                <rect x="108" y="8" width="7" height="9" rx="1" />
                <rect x="218" y="8" width="7" height="15" rx="1" />
                <rect x="229" y="8" width="7" height="24" rx="1" />
                <rect x="240" y="8" width="7" height="11" rx="1" />
              </g>

              {/* InfoWorks ICM Groundwater Store long tail */}
              <path
                d="M 16 136 L 78 135 Q 108 110 142 106 Q 196 112 228 115 Q 252 94 288 98 Q 362 108 446 123 L 446 138 L 16 138 Z"
                fill="url(#gwiFillGrad)"
              />
              <path
                d="M 16 136 L 78 135 Q 108 110 142 106 Q 196 112 228 115 Q 252 94 288 98 Q 362 108 446 123"
                fill="none"
                stroke="#f59e0b"
                strokeWidth="2"
              />

              {/* Coupled Total Flow (Fast/Med RTK + ICM GWI + DWF) */}
              <path
                d="M 16 132 L 68 131 L 84 92 L 96 54 L 112 78 L 132 101 L 175 109 L 222 112 L 238 66 L 254 84 L 284 96 L 365 110 L 446 122 L 446 138 L 16 138 Z"
                fill="url(#rtkFillGrad)"
              />
              <path
                d="M 16 132 L 68 131 L 84 92 L 96 54 L 112 78 L 132 101 L 175 109 L 222 112 L 238 66 L 254 84 L 284 96 L 365 110 L 446 122"
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2.2"
              />

              {/* Labels */}
              <text x="260" y="23" fill="#93c5fd" fontSize="9.5" fontFamily="JetBrains Mono, monospace">
                Rainfall Hyetograph (in/hr)
              </text>
              <text x="108" y="60" fill="#e0f2fe" fontSize="9.5" fontFamily="JetBrains Mono, monospace">
                Fast/Med RTK Peak
              </text>
              <text x="292" y="91" fill="#fcd34d" fontSize="9.5" fontFamily="JetBrains Mono, monospace">
                ICM 2-Store Groundwater Tail
              </text>
            </svg>
          </div>

          <div className="auth-arch-grid">
            <div className="auth-arch-cell">
              <ShieldCheck size={15} />
              <div>
                <strong>{isAmplifyConfigured ? 'Amazon Cognito' : 'Preview Auth Gate'}</strong>
                <span>
                  {isAmplifyConfigured
                    ? 'User Pool JWT & 6-digit email verification'
                    : 'Local preview mode · Cognito active on deploy'}
                </span>
              </div>
            </div>
            <div className="auth-arch-cell">
              <Cpu size={15} />
              <div>
                <strong>AWS Lambda Default</strong>
                <span>Node 22 · 2048 MB Differential Evolution solver</span>
              </div>
            </div>
            <div className="auth-arch-cell">
              <Database size={15} />
              <div>
                <strong>S3 + AppSync Data</strong>
                <span>Authenticated basin storage &amp; CSV deliverables</span>
              </div>
            </div>
          </div>
        </section>

        {/* Right Credential & Verification Sheet */}
        <section className="auth-sheet" aria-label="Authentication form">
          {(mode === 'sign-in' || mode === 'sign-up') && (
            <div className="auth-mode-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'sign-in'}
                className={mode === 'sign-in' ? 'auth-tab active' : 'auth-tab'}
                onClick={() => switchMode('sign-in')}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'sign-up'}
                className={mode === 'sign-up' ? 'auth-tab active' : 'auth-tab'}
                onClick={() => switchMode('sign-up')}
              >
                Create account
              </button>
            </div>
          )}

          <div className="auth-sheet-header">
            <div className="eyebrow-tag">
              {isAmplifyConfigured ? 'AWS COGNITO USER POOL' : 'WORKBENCH ACCESS'}
            </div>
            <h2 className="auth-sheet-title">
              {mode === 'sign-in' && 'Sign in to your basin workspace'}
              {mode === 'sign-up' && 'Create an engineering account'}
              {mode === 'verify-code' && 'Verify your email address'}
              {mode === 'new-password-challenge' && 'Set your permanent password'}
              {mode === 'forgot-request' && 'Reset your password'}
              {mode === 'forgot-confirm' && 'Enter reset code & new password'}
            </h2>
            <p className="auth-sheet-sub">
              {mode === 'sign-in' &&
                'Enter your registered email and password to run AWS Lambda calibrations and access saved basins.'}
              {mode === 'sign-up' &&
                'Register with your email address. Amazon Cognito sends a 6-digit verification code.'}
              {mode === 'verify-code' &&
                'Check your inbox for the 6-digit verification code from Amazon Cognito.'}
              {mode === 'new-password-challenge' &&
                'Choose a new password meeting the Cognito security policy.'}
              {mode === 'forgot-request' &&
                'We will email a 6-digit reset code to verify your identity.'}
              {mode === 'forgot-confirm' &&
                'Enter the 6-digit code sent to your email and choose a new password.'}
            </p>
          </div>

          {noticeText && (
            <div className="auth-notice-banner" role="status">
              <CheckCircle2 size={15} />
              <span>{noticeText}</span>
            </div>
          )}

          {errorText && (
            <div className="error-banner auth-error" role="alert">
              {errorText}
            </div>
          )}

          {/* SIGN IN FORM */}
          {mode === 'sign-in' && (
            <form onSubmit={handleSignIn} className="auth-form">
              <label className="field-label">
                Email address
                <div className="auth-input-wrap">
                  <Mail size={15} className="auth-input-icon" />
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="engineer@utility.org"
                    className="text-input auth-padded-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </label>

              <label className="field-label">
                <span className="auth-label-split">
                  <span>Password</span>
                  <button
                    type="button"
                    className="auth-link-btn"
                    onClick={() => switchMode('forgot-request')}
                  >
                    Forgot password?
                  </button>
                </span>
                <div className="auth-input-wrap">
                  <Lock size={15} className="auth-input-icon" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    placeholder="Enter password"
                    className="text-input auth-padded-input auth-has-eye"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="auth-eye-btn"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </label>

              <button type="submit" className="btn-primary auth-submit-btn" disabled={busy}>
                <span>{busy ? 'Signing in...' : 'Sign in to workbench'}</span>
                <ArrowRight size={15} />
              </button>
            </form>
          )}

          {/* CREATE ACCOUNT FORM */}
          {mode === 'sign-up' && (
            <form onSubmit={handleSignUp} className="auth-form">
              <label className="field-label">
                Full name
                <div className="auth-input-wrap">
                  <User size={15} className="auth-input-icon" />
                  <input
                    type="text"
                    autoComplete="name"
                    placeholder="e.g. Alex Morgan, PE"
                    className="text-input auth-padded-input"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
              </label>

              <label className="field-label">
                Email address
                <div className="auth-input-wrap">
                  <Mail size={15} className="auth-input-icon" />
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="engineer@utility.org"
                    className="text-input auth-padded-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </label>

              <label className="field-label">
                Password
                <div className="auth-input-wrap">
                  <Lock size={15} className="auth-input-icon" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    className="text-input auth-padded-input auth-has-eye"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="auth-eye-btn"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <small className="auth-password-hint">
                  Use 8+ characters with uppercase, lowercase, number, and symbol.
                </small>
              </label>

              <label className="field-label">
                Confirm password
                <div className="auth-input-wrap">
                  <Lock size={15} className="auth-input-icon" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="Re-enter password"
                    className="text-input auth-padded-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
              </label>

              <button type="submit" className="btn-primary auth-submit-btn" disabled={busy}>
                <span>{busy ? 'Creating account...' : 'Create engineer account'}</span>
                <ArrowRight size={15} />
              </button>
            </form>
          )}

          {/* VERIFY SIGN-UP CODE FORM */}
          {mode === 'verify-code' && (
            <form onSubmit={handleVerifySignUp} className="auth-form">
              <label className="field-label">
                Email address
                <div className="auth-input-wrap">
                  <Mail size={15} className="auth-input-icon" />
                  <input
                    type="email"
                    required
                    className="text-input auth-padded-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </label>

              <label className="field-label">
                6-digit verification code
                <div className="auth-input-wrap">
                  <KeyRound size={15} className="auth-input-icon" />
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    maxLength={8}
                    placeholder="123456"
                    className="text-input auth-padded-input mono-input auth-code-input"
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                  />
                </div>
              </label>

              <button type="submit" className="btn-primary auth-submit-btn" disabled={busy}>
                <span>{busy ? 'Verifying code...' : 'Verify & sign in'}</span>
                <ArrowRight size={15} />
              </button>

              <div className="auth-secondary-links">
                <button
                  type="button"
                  className="auth-link-btn"
                  disabled={busy}
                  onClick={handleResendCode}
                >
                  Resend verification code
                </button>
                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => switchMode('sign-in')}
                >
                  Back to sign in
                </button>
              </div>
            </form>
          )}

          {/* ADMIN-CREATED USER NEW PASSWORD CHALLENGE */}
          {mode === 'new-password-challenge' && (
            <form onSubmit={handleNewPasswordSubmit} className="auth-form">
              <label className="field-label">
                New password
                <div className="auth-input-wrap">
                  <Lock size={15} className="auth-input-icon" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="New permanent password"
                    className="text-input auth-padded-input auth-has-eye"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="auth-eye-btn"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </label>

              <label className="field-label">
                Confirm new password
                <div className="auth-input-wrap">
                  <Lock size={15} className="auth-input-icon" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="Confirm permanent password"
                    className="text-input auth-padded-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
              </label>

              <button type="submit" className="btn-primary auth-submit-btn" disabled={busy}>
                <span>{busy ? 'Saving password...' : 'Save password & continue'}</span>
                <ArrowRight size={15} />
              </button>
            </form>
          )}

          {/* FORGOT PASSWORD REQUEST */}
          {mode === 'forgot-request' && (
            <form onSubmit={handleRequestReset} className="auth-form">
              <label className="field-label">
                Account email address
                <div className="auth-input-wrap">
                  <Mail size={15} className="auth-input-icon" />
                  <input
                    type="email"
                    required
                    placeholder="engineer@utility.org"
                    className="text-input auth-padded-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </label>

              <button type="submit" className="btn-primary auth-submit-btn" disabled={busy}>
                <span>{busy ? 'Sending code...' : 'Send reset code'}</span>
                <ArrowRight size={15} />
              </button>

              <div className="auth-secondary-links">
                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => switchMode('sign-in')}
                >
                  Back to sign in
                </button>
              </div>
            </form>
          )}

          {/* FORGOT PASSWORD CONFIRM */}
          {mode === 'forgot-confirm' && (
            <form onSubmit={handleConfirmReset} className="auth-form">
              <label className="field-label">
                6-digit reset code
                <div className="auth-input-wrap">
                  <KeyRound size={15} className="auth-input-icon" />
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    maxLength={8}
                    placeholder="123456"
                    className="text-input auth-padded-input mono-input auth-code-input"
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                  />
                </div>
              </label>

              <label className="field-label">
                New password
                <div className="auth-input-wrap">
                  <Lock size={15} className="auth-input-icon" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="At least 8 characters"
                    className="text-input auth-padded-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </label>

              <label className="field-label">
                Confirm new password
                <div className="auth-input-wrap">
                  <Lock size={15} className="auth-input-icon" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="Re-enter new password"
                    className="text-input auth-padded-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
              </label>

              <button type="submit" className="btn-primary auth-submit-btn" disabled={busy}>
                <span>{busy ? 'Updating password...' : 'Update password'}</span>
                <ArrowRight size={15} />
              </button>

              <div className="auth-secondary-links">
                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => switchMode('sign-in')}
                >
                  Back to sign in
                </button>
              </div>
            </form>
          )}

          {/* Local Dev Quick Sandbox Entry (only shown when amplify_outputs.json is absent locally) */}
          {!isAmplifyConfigured && (mode === 'sign-in' || mode === 'sign-up') && (
            <div className="auth-local-preview-box">
              <div className="auth-divider">
                <span>LOCAL DEV PREVIEW</span>
              </div>
              <button
                type="button"
                className="btn-secondary full-w auth-demo-btn"
                onClick={() => onAuthenticated(enterLocalPreviewSession())}
              >
                Continue in Local Sandbox (No AWS Credentials)
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
