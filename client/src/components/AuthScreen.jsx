import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// Phase 8 auth UI. No router library (consistent with the rest of the app)
// — App.jsx decides between this, the verify-email/reset-password landing
// screens below, and the main app by reading window.location directly.

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login"); // login | register | 2fa | forgot | check-email

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberDevice, setRememberDevice] = useState(false);
  const [pendingToken, setPendingToken] = useState(null);
  const [code, setCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const resetMessages = () => {
    setError(null);
    setNote(null);
  };

  const submitLogin = async (e) => {
    e.preventDefault();
    resetMessages();
    setLoading(true);
    try {
      const result = await api.login(email, password);
      if (result.requiresTwoFactor) {
        setPendingToken(result.pendingToken);
        setMode("2fa");
        setNote("We emailed you a 6-digit code — check your inbox.");
      } else {
        onAuthenticated(result.user);
      }
    } catch (err) {
      if (err.message?.toLowerCase().includes("verify")) {
        setError(err.message);
        setNote("Didn't get the email? ");
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const submitRegister = async (e) => {
    e.preventDefault();
    resetMessages();
    setLoading(true);
    try {
      const result = await api.register(email, password);
      setMode("check-email");
      setNote(result.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const submit2fa = async (e) => {
    e.preventDefault();
    resetMessages();
    setLoading(true);
    try {
      const result = await api.verify2fa(pendingToken, code, rememberDevice);
      onAuthenticated(result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const submitForgot = async (e) => {
    e.preventDefault();
    resetMessages();
    setLoading(true);
    try {
      await api.forgotPassword(email);
      setNote("If that email is registered, a reset link is on its way.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    resetMessages();
    try {
      await api.resendVerification(email);
      setNote("If that account needs verifying, a new email is on its way.");
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Polymarket Tracker</h1>

        {mode === "login" && (
          <form onSubmit={submitLogin}>
            <h2>Log in</h2>
            <label>
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && (
              <p className="sync-error">
                {error}
                {error.toLowerCase().includes("verify") && (
                  <>
                    {" "}
                    <button type="button" className="link-button" onClick={resendVerification}>
                      Resend verification email
                    </button>
                  </>
                )}
              </p>
            )}
            {note && <p className="settings-note">{note}</p>}
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Logging in…" : "Log in"}
            </button>
            <div className="auth-links">
              <button type="button" className="link-button" onClick={() => { setMode("register"); resetMessages(); }}>
                Create an account
              </button>
              <button type="button" className="link-button" onClick={() => { setMode("forgot"); resetMessages(); }}>
                Forgot password?
              </button>
            </div>
          </form>
        )}

        {mode === "register" && (
          <form onSubmit={submitRegister}>
            <h2>Create an account</h2>
            <label>
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Password (min. 8 characters)
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <p className="sync-error">{error}</p>}
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Creating…" : "Create account"}
            </button>
            <div className="auth-links">
              <button type="button" className="link-button" onClick={() => { setMode("login"); resetMessages(); }}>
                Already have an account? Log in
              </button>
            </div>
          </form>
        )}

        {mode === "2fa" && (
          <form onSubmit={submit2fa}>
            <h2>Enter your login code</h2>
            <p className="auth-hint">We emailed a 6-digit code to {email}. It expires in 10 minutes.</p>
            <label>
              Code
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
            </label>
            <label className="field-row">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={(e) => setRememberDevice(e.target.checked)}
              />
              Remember this device for 30 days
            </label>
            {error && <p className="sync-error">{error}</p>}
            <button className="btn" type="submit" disabled={loading || code.length !== 6}>
              {loading ? "Verifying…" : "Verify"}
            </button>
            <div className="auth-links">
              <button type="button" className="link-button" onClick={() => { setMode("login"); resetMessages(); }}>
                Back to login
              </button>
            </div>
          </form>
        )}

        {mode === "forgot" && (
          <form onSubmit={submitForgot}>
            <h2>Reset your password</h2>
            <label>
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {error && <p className="sync-error">{error}</p>}
            {note && <p className="settings-note">{note}</p>}
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Sending…" : "Send reset link"}
            </button>
            <div className="auth-links">
              <button type="button" className="link-button" onClick={() => { setMode("login"); resetMessages(); }}>
                Back to login
              </button>
            </div>
          </form>
        )}

        {mode === "check-email" && (
          <div>
            <h2>Check your email</h2>
            <p className="auth-hint">{note}</p>
            <div className="auth-links">
              <button type="button" className="link-button" onClick={() => { setMode("login"); resetMessages(); }}>
                Back to login
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Landing screen for the /verify-email?token=... link in the verification
 * email — verifies immediately on mount. */
export function VerifyEmailLanding({ token, onDone }) {
  const [status, setStatus] = useState("verifying");
  const [error, setError] = useState(null);
  // The token is single-use, so a duplicate call (React StrictMode's
  // double-invoked effects in dev, or the effect re-running for any other
  // reason) must never re-consume it — that would turn a successful
  // verification into a reported failure.
  const requestedRef = useRef(false);

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    api
      .verifyEmail(token)
      .then(() => setStatus("done"))
      .catch((err) => {
        setStatus("error");
        setError(err.message);
      });
  }, [token]);

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Polymarket Tracker</h1>
        {status === "verifying" && <p>Verifying your email…</p>}
        {status === "done" && (
          <>
            <h2>Email verified</h2>
            <p className="settings-note">You can now log in.</p>
            <button className="btn" onClick={onDone}>
              Continue to login
            </button>
          </>
        )}
        {status === "error" && (
          <>
            <h2>Verification failed</h2>
            <p className="sync-error">{error}</p>
            <button className="btn" onClick={onDone}>
              Back to login
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Landing screen for the /reset-password?token=... link in the reset email. */
export function ResetPasswordLanding({ token, onDone }) {
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("form"); // form | done | error
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setStatus("done");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Polymarket Tracker</h1>
        {status === "form" && (
          <form onSubmit={submit}>
            <h2>Set a new password</h2>
            <label>
              New password (min. 8 characters)
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </label>
            {error && <p className="sync-error">{error}</p>}
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Saving…" : "Save new password"}
            </button>
          </form>
        )}
        {status === "done" && (
          <>
            <h2>Password updated</h2>
            <p className="settings-note">You've been logged out everywhere for security — log in with your new password.</p>
            <button className="btn" onClick={onDone}>
              Continue to login
            </button>
          </>
        )}
      </div>
    </div>
  );
}
