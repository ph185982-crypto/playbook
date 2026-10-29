const BASE = process.env.CLICKSIGN_BASE || 'https://app.clicksign.com/api/v3';
const JSONAPI = 'application/vnd.api+json';

async function cs(token, path, method = 'GET', body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: token, 'Content-Type': JSONAPI, Accept: JSONAPI },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const e = (data.errors && data.errors[0]) || {};
    const err = new Error(e.detail || e.title || data.raw || `Erro ${r.status}`);
    err.status = r.status;
    err.step = `${method} ${path.split('?')[0]}`;
    throw err;
  }
  return data;
}

async function listAllFolders(token) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const d = await cs(token, `/folders?page[number]=${page}&page[size]=50`);
    const items = d.data || [];
    out.push(...items);
    const total = (d.meta && d.meta.record_count) || 0;
    if (!items.length || out.length >= total) break;
  }
  return out;
}

async function ensureFolder(token, parts) {
  const all = await listAllFolders(token);
  let parentId = null, parentPath = '';
  for (const name of parts) {
    const found = all.find(f => {
      const a = f.attributes || {};
      if (a.name !== name) return false;
      const p = a.path || '';
      return parentId ? (p === parentPath || p === `${parentPath}/${name}`) : (a.in_root === true || p === '' || p === `/${name}`);
    });
    if (found) { parentId = found.id; parentPath = `${parentPath}/${name}`; continue; }
    const body = { data: { type: 'folders', attributes: { name } } };
    if (parentId) body.data.relationships = { folder: { data: { type: 'folders', id: parentId } } };
    const created = await cs(token, '/folders', 'POST', body);
    parentId = created.data.id; parentPath = `${parentPath}/${name}`;
  }
  return parentId;
}

function sanitizeName(s) {
  return String(s || '').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || 'Sem nome';
}

const STATUS = { draft: 'pending', running: 'pending', closed: 'signed', canceled: 'recusado' };

