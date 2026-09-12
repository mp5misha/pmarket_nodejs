import { getPool, ensureSchema, getSetting, setSetting, deleteSetting } from "../../lib/db.js";
import { DEEPSEEK_KEY_SETTING, DEEPSEEK_PROMPT_SETTING } from "../../lib/settings.js";
import { DEFAULT_PROMPT_TEMPLATE } from "../../lib/deepseek.js";

// A single dynamic-route function serving both /api/settings/deepseek-key
// and /api/settings/deepseek-prompt (previously two separate files) — the
// Hobby plan caps a deployment at 12 serverless functions, and this repo
// was one function over that limit.

/** Reports whether a DeepSeek key is available and where it came from,
 * without ever sending the key itself back to the client. */
async function keyStatus(pool) {
  const stored = await getSetting(pool, DEEPSEEK_KEY_SETTING);
  if (stored) return { configured: true, source: "database" };
  if (process.env.DEEPSEEK_API_KEY) return { configured: true, source: "env" };
  return { configured: false, source: "none" };
}

async function promptStatus(pool) {
  const stored = await getSetting(pool, DEEPSEEK_PROMPT_SETTING);
  return { template: stored || DEFAULT_PROMPT_TEMPLATE, isDefault: !stored };
}

async function handleKey(req, res, pool) {
  if (req.method === "GET") {
    return res.status(200).json(await keyStatus(pool));
  }
  if (req.method === "POST") {
    const { apiKey } = req.body || {};
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return res.status(400).json({ error: "apiKey is required" });
    }
    await setSetting(pool, DEEPSEEK_KEY_SETTING, apiKey.trim());
    return res.status(200).json(await keyStatus(pool));
  }
  if (req.method === "DELETE") {
    await deleteSetting(pool, DEEPSEEK_KEY_SETTING);
    return res.status(200).json(await keyStatus(pool));
  }
  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handlePrompt(req, res, pool) {
  if (req.method === "GET") {
    return res.status(200).json(await promptStatus(pool));
  }
  if (req.method === "POST") {
    const { template } = req.body || {};
    if (typeof template !== "string" || !template.trim()) {
      return res.status(400).json({ error: "template is required" });
    }
    await setSetting(pool, DEEPSEEK_PROMPT_SETTING, template);
    return res.status(200).json(await promptStatus(pool));
  }
  if (req.method === "DELETE") {
    await deleteSetting(pool, DEEPSEEK_PROMPT_SETTING);
    return res.status(200).json(await promptStatus(pool));
  }
  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

    if (req.query.key === "deepseek-key") return await handleKey(req, res, pool);
    if (req.query.key === "deepseek-prompt") return await handlePrompt(req, res, pool);

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
