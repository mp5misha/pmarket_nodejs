import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function SettingsModal({ onClose, onStatusChange }) {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const refreshStatus = async () => {
    try {
      const s = await api.getDeepSeekKeyStatus();
      setStatus(s);
      onStatusChange?.(s);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const s = await api.setDeepSeekKey(apiKey.trim());
      setApiKey("");
      setStatus(s);
      onStatusChange?.(s);
      setNote("API key saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const s = await api.clearDeepSeekKey();
      setStatus(s);
      onStatusChange?.(s);
      setNote("Saved API key cleared.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          <p className="settings-label">DeepSeek API key</p>
          {status && (
            <p className="settings-status">
              {status.configured
                ? status.source === "database"
                  ? "Configured — saved here"
                  : "Configured — from the DEEPSEEK_API_KEY environment variable"
                : "Not configured"}
            </p>
          )}

          <input
            type="password"
            autoComplete="off"
            placeholder={status?.configured ? "Enter a new key to replace it" : "sk-..."}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />

          <p className="settings-hint">
            Used for the "Analyze with DeepSeek" button on a market's detail panel. Get a key
            at <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">
              platform.deepseek.com
            </a>
            .
          </p>

          {error && <p className="sync-error">{error}</p>}
          {note && <p className="settings-note">{note}</p>}

          <div className="modal-actions">
            {status?.source === "database" && (
              <button className="btn btn-ghost" onClick={clear} disabled={saving}>
                Clear saved key
              </button>
            )}
            <button className="btn" onClick={save} disabled={saving || !apiKey.trim()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
