import { getPool, ensureSchema, getSetting, setSetting, deleteSetting } from "../../lib/db.js";
import { DEEPSEEK_KEY_SETTING } from "../../lib/settings.js";

/** Reports whether a DeepSeek key is available and where it came from,
 * without ever sending the key itself back to the client. */
async function keyStatus(pool) {
  const stored = await getSetting(pool, DEEPSEEK_KEY_SETTING);
  if (stored) return { configured: true, source: "database" };
  if (process.env.DEEPSEEK_API_KEY) return { configured: true, source: "env" };
  return { configured: false, source: "none" };
}

export default async function handler(req, res) {
  try {
    const pool = getPool();
    await ensureSchema(pool);

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
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
}
