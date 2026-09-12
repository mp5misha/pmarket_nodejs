import { getPool, ensureSchema, getSetting, setSetting, deleteSetting } from "../../lib/db.js";
import { DEEPSEEK_PROMPT_SETTING } from "../../lib/settings.js";
import { DEFAULT_PROMPT_TEMPLATE } from "../../lib/deepseek.js";

async function promptStatus(pool) {
  const stored = await getSetting(pool, DEEPSEEK_PROMPT_SETTING);
  return { template: stored || DEFAULT_PROMPT_TEMPLATE, isDefault: !stored };
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

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
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
