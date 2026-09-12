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

  const [modelStatus, setModelStatus] = useState(null);
  const [modelError, setModelError] = useState(null);
  const [savingModel, setSavingModel] = useState(false);

  // Phase 4: reusable prompt templates, Express/SQLite only — the legacy
  // single-prompt editor above (promptStatus/promptDraft) stays as the
  // fallback UI when /api/prompt-templates isn't available (Vercel).
  const [templatesAvailable, setTemplatesAvailable] = useState(true);
  const [templates, setTemplates] = useState(null);
  const [defaultTemplateId, setDefaultTemplateId] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templateTextDraft, setTemplateTextDraft] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateError, setTemplateError] = useState(null);
  const [templateNote, setTemplateNote] = useState(null);

  // Phase 6: bet-sizing configuration for the Kelly/flat/fixed-percentage
  // stake calculator on a market's detail panel.
  const [betSizingDraft, setBetSizingDraft] = useState(null);
  const [savingBetSizing, setSavingBetSizing] = useState(false);
  const [betSizingError, setBetSizingError] = useState(null);
  const [betSizingNote, setBetSizingNote] = useState(null);

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

  const refreshModel = async () => {
    try {
      setModelStatus(await api.getDeepSeekModelStatus());
    } catch (err) {
      setModelError(err.message);
    }
  };

  const refreshBetSizing = async () => {
    try {
      setBetSizingDraft(await api.getBetSizing());
    } catch (err) {
      setBetSizingError(err.message);
    }
  };

  const selectTemplateForEdit = (value, list = templates) => {
    if (value === "new") {
      setSelectedTemplateId("new");
      setTemplateNameDraft("");
      setTemplateTextDraft("");
      return;
    }
    const id = Number(value);
    const t = list?.find((x) => x.id === id);
    setSelectedTemplateId(id);
    setTemplateNameDraft(t?.name || "");
    setTemplateTextDraft(t?.template || "");
  };

  const refreshTemplates = async () => {
    try {
      const [list, def] = await Promise.all([api.listPromptTemplates(), api.getDefaultPromptTemplate()]);
      setTemplatesAvailable(true);
      setTemplates(list);
      setDefaultTemplateId(def.templateId);
      const initial = list.find((t) => t.id === def.templateId) || list[0];
      if (initial) selectTemplateForEdit(String(initial.id), list);
      else selectTemplateForEdit("new", list);
    } catch {
      setTemplatesAvailable(false);
    }
  };

  useEffect(() => {
    refreshStatus();
    refreshPrompt();
    refreshModel();
    refreshTemplates();
    refreshBetSizing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveBetSizing = async () => {
    setSavingBetSizing(true);
    setBetSizingError(null);
    setBetSizingNote(null);
    try {
      setBetSizingDraft(await api.setBetSizing(betSizingDraft));
      setBetSizingNote("Bet-sizing settings saved.");
    } catch (err) {
      setBetSizingError(err.message);
    } finally {
      setSavingBetSizing(false);
    }
  };

  const saveTemplate = async () => {
    if (!templateNameDraft.trim() || !templateTextDraft.trim()) return;
    setSavingTemplate(true);
    setTemplateError(null);
    setTemplateNote(null);
    try {
      if (selectedTemplateId === "new") {
        const created = await api.createPromptTemplate({
          name: templateNameDraft.trim(),
          template: templateTextDraft,
        });
        setTemplates((prev) => [...(prev || []), created]);
        setSelectedTemplateId(created.id);
        setTemplateNote("Template created.");
      } else {
        const updated = await api.updatePromptTemplate(selectedTemplateId, {
          name: templateNameDraft.trim(),
          template: templateTextDraft,
        });
        setTemplates((prev) => (prev || []).map((t) => (t.id === updated.id ? updated : t)));
        setTemplateNote("Template saved.");
      }
    } catch (err) {
      setTemplateError(err.message);
    } finally {
      setSavingTemplate(false);
    }
  };

  const deleteTemplate = async (id) => {
    setSavingTemplate(true);
    setTemplateError(null);
    setTemplateNote(null);
    try {
      await api.deletePromptTemplate(id);
      const remaining = (templates || []).filter((t) => t.id !== id);
      setTemplates(remaining);
      if (defaultTemplateId === id) setDefaultTemplateId(null);
      if (remaining[0]) selectTemplateForEdit(String(remaining[0].id), remaining);
      else selectTemplateForEdit("new", remaining);
      setTemplateNote("Template deleted.");
    } catch (err) {
      setTemplateError(err.message);
    } finally {
      setSavingTemplate(false);
    }
  };

  const setAsDefaultTemplate = async (id) => {
    setSavingTemplate(true);
    setTemplateError(null);
    setTemplateNote(null);
    try {
      const { templateId } = await api.setDefaultPromptTemplate(id);
      setDefaultTemplateId(templateId);
      setTemplateNote("Set as default template.");
    } catch (err) {
      setTemplateError(err.message);
    } finally {
      setSavingTemplate(false);
    }
  };

  const updateModel = async (patch) => {
    setSavingModel(true);
    setModelError(null);
    try {
      setModelStatus(await api.setDeepSeekModelStatus(patch));
    } catch (err) {
      setModelError(err.message);
    } finally {
      setSavingModel(false);
    }
  };

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

          <p className="settings-label">DeepSeek model</p>
          {modelStatus && (
            <>
              <div className="field-pair">
                <select
                  value={modelStatus.model}
                  disabled={savingModel}
                  onChange={(e) => updateModel({ model: e.target.value })}
                >
                  {modelStatus.availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  value={modelStatus.reasoningEffort}
                  disabled={savingModel}
                  onChange={(e) => updateModel({ reasoningEffort: e.target.value })}
                >
                  {modelStatus.reasoningEffortOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="settings-hint">
                Higher reasoning effort ("Thinking" / "Thinking (max)") gives more thorough
                analysis at a higher token cost and slower response.
              </p>
            </>
          )}
          {modelError && <p className="sync-error">{modelError}</p>}

          <hr className="modal-divider" />

          {templatesAvailable ? (
            <>
              <p className="settings-label">Prompt templates</p>
              {templates && (
                <>
                  <select
                    value={selectedTemplateId === "new" ? "new" : selectedTemplateId ?? ""}
                    onChange={(e) => selectTemplateForEdit(e.target.value)}
                  >
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.id === defaultTemplateId ? " (default)" : ""}
                      </option>
                    ))}
                    <option value="new">+ New template</option>
                  </select>

                  <input
                    type="text"
                    placeholder="Template name"
                    value={templateNameDraft}
                    onChange={(e) => setTemplateNameDraft(e.target.value)}
                    style={{ marginTop: 8 }}
                  />
                  <textarea
                    className="prompt-textarea"
                    rows={7}
                    value={templateTextDraft}
                    onChange={(e) => setTemplateTextDraft(e.target.value)}
                  />

                  <p className="settings-hint">
                    Used when you click "Analyze with DeepSeek" on a market — pick which template
                    to use there, or leave the default selected. Insert any of these variables and
                    they'll be filled in from the selected market:{" "}
                    {PROMPT_VARIABLES.map((v, i) => (
                      <span key={v}>
                        <code>{`{${v}}`}</code>
                        {i < PROMPT_VARIABLES.length - 1 ? ", " : ""}
                      </span>
                    ))}
                    .
                  </p>

                  {templateError && <p className="sync-error">{templateError}</p>}
                  {templateNote && <p className="settings-note">{templateNote}</p>}

                  <div className="modal-actions">
                    {selectedTemplateId !== "new" && (
                      <>
                        <button
                          className="btn btn-ghost"
                          onClick={() => setAsDefaultTemplate(selectedTemplateId)}
                          disabled={savingTemplate || selectedTemplateId === defaultTemplateId}
                        >
                          {selectedTemplateId === defaultTemplateId ? "Default" : "Set as default"}
                        </button>
                        <button
                          className="btn btn-ghost"
                          onClick={() => deleteTemplate(selectedTemplateId)}
                          disabled={savingTemplate}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    <button
                      className="btn"
                      onClick={saveTemplate}
                      disabled={savingTemplate || !templateNameDraft.trim() || !templateTextDraft.trim()}
                    >
                      {savingTemplate
                        ? "Saving…"
                        : selectedTemplateId === "new"
                        ? "Create template"
                        : "Save template"}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <p className="settings-label">DeepSeek analysis prompt</p>
              {promptStatus && (
                <p className="settings-status">
                  {promptStatus.isDefault ? "Using the default prompt" : "Custom prompt"}
                </p>
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
                <button className="btn" onClick={savePrompt} disabled={savingPrompt || !promptDraft.trim()}>
                  {savingPrompt ? "Saving…" : "Save prompt"}
                </button>
              </div>
            </>
          )}

          <hr className="modal-divider" />

          <p className="settings-label">Bet sizing</p>
          <p className="settings-hint">
            Used by the "Suggested stake" calculator on a market's detail panel. Bankroll here is a
            plain number for sizing suggestions against — a full bankroll (currency, per-bet cap,
            auto-deduct, ledger) is configured separately.
          </p>
          {betSizingDraft && (
            <>
              <label className="settings-field-label" htmlFor="bs-bankroll">
                Bankroll for sizing suggestions ($)
              </label>
              <input
                id="bs-bankroll"
                type="number"
                min={0}
                value={betSizingDraft.bankrollAmount}
                onChange={(e) => setBetSizingDraft({ ...betSizingDraft, bankrollAmount: Number(e.target.value) })}
              />
              <label className="settings-field-label" htmlFor="bs-kelly">
                Kelly fraction (0–1, default 0.25)
              </label>
              <input
                id="bs-kelly"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={betSizingDraft.kellyFraction}
                onChange={(e) => setBetSizingDraft({ ...betSizingDraft, kellyFraction: Number(e.target.value) })}
              />
              <label className="settings-field-label" htmlFor="bs-flat">
                Flat stake amount ($)
              </label>
              <input
                id="bs-flat"
                type="number"
                min={0}
                value={betSizingDraft.flatStakeAmount}
                onChange={(e) => setBetSizingDraft({ ...betSizingDraft, flatStakeAmount: Number(e.target.value) })}
              />
              <label className="settings-field-label" htmlFor="bs-fixed">
                Fixed percentage of bankroll (%)
              </label>
              <input
                id="bs-fixed"
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={betSizingDraft.fixedPercentagePct}
                onChange={(e) =>
                  setBetSizingDraft({ ...betSizingDraft, fixedPercentagePct: Number(e.target.value) })
                }
              />

              {betSizingError && <p className="sync-error">{betSizingError}</p>}
              {betSizingNote && <p className="settings-note">{betSizingNote}</p>}

              <div className="modal-actions">
                <button className="btn" onClick={saveBetSizing} disabled={savingBetSizing}>
                  {savingBetSizing ? "Saving…" : "Save bet-sizing settings"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
