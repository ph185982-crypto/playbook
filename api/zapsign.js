const BASE = 'https://api.zapsign.com.br/api/v1';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const token = process.env.ZAPSIGN_TOKEN;
  const pin = process.env.NEXO_PIN;
  if (!token || !pin) return res.status(500).json({ error: 'server_not_configured' });
  if (req.headers['x-nexo-pin'] !== pin) return res.status(401).json({ error: 'invalid_pin' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { action } = body;

  let url, method = 'GET', payload;
  switch (action) {
    case 'list': {
      const q = new URLSearchParams({ include_signers: 'true', sort_order: 'desc', deleted: 'false' });
      if (body.page) q.set('page', String(parseInt(body.page, 10) || 1));
      if (body.status) q.set('status', String(body.status));
      url = `${BASE}/docs/?${q}`;
      break;
    }
    case 'detail':
      url = `${BASE}/docs/${encodeURIComponent(body.token)}/`;
      break;
    case 'create':
      url = `${BASE}/docs/`; method = 'POST'; payload = body.document;
      break;
    case 'cancel':
      url = `${BASE}/refuse/`; method = 'POST';
      payload = { doc_token: body.token, rejected_reason: body.reason || 'Cancelado pela Nexo Consultoria', notify_signer: !!body.notify };
      break;
    case 'delete':
      url = `${BASE}/docs/${encodeURIComponent(body.token)}/`; method = 'DELETE';
      break;
    case 'resend':
      url = `${BASE}/docs/${encodeURIComponent(body.token)}/resend-notifications-bulk/`; method = 'POST';
      break;
    default:
      return res.status(400).json({ error: 'invalid_action' });
  }

  try {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'nexo-presenter/1.0',
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'upstream_error', detail: String(e.message || e) });
  }
};