async function createEnvelope(token, b) {
  let folderId = null, folderWarning = null;
  if (Array.isArray(b.folder) && b.folder.length) {
    try { folderId = await ensureFolder(token, b.folder.map(sanitizeName)); }
    catch (e) { folderWarning = `Pasta não criada (${e.message}); envelope criado na raiz.`; }
  }
  const env = { data: { type: 'envelopes', attributes: {
    name: String(b.name || 'Contrato').slice(0, 200), locale: 'pt-BR', auto_close: true, remind_interval: 3, block_after_refusal: true,
    default_subject: String(b.subject || 'Contrato para assinatura').slice(0, 100),
    default_message: b.message || null,
  } } };
  if (folderId) env.data.relationships = { folder: { data: { type: 'folders', id: folderId } } };
  const envelope = await cs(token, '/envelopes', 'POST', env);
  const envId = envelope.data.id;

  const doc = await cs(token, `/envelopes/${envId}/documents`, 'POST', { data: { type: 'documents', attributes: {
    filename: b.filename, content_base64: `data:application/pdf;base64,${b.base64_pdf}`,
  } } });
  const docId = doc.data.id;

  let autoSigner = null;
  try { autoSigner = process.env.CLICKSIGN_AUTO_SIGNER ? JSON.parse(process.env.CLICKSIGN_AUTO_SIGNER) : null; } catch (_) {}

  const signers = [];
  for (const s0 of b.signers || []) {
    const s = { ...s0 };
    if (autoSigner && s.email && String(s.email).toLowerCase() === String(autoSigner.email || '').toLowerCase()) {
      Object.assign(s, { auto: true, documentation: autoSigner.documentation, birthday: autoSigner.birthday });
    }
    const channel = s.channel === 'whatsapp' && s.phone ? 'whatsapp' : 'email';
    const attrs = {
      name: s.name, refusable: false, has_documentation: s.auto ? true : s.has_documentation !== false,
      communicate_events: {
        signature_request: s.auto ? 'none' : channel,
        signature_reminder: s.auto || !s.email ? 'none' : 'email',
        document_signed: s.email ? 'email' : 'whatsapp',
      },
    };
    if (s.email) attrs.email = s.email;
    if (s.phone) attrs.phone_number = String(s.phone).replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    if (s.documentation) attrs.documentation = s.documentation;
    if (s.birthday) attrs.birthday = s.birthday;
    const signer = await cs(token, `/envelopes/${envId}/signers`, 'POST', { data: { type: 'signers', attributes: attrs } });
    const sid = signer.data.id;
    const rel = { document: { data: { type: 'documents', id: docId } }, signer: { data: { type: 'signers', id: sid } } };
    await cs(token, `/envelopes/${envId}/requirements`, 'POST', { data: { type: 'requirements', attributes: { action: 'agree', role: s.role || 'party' }, relationships: rel } });
    await cs(token, `/envelopes/${envId}/requirements`, 'POST', { data: { type: 'requirements', attributes: { action: 'provide_evidence', auth: s.auto ? 'auto_signature' : channel }, relationships: rel } });
    signers.push({ id: sid, name: s.name, channel: s.auto ? 'auto_signature' : channel });
  }

  await cs(token, `/envelopes/${envId}`, 'PATCH', { data: { id: envId, type: 'envelopes', attributes: { status: 'running' } } });
  let notified = true;
  try { await cs(token, `/envelopes/${envId}/notifications`, 'POST', { data: { type: 'notifications', attributes: b.message ? { message: b.message } : {} } }); }
  catch (_) { notified = false; }
  return { token: envId, document_id: docId, folder_id: folderId, signers, notified, warning: folderWarning };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const token = process.env.CLICKSIGN_TOKEN;
  const pin = process.env.NEXO_PIN;
  if (!token || !pin) return res.status(500).json({ error: 'server_not_configured', message: 'Configure CLICKSIGN_TOKEN e NEXO_PIN na Vercel.' });
  if (req.headers['x-nexo-pin'] !== pin) return res.status(401).json({ error: 'invalid_pin' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    switch (b.action) {
      case 'status': {
        try { await cs(token, '/envelopes?page[size]=1'); return res.status(200).json({ ok: true }); }
        catch (e) { return res.status(200).json({ ok: false, message: `ClickSign: ${e.message}` }); }
      }
      case 'create':
        return res.status(200).json(await createEnvelope(token, b.document || {}));
      case 'list': {
        const d = await cs(token, '/envelopes?sort=-created&page[size]=50');
        return res.status(200).json({ results: (d.data || []).map(e => ({
          provider: 'clicksign', token: e.id, name: e.attributes.name, raw_status: e.attributes.status,
          status: STATUS[e.attributes.status] || e.attributes.status, created_at: e.attributes.created,
        })) });
      }
      case 'get': {
        const id = encodeURIComponent(b.token);
        const [e, s] = await Promise.all([cs(token, `/envelopes/${id}`), cs(token, `/envelopes/${id}/signers`)]);
        return res.status(200).json({ provider: 'clicksign', token: e.data.id, name: e.data.attributes.name, raw_status: e.data.attributes.status,
          status: STATUS[e.data.attributes.status] || e.data.attributes.status,
          signers: (s.data || []).map(x => ({ nome: x.attributes.name, email: x.attributes.email, telefone: x.attributes.phone_number })) });
      }
      case 'resend': {
        await cs(token, `/envelopes/${encodeURIComponent(b.token)}/notifications`, 'POST', { data: { type: 'notifications', attributes: {} } });
        return res.status(200).json({ ok: true });
      }
      case 'cancel': {
        const id = encodeURIComponent(b.token);
        let docIds = b.document_id ? [b.document_id] : [];
        if (!docIds.length) docIds = ((await cs(token, `/envelopes/${id}/documents`)).data || []).map(d => d.id);
        for (const did of docIds) {
          await cs(token, `/envelopes/${id}/documents/${encodeURIComponent(did)}`, 'PATCH', { data: { id: did, type: 'documents', attributes: { status: 'canceled' } } });
        }
        return res.status(200).json({ ok: true });
      }
      case 'auto_term': {
        const t = b.term || {};
        const d = await cs(token, '/auto_signature/terms', 'POST', { data: { type: 'auto_signature_terms', attributes: {
          signer: { name: t.name, email: t.email, documentation: t.documentation, birthday: t.birthday },
          api_email: t.api_email, admin_email: t.admin_email,
        } } });
        return res.status(200).json({ ok: true, id: d.data && d.data.id });
      }
      default:
        return res.status(400).json({ error: 'invalid_action' });
    }
  } catch (e) {
    return res.status(e.status && e.status < 500 ? e.status : 502).json({ error: 'clicksign_error', message: e.message, step: e.step });
  }
};
