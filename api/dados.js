// CRAVE · busca os dados oficiais e entrega para a página.
// Nível e chuva: telemetria da ANA. Avisos: INMET. Sem IA no caminho.

// ===== ESTAÇÕES E COTAS (cm), conforme SAH Taquari / SGB =====
const ESTACOES = [
  { codigo: '86879300', nome: 'Estrela / Lajeado', papel: 'principal', cotas: { atencao: 1500, alerta: 1700, inundacao: 1900 } },
  { codigo: '86720000', nome: 'Encantado', papel: 'montante', cotas: { atencao: 500, alerta: 900, inundacao: 1200 } },
  { codigo: '86510000', nome: 'Muçum', papel: 'montante', cotas: { atencao: 500, alerta: 900, inundacao: 1800 },
    nota: 'Cota de atenção de Muçum ainda a confirmar com o SGB: o gráfico do boletim usa 500 cm, e o texto já citou 600 cm.' },
  { codigo: '86472600', nome: 'Santa Tereza', papel: 'montante', cotas: { atencao: 600, alerta: 900, inundacao: 1500 } },
];
// Municípios para os avisos do INMET (código IBGE). 4311403 = Lajeado.
const MUNICIPIOS_IBGE = { '4311403': 'Lajeado' };

const ANA_URL = 'https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos';
const INMET_URL = 'https://apiprevmet3.inmet.gov.br/avisos/ativos';

function dataBR(d) {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('day')}/${g('month')}/${g('year')}`;
}
function anaUrl(codigo, agora) {
  const ini = new Date(agora.getTime() - 864e5), fim = new Date(agora.getTime() + 864e5);
  return `${ANA_URL}?codEstacao=${codigo}&dataInicio=${dataBR(ini)}&dataFim=${dataBR(fim)}`;
}
function campo(b, nome) {
  const m = b.match(new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`));
  const v = m ? m[1].trim() : '';
  return v === '' ? null : v;
}
function num(v) { if (v == null) return null; const n = Number(v.replace(',', '.')); return Number.isFinite(n) ? n : null; }
function data(v) {
  // Horário da ANA = Brasília (UTC-3)
  const m = v && v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}-03:00`);
  return isNaN(d) ? null : d;
}
function lerXml(xml) {
  const porId = /<(\w+)\b[^>]*diffgr:id="[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
  const porNome = /<(DadosHidrometere?ologicos)\b[^>]*>([\s\S]*?)<\/\1>/g;
  const re = porId.test(xml) ? (porId.lastIndex = 0, porId) : porNome;
  const out = []; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[2];
    if (!b.includes('<CodEstacao>') || !b.includes('<DataHora>')) continue;
    const r = { cod: campo(b, 'CodEstacao'), quando: data(campo(b, 'DataHora')), nivel: num(campo(b, 'Nivel')), chuva: num(campo(b, 'Chuva')) };
    if (r.quando) out.push(r);
  }
  return out;
}
function resumir(regs, codigo) {
  const daEst = regs.filter((r) => r.cod === String(codigo));
  const comNivel = daEst.filter((r) => r.nivel != null).sort((a, b) => b.quando - a.quando);
  if (!comNivel.length) return { ok: false, motivo: !daEst.length && regs.length ? 'codigo_divergente' : 'sem_leitura' };
  const u = comNivel[0];
  const alvo = u.quando.getTime() - 36e5;
  const h1 = comNivel.find((r) => Math.abs(r.quando.getTime() - alvo) <= 8 * 6e4);
  const chuvas = daEst.filter((r) => r.chuva != null && r.quando.getTime() > u.quando.getTime() - 864e5);
  return {
    ok: true, nivelCm: u.nivel, leituraEm: u.quando.toISOString(),
    variacao1hCm: h1 ? +(u.nivel - h1.nivel).toFixed(1) : null,
    chuva24hMm: chuvas.length ? +chuvas.reduce((s, r) => s + r.chuva, 0).toFixed(1) : null,
  };
}
async function buscar(url, comoJson) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'CRAVE/1.0 (projeto academico IFSul Lajeado)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return comoJson ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}
const erroTxt = (e) => String((e && e.cause && e.cause.code) || (e && e.message) || e);

async function lerRio(agora) {
  return Promise.all(ESTACOES.map(async (e) => {
    const url = anaUrl(e.codigo, agora);
    try { return { ...e, fonteUrl: url, ...resumir(lerXml(await buscar(url)), e.codigo) }; }
    catch (err) { return { ...e, fonteUrl: url, ok: false, motivo: 'fonte_inacessivel', erro: erroTxt(err) }; }
  }));
}
async function lerAvisos() {
  try {
    const json = await buscar(INMET_URL, true);
    const cods = Object.keys(MUNICIPIOS_IBGE); const avisos = [];
    for (const [grupo, lista] of Object.entries(json || {})) {
      if (!Array.isArray(lista)) continue;
      for (const a of lista) {
        const munis = JSON.stringify(a.municipios ?? '');
        const afet = cods.filter((c) => munis.includes(c)).map((c) => MUNICIPIOS_IBGE[c]);
        if (!afet.length) continue;
        avisos.push({ grupo, descricao: a.descricao ?? a.evento ?? null, severidade: a.severidade ?? null,
          inicio: [a.data_inicio, a.hora_inicio].filter(Boolean).join(' ') || null,
          fim: [a.data_fim, a.hora_fim].filter(Boolean).join(' ') || null, municipios: afet });
      }
    }
    return { ok: true, avisos };
  } catch (err) { return { ok: false, motivo: 'fonte_inacessivel', erro: erroTxt(err) }; }
}

module.exports = async (req, res) => {
  const agora = new Date();
  const [estacoes, avisos] = await Promise.all([lerRio(agora), lerAvisos()]);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ consultadoEm: agora.toISOString(), estacoes, avisos }));
};
module.exports._teste = { lerXml, resumir, anaUrl };

