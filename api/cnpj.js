export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { cnpj } = req.query;
  if (!cnpj) return res.status(400).json({ error: 'CNPJ obrigatório' });

  const cleaned = cnpj.replace(/\D/g, '');
  if (cleaned.length !== 14) return res.status(400).json({ error: 'CNPJ inválido' });

  // 1. Try SERPRO (requires bearer token via env var SERPRO_TOKEN)
  const token = process.env.SERPRO_TOKEN;
  if (token) {
    try {
      const [empRes, qsaRes] = await Promise.all([
        fetch(`https://apigateway.conectagov.estaleiro.serpro.gov.br/api-cnpj-empresa/v2/empresa/${cleaned}`, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        }),
        fetch(`https://apigateway.conectagov.estaleiro.serpro.gov.br/api-cnpj-qsa/v2/qsa/${cleaned}`, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        }),
      ]);

      if (empRes.ok) {
        const emp = await empRes.json();
        let qsa = [];
        if (qsaRes.ok) {
          const qsaData = await qsaRes.json();
          qsa = qsaData?.qsa || [];
        }

        const end = emp.estabelecimento || emp;
        return res.json({
          razao_social: emp.razao_social || '',
          nome_fantasia: end.nome_fantasia || emp.nome_fantasia || '',
          cnpj: cleaned,
          logradouro: end.logradouro || '',
          numero: end.numero || '',
          complemento: end.complemento || '',
          bairro: end.bairro || '',
          municipio: end.municipio || '',
          uf: end.uf || '',
          cep: end.cep || '',
          qsa,
        });
      }
    } catch (_) {
      // fall through to BrasilAPI
    }
  }

  // 2. Fallback: BrasilAPI (Receita Federal, sem autenticação)
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cleaned}`, {
      headers: { 'User-Agent': 'NexoPresenter/1.0' },
    });

    if (!r.ok) throw new Error('not found');

    const d = await r.json();

    const addrParts = [d.logradouro, d.numero, d.complemento, d.bairro, d.municipio, d.uf]
      .filter(Boolean)
      .join(', ');

    return res.json({
      razao_social: d.razao_social || '',
      nome_fantasia: d.nome_fantasia || '',
      cnpj: d.cnpj || cleaned,
      logradouro: d.logradouro || '',
      numero: d.numero || '',
      complemento: d.complemento || '',
      bairro: d.bairro || '',
      municipio: d.municipio || '',
      uf: d.uf || '',
      cep: d.cep || '',
      endereco_completo: addrParts,
      qsa: d.qsa || [],
    });
  } catch (e) {
    return res.status(404).json({ error: 'CNPJ não encontrado na Receita Federal' });
  }
}
