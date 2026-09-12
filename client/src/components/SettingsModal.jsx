import { useEffect, useState } from "react";
import { api } from "../api.js";

const PROMPT_VARIABLES = ["slug", "yes_price", "no_price", "end_date", "liquidity"];

export default function SettingsModal({ onClose, onStatusChange }) {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const [promptStatus, setPromptStatus] = useState(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [promptError, setPromptError] = useState(null);
  const [promptNote, setPromptNote] = useState(null);

  const refreshStatus = async () => {
    try {
      const s = await api.getDeepSeekKeyStatus();
      setStatus(s);
      onStatusChange?.(s);
    } catch (err) {
      setError(err.message);
    }
  };

  const refreshPrompt = async () => {
    try {
      const p = await api.getPromptTemplate();
      setPromptStatus(p);
      setPromptDraft(p.template);
    } catch (err) {
      setPromptError(err.message);
    }
  };

  useEffect(() => {
    refreshStatus();
    refreshPrompt();
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

  const savePrompt = async () => {
    if (!promptDraft.trim()) return;
    setSavingPrompt(true);
    setPromptError(null);
    setPromptNote(null);
    try {
      const p = await api.setPromptTemplate(promptDraft);
      setPromptStatus(p);
      setPromptNote("Prompt saved.");
    } catch (err) {
      setPromptError(err.message);
    } finally {
      setSavingPrompt(false);
    }
  };

  const resetPrompt = async () => {
    setSavingPrompt(true);
    setPromptError(null);
    setPromptNote(null);
    try {
      const p = await api.resetPromptTemplate();
      setPromptStatus(p);
      setPromptDraft(p.template);
      setPromptNote("Reset to the default prompt.");
    } catch (err) {
      setPromptError(err.message);
    } finally {
      setSavingPrompt(false);
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

          <hr className="modal-divider" />

          <p className="settings-label">DeepSeek analysis prompt</p>
          {promptStatus && (
            <p className="settings-status">{promptStatus.isDefault ? "Using the default prompt" : "Custom prompt"}</p>
          )}

          <textarea
            className="prompt-textarea"
            rows={7}
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
          />

          <p className="settings-hint">
            Sent to DeepSeek when you click "Analyze with DeepSeek" on a market. Insert any of
            these variables and they'll be filled in from the selected market:{" "}
            {PROMPT_VARIABLES.map((v, i) => (
              <span key={v}>
                <code>{`{${v}}`}</code>
                {i < PROMPT_VARIABLES.length - 1 ? ", " : ""}
              </span>
            ))}
            .
          </p>

          {promptError && <p className="sync-error">{promptError}</p>}
          {promptNote && <p className="settings-note">{promptNote}</p>}

          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={resetPrompt} disabled={savingPrompt}>
              Reset to default
            </button>
            <button
              className="btn"
              onClick={savePrompt}
              disabled={savingPrompt || !promptDraft.trim()}
            >
              {savingPrompt ? "Saving…" : "Save prompt"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
