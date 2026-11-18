import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  try {
    const file = path.join(process.cwd(), 'public', 'runtime-config.json');
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const url = String(cfg.backend_url || '').trim().replace(/\/+$/, '');
      if (url) return res.status(200).setHeader('Cache-Control','no-store, max-age=0').json({ ok:true, url, updated_at:cfg.updated_at||null });
    }
  } catch {}
  return res.status(503).setHeader('Cache-Control','no-store, max-age=0').json({ ok:false, error:'Backend URL has not been published yet.' });
}
