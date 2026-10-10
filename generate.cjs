// Victoria 3 production graph: reads the installed game and writes the page with all data embedded.
//
//   node generate.cjs                         body-only preview fragment        -> preview.html (next to this file)
//   node generate.cjs --site <dir>            also a public, self-contained     -> <dir>/index.html
//   node generate.cjs --verify                also checks three known recipes
//
// Options
//   --game <path>    game folder (the one that has common/, localization/, gfx/). Also: env VIC3_GAME.
//                    Default: the usual Steam path on Windows.
//   --save <file>    JSON { "label": "1860", "techs": ["enclosure", ...] } with the technologies of one save.
//                    Only goes into the preview fragment (adds a "My save" choice); never into --site.
//   --lang <code>    default language of the fragment (default: pt). The site picks the browser language.
//   --no-analytics   leaves out the Vercel Web Analytics snippet. By default (--analytics) the --site build includes it:
//                    anonymous visit counts, no cookies, served by Vercel from the same domain. Never in the fragment.
//   --url <url>      public address of the site, used in the canonical link and in the link-preview tags.
//                    Default: https://vic3chains.vercel.app/
//
// The site folder also holds og.png (1200x630), the image shown when the link is pasted somewhere. It is a screenshot
// of the page, made separately; this script never touches it and only warns when it is missing.
//
// Icons: read straight from the game's .dds files (field `texture` in common/goods, `icon` in common/buildings),
// decoded here (uncompressed BGRA, DXT1, DXT5), shrunk to 40 px and embedded as PNG data URIs. No external tool.
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const G = (opt('--game') || process.env.VIC3_GAME || 'C:/Program Files (x86)/Steam/steamapps/common/Victoria 3/game').replace(/\\/g, '/');
const SITE = opt('--site');
const VERIFICA = args.includes('--verify') || args.includes('--verifica'); // the old spelling still works
const LANG_FRAG = opt('--lang') || 'pt';
const REPO = 'https://github.com/isaacbatst/vic3chains';
const ANALYTICS = !args.includes('--no-analytics');
const URL_SITE = (opt('--url') || 'https://vic3chains.vercel.app/').replace(/\/*$/, '/');
const MODELO = path.join(__dirname, 'template.html');
const SAIDA = path.join(__dirname, 'preview.html');
if (!fs.existsSync(path.join(G, 'common/buildings'))) { console.error('Game folder not found: ' + G + '\nPass --game <path> or set VIC3_GAME.'); process.exit(1); }

let save = null;
if (opt('--save')) { save = JSON.parse(fs.readFileSync(opt('--save'), 'utf8')); if (!Array.isArray(save.techs)) throw new Error('--save: missing "techs" array'); }
let versao = '?';
try { versao = JSON.parse(fs.readFileSync(path.join(G, '../launcher/launcher-settings.json'), 'utf8')).rawVersion || '?'; } catch (e) { /* keeps "?" */ }

// ---------- Paradox script parser ----------
function parse(txt) {
  txt = txt.replace(/^\uFEFF/, '');
  const toks = []; const re = /#[^\n]*|"[^"]*"|[{}]|[<>]?=|[^\s{}=#"<>]+/g; let m;
  while ((m = re.exec(txt))) { if (m[0][0] === '#') continue; toks.push(m[0]); }
  let i = 0;
  function block() {
    const out = [];
    while (i < toks.length && toks[i] !== '}') {
      const k = toks[i++];
      if (/^[<>]?=$/.test(toks[i])) { i++; let v; if (toks[i] === '{') { i++; v = block(); i++; } else v = toks[i++]; out.push([k, v]); }
      else if (k === '{') { const v = block(); i++; out.push([null, v]); }
      else out.push([k, null]);
    }
    return out;
  }
  return block();
}
function loadDir(d) { let all = []; for (const f of fs.readdirSync(path.join(G, d)).sort()) { if (!f.endsWith('.txt')) continue; for (const e of parse(fs.readFileSync(path.join(G, d, f), 'utf8'))) all.push([...e, f]); } return all; }
const get = (b, k) => { const e = b.find((x) => x[0] === k); return e ? e[1] : undefined; };
const list = (v) => (Array.isArray(v) ? v.map((x) => x[0]) : []);

// ---------- structure (language-independent) ----------
// building category = the file the building is defined in; the page has its own names for them
const CATS = [[/industry/, 'industry'], [/agro/, 'agro'], [/mines/, 'mines'], [/plantation/, 'plantations'], [/misc_resource/, 'resources'],
  [/private_infrastructure/, 'infrastructure'], [/urban/, 'urban'], [/government/, 'government'], [/military/, 'military'],
  [/construction/, 'construction'], [/subsistence/, 'subsistence'], [/canal/, 'canals'], [/monument/, 'monuments'], [/compan/, 'companies']];
const HIDDEN = ['subsistence', 'canals', 'monuments', 'companies'];
const catOf = (f) => (CATS.find(([re]) => re.test(f)) || [null, 'other'])[1];
// effects that are not goods, shown in neutral text after the recipe
const EFFECTS = { state_infrastructure_add: 'infrastructure', country_weekly_innovation_add: 'innovation', country_bureaucracy_add: 'bureaucracy',
  country_tax_capacity_add: 'tax', state_tax_capacity_add: 'tax', state_trade_capacity_add: 'trade', country_construction_add: 'construction',
  country_ship_construction_add: 'ship', country_minting_add: 'minting', country_influence_add: 'influence', country_authority_add: 'authority',
  country_prestige_add: 'prestige', country_convoys_capacity_add: 'convoys' };

const Bd = loadDir('common/buildings'), PG = loadDir('common/production_method_groups'), PM = loadDir('common/production_methods'), TE = loadDir('common/technology/technologies'), GD = loadDir('common/goods');
const pg = {}, pm = {};
for (const e of PG) if (e[1]) pg[e[0]] = e[1];
for (const e of PM) if (e[1]) pm[e[0]] = e[1];

const techs = {}, usados = { tech: new Set(), law: new Set(), pm: new Set(), pmg: new Set() };
const usaTech = (t) => { if (!(t in techs)) { const e = TE.find((x) => x[0] === t); const v = e && Array.isArray(e[1]) ? get(e[1], 'era') : null; techs[t] = v ? Number(String(v).replace('era_', '')) : 0; } usados.tech.add(t); return t; };

function metodo(k) {
  const p = pm[k]; if (!p) return null;
  usados.pm.add(k);
  const i = {}, o = {}, e = [];
  for (const kk of ['building_modifiers', 'country_modifiers', 'state_modifiers']) {
    const mm = get(p, kk); if (!Array.isArray(mm)) continue;
    for (const [sec, v] of mm) for (const [a, b] of (Array.isArray(v) ? v : [[sec, v]])) {
      let m;
      if (kk === 'building_modifiers' && (m = /^goods_input_(.+)_add$/.exec(a))) i[m[1]] = (i[m[1]] || 0) + Number(b);
      else if (kk === 'building_modifiers' && (m = /^goods_output_(.+)_add$/.exec(a))) o[m[1]] = (o[m[1]] || 0) + Number(b);
      else if (EFFECTS[a]) e.push([EFFECTS[a], Number(b)]);
    }
  }
  // conditions the page does not simulate: kept as structured notes, worded per language in the page
  const nt = [], tem = (x) => get(p, x) !== undefined;
  const leis = (x) => list(get(p, x)).map((l) => { usados.law.add(l); return l; });
  const regioes = Array.isArray(get(p, 'unlocking_geographic_regions')) && get(p, 'unlocking_geographic_regions').length > 0;
  if (tem('unlocking_principles')) nt.push(['principle']);
  if (tem('unlocking_identity')) nt.push(['identity']);
  if (tem('unlocking_laws')) nt.push(['law', leis('unlocking_laws')]);
  if (tem('disallowing_laws')) nt.push(['nolaw', leis('disallowing_laws')]);
  if (tem('unlocking_religions') || tem('disallowing_religions')) nt.push(['religion']);
  if (tem('unlocking_company_categories')) nt.push(['company']);
  if (regioes) nt.push(['region']);
  if (tem('required_input_goods')) nt.push(['needs', String(get(p, 'required_input_goods'))]);
  const req = list(get(p, 'unlocking_production_methods'));
  if (req.length) { nt.push(['req', req]); req.forEach((r) => usados.pm.add(r)); }
  const cond = ['unlocking_principles', 'unlocking_identity', 'unlocking_laws', 'unlocking_religions', 'unlocking_company_categories'].some(tem) || regioes;
  const r = { id: k, t: list(get(p, 'unlocking_technologies')).map(usaTech), i, o, req, cond: cond ? 1 : 0, def: get(p, 'is_default') === 'yes' ? 1 : 0 };
  if (e.length) r.e = e;
  if (nt.length) r.nt = nt;
  r._lei = tem('unlocking_laws') || tem('disallowing_laws');
  return r;
}

const blds = [];
for (const [bk, bv, f] of Bd) {
  if (!Array.isArray(bv)) continue;
  const grupos = list(get(bv, 'production_method_groups'));
  if (!grupos.length) continue;
  const gr = [];
  for (const g of grupos) {
    const ms = list(get(pg[g] || [], 'production_methods')).map(metodo).filter(Boolean);
    if (!ms.length) continue;
    usados.pmg.add(g);
    // law: group decided by laws, not by technology
    gr.push({ id: g, law: ms.every((m) => !m.t.length) && ms.some((m) => m._lei) ? 1 : 0, ms: ms.map(({ _lei, ...r }) => r) });
  }
  if (!gr.length) continue;
  blds.push({ id: bk, cat: catOf(f), t: list(get(bv, 'unlocking_technologies')).map(usaTech), nb: get(bv, 'buildable') === 'no' ? 1 : 0, gr, _ic: get(bv, 'icon') });
}
const goods = GD.filter((e) => Array.isArray(e[1])).map((e) => ({ id: e[0], p: Number(get(e[1], 'cost')), c: String(get(e[1], 'category') || ''), _ic: get(e[1], 'texture') }));
const cats = CATS.map((c) => c[1]).filter((c) => blds.some((b) => b.cat === c));
if (save) save.techs.forEach(usaTech);

// ---------- game terms, per language ----------
const LINGUAS = [['en', 'english', 'English', 'en-US'], ['pt', 'braz_por', 'Português (Brasil)', 'pt-BR'], ['es', 'spanish', 'Español', 'es-ES'],
  ['fr', 'french', 'Français', 'fr-FR'], ['de', 'german', 'Deutsch', 'de-DE'], ['pl', 'polish', 'Polski', 'pl-PL'], ['ru', 'russian', 'Русский', 'ru-RU'],
  ['tr', 'turkish', 'Türkçe', 'tr-TR'], ['ja', 'japanese', '日本語', 'ja-JP'], ['ko', 'korean', '한국어', 'ko-KR'], ['zh', 'simp_chinese', '中文', 'zh-CN']]
  .filter((l) => fs.existsSync(path.join(G, 'localization', l[1])));
// names the game repeats or leaves without real text: only applied where the collision exists in that language
const CORRIGE = { pt: { building_motor_industry: 'Indústria de Motores' } };
function lerLoc(pasta) {
  const loc = {};
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.yml')) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([\w.\-]+):\d*\s*"(.*)"\s*$/); if (m && !(m[1] in loc)) loc[m[1]] = m[2]; } } })(path.join(G, 'localization', pasta));
  return loc;
}
const termos = {}, faltas = {}, colisoes = {};
let locEn = null;
for (const [cod, pasta] of LINGUAS) {
  const loc = lerLoc(pasta);
  if (cod === 'en') locEn = loc;
  const limpa = (k) => {
    let t = loc[k]; if (t === undefined) return undefined;
    for (let n = 0; n < 6 && /\$[\w]+\$/.test(t); n++) t = t.replace(/\$([\w]+)\$/g, (m, r) => (loc[r] !== undefined ? loc[r] : locEn && locEn[r] !== undefined ? locEn[r] : ''));
    t = t.replace(/\[[^\]]*\]|#\w+|#!/g, '').replace(/\s+/g, ' ').trim();
    return t || undefined;
  };
  const T = {}; let falta = 0;
  const poe = (chave, k) => { const v = limpa(k); if (v === undefined) falta++; else T[chave] = v; };
  goods.forEach((g) => poe('g:' + g.id, g.id));
  blds.forEach((b) => poe(b.id, b.id));
  usados.pmg.forEach((k) => poe(k, k));
  usados.pm.forEach((k) => poe(k, k));
  usados.tech.forEach((k) => poe('t:' + k, k));
  usados.law.forEach((k) => poe(k, k));
  // buildings: scenery monuments have a developer note instead of a name; a few buildings share one name
  const nomes = {};
  blds.forEach((b) => { if (T[b.id] && T[b.id].length > 60) delete T[b.id]; if (T[b.id]) (nomes[T[b.id]] = nomes[T[b.id]] || []).push(b.id); });
  const col = [];
  for (const n in nomes) if (nomes[n].length > 1) {
    col.push(nomes[n].join('='));
    nomes[n].forEach((id, i) => {
      const fix = (CORRIGE[cod] || {})[id], et = /_(\d)$/.exec(id);
      if (fix) T[id] = fix;
      else if (nomes[n].includes('building_motor_industry')) { if (id === 'building_motor_industry' && cod !== 'en') T[id] = termos.en[id]; } // the motor one takes the English name; the automotive one keeps its own
      else if (et) T[id] = n + ' ' + et[1];
      else if (i > 0 && cod !== 'en' && termos.en && termos.en[id] && !Object.values(T).includes(termos.en[id])) T[id] = termos.en[id]; // falls back to the English name, which is distinct
      else if (i > 0) T[id] = n + ' (' + (i + 1) + ')';
    });
  }
  // English is the fallback of every language: there, a missing building name becomes a readable key
  if (cod === 'en') blds.forEach((b) => { if (!T[b.id]) T[b.id] = b.id.replace(/^building_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); });
  termos[cod] = T; faltas[cod] = falta; colisoes[cod] = col;
}
// drop what equals English (the page falls back to it), to keep the dictionaries small
for (const [cod] of LINGUAS) if (cod !== 'en') for (const k in termos[cod]) if (termos[cod][k] === termos.en[k]) delete termos[cod][k];

// ---------- icons: game .dds -> 40x40 PNG data URI ----------
const LADO = 40;
function lerDDS(p) {
  const b = fs.readFileSync(p);
  if (b.toString('ascii', 0, 4) !== 'DDS ') throw new Error('not a DDS');
  const h = b.readUInt32LE(12), w = b.readUInt32LE(16), cc = b.toString('ascii', 84, 88), d = b.subarray(128);
  const px = Buffer.alloc(w * h * 4);
  if (cc === 'DXT1' || cc === 'DXT5') {
    const c565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
    let o = 0;
    for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
      const al = new Array(16).fill(255);
      if (cc === 'DXT5') {
        const a0 = d[o], a1 = d[o + 1]; let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(d[o + 2 + i]) << BigInt(8 * i);
        const t = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) t.push(((7 - i) * a0 + i * a1) / 7); else { for (let i = 1; i < 5; i++) t.push(((5 - i) * a0 + i * a1) / 5); t.push(0, 255); }
        for (let i = 0; i < 16; i++) al[i] = t[Number((bits >> BigInt(3 * i)) & 7n)];
        o += 8;
      }
      const c0 = d.readUInt16LE(o), c1 = d.readUInt16LE(o + 2), idx = d.readUInt32LE(o + 4), a = c565(c0), c = c565(c1); o += 8;
      const pal = [a, c];
      if (cc === 'DXT5' || c0 > c1) pal.push(a.map((v, i) => (2 * v + c[i]) / 3), a.map((v, i) => (v + 2 * c[i]) / 3));
      else pal.push(a.map((v, i) => (v + c[i]) / 2), null);
      for (let i = 0; i < 16; i++) {
        const x = bx + (i & 3), y = by + (i >> 2); if (x >= w || y >= h) continue;
        const col = pal[(idx >>> (2 * i)) & 3], q = (y * w + x) * 4;
        if (!col) { px[q + 3] = 0; continue; }
        px[q] = col[0]; px[q + 1] = col[1]; px[q + 2] = col[2]; px[q + 3] = al[i];
      }
    }
  } else {
    if (b.readUInt32LE(88) !== 32 || b.readUInt32LE(92) !== 0xff0000) throw new Error('unexpected DDS format');
    for (let i = 0; i < w * h; i++) { px[i * 4] = d[i * 4 + 2]; px[i * 4 + 1] = d[i * 4 + 1]; px[i * 4 + 2] = d[i * 4]; px[i * 4 + 3] = d[i * 4 + 3]; }
  }
  return { w, h, px };
}
// area-average downscale with premultiplied alpha, so edges do not darken
function reduz(im, S) {
  const out = Buffer.alloc(S * S * 4);
  for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
    const x0 = dx * im.w / S, x1 = (dx + 1) * im.w / S, y0 = dy * im.h / S, y1 = (dy + 1) * im.h / S;
    let r = 0, g2 = 0, bl = 0, a = 0, tot = 0;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const wgt = (Math.min(x + 1, x1) - Math.max(x, x0)) * (Math.min(y + 1, y1) - Math.max(y, y0)), q = (y * im.w + x) * 4, al = im.px[q + 3] / 255;
      r += im.px[q] * al * wgt; g2 += im.px[q + 1] * al * wgt; bl += im.px[q + 2] * al * wgt; a += al * wgt; tot += wgt;
    }
    const q = (dy * S + dx) * 4;
    if (a > 0) { out[q] = Math.round(r / a); out[q + 1] = Math.round(g2 / a); out[q + 2] = Math.round(bl / a); }
    out[q + 3] = Math.round(255 * a / tot);
  }
  return out;
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(rgba, S) {
  const bloco = (tipo, dadosB) => { const len = Buffer.alloc(4); len.writeUInt32BE(dadosB.length); const td = Buffer.concat([Buffer.from(tipo, 'ascii'), dadosB]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloco('IHDR', ihdr), bloco('IDAT', zlib.deflateSync(raw, { level: 9 })), bloco('IEND', Buffer.alloc(0))]);
}
const icones = {}; const semIcone = []; let bytesIc = 0;
const iconeDe = (chave, rel) => {
  if (!rel) { semIcone.push(chave); return; }
  try { const p = png(reduz(lerDDS(path.join(G, String(rel).replace(/"/g, ''))), LADO), LADO); bytesIc += p.length; icones[chave] = 'data:image/png;base64,' + p.toString('base64'); }
  catch (e) { semIcone.push(chave + ' (' + e.message + ')'); }
};
for (const x of goods) { iconeDe('g:' + x.id, x._ic); delete x._ic; }
for (const x of blds) { iconeDe('b:' + x.id, x._ic); delete x._ic; }

// ---------- output ----------
const hoje = new Date().toISOString().slice(0, 10);
const base = { versao, gerado: hoje, repo: REPO, techs, goods, cats, ocultas: HIDDEN, blds, icones, linguas: LINGUAS.map((l) => [l[0], l[2], l[3]]), termos };
const modelo = fs.readFileSync(MODELO, 'utf8');
if (!modelo.includes('/*DADOS*/')) throw new Error('marker /*DADOS*/ not found in the template');
const monta = (extra) => modelo.replace('/*DADOS*/', () => JSON.stringify({ ...base, ...extra }).replace(/</g, '\\u003c'));

fs.writeFileSync(SAIDA, monta({ site: 0, lingua: LANG_FRAG, save: save ? { label: String(save.label || ''), techs: save.techs } : null }));
const nMet = blds.reduce((s, b) => s + b.gr.reduce((t, g) => t + g.ms.length, 0), 0);
console.log(`game ${versao} at ${G}`);
console.log(`${blds.length} buildings, ${nMet} methods, ${goods.length} goods, ${Object.keys(techs).length} technologies; icons: ${Object.keys(icones).length} (${(bytesIc / 1024).toFixed(0)} KB PNG), ${semIcone.length} without icon`);
console.log('languages: ' + LINGUAS.map((l) => `${l[0]} (${Object.keys(termos[l[0]]).length} terms${l[0] === 'en' ? '' : ' differing from en'}, ${faltas[l[0]]} missing${colisoes[l[0]].length ? ', name collisions: ' + colisoes[l[0]].length : ''})`).join('; '));
console.log('motor/automotive collision: ' + (LINGUAS.filter((l) => colisoes[l[0]].some((c) => /building_motor_industry/.test(c))).map((l) => l[0]).join(', ') || 'none'));
console.log(`fragment: ${SAIDA} (${(fs.statSync(SAIDA).size / 1024).toFixed(0)} KB${save ? ', with save "' + save.label + '"' : ', no save'}, default language ${LANG_FRAG})`);

if (SITE) {
  // public build: full document, every language, no personal save
  const frag = monta({ site: 1, analytics: ANALYTICS ? 1 : 0, lingua: '', save: null });
  const pega = (re) => { const m = re.exec(frag); return m ? m[0] : ''; };
  const link = pega(/<link[^>]*>/), estilo = pega(/<style>[\s\S]*?<\/style>/);
  const corpo = frag.replace(/<title>[\s\S]*?<\/title>/, '').replace(link, '').replace(estilo, '');
  const DESC = 'Interactive map of every production chain in Victoria 3: all buildings, goods and production methods, in 11 languages. Fan-made.';
  // favicon: three linked nodes, in the colors of the page (a building block, a good, another block)
  const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#171717"/><path d="M10 10 L16 22 M22 10 L16 22" stroke="#a3a3a3" stroke-width="2" fill="none"/><rect x="4" y="5" width="11" height="9" rx="2.5" fill="#7c3aed"/><rect x="17" y="5" width="11" height="9" rx="2.5" fill="#4d7c0f"/><circle cx="16" cy="23" r="5" fill="#fafafa"/></svg>');
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Victoria 3 Production Graph</title>
<meta name="description" content="${DESC}">
<link rel="canonical" href="${URL_SITE}">
<meta property="og:type" content="website">
<meta property="og:title" content="Victoria 3 Production Graph">
<meta property="og:description" content="${DESC}">
<meta property="og:url" content="${URL_SITE}">
<meta property="og:image" content="${URL_SITE}og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171717" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${link}
<style>
:root { color-scheme: light; padding: env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px); box-sizing: border-box; }
body { margin: 0; font: 14px system-ui, sans-serif; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
${estilo}
</head>
<body>
${corpo.trim()}
${ANALYTICS ? '<script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>\n<script defer src="/_vercel/insights/script.js"></script>' : ''}
</body>
</html>
`;
  fs.mkdirSync(SITE, { recursive: true });
  const alvo = path.join(SITE, 'index.html');
  fs.writeFileSync(alvo, doc);
  if (!fs.existsSync(path.join(SITE, 'og.png'))) console.log('warning: ' + path.join(SITE, 'og.png') + ' is missing (link-preview image, 1200x630)');
  console.log(`site: ${alvo} (${(fs.statSync(alvo).size / 1024).toFixed(0)} KB; dictionaries ${(Buffer.byteLength(JSON.stringify(termos)) / 1024).toFixed(0)} KB, icons ${(Buffer.byteLength(JSON.stringify(icones)) / 1024).toFixed(0)} KB)`);
}

if (VERIFICA) {
  const Bm = Object.fromEntries(blds.map((b) => [b.id, b]));
  const soma = (bid, escolhas) => {
    const b = Bm[bid], i = {}, o = {};
    b.gr.forEach((g) => {
      const m = g.ms.find((x) => escolhas.includes(x.id)) || g.ms[0];
      for (const k in m.i) i[k] = (i[k] || 0) + m.i[k];
      for (const k in m.o) o[k] = (o[k] || 0) + m.o[k];
    });
    const f = (x) => Object.entries(x).filter(([, q]) => q > 1e-9).map(([k, q]) => q + ' ' + k).sort().join(' + ');
    return f(i) + ' -> ' + f(o);
  };
  const casos = [
    ['building_steel_mill', [], '30 coal + 40 iron -> 65 steel'],
    ['building_food_industry', ['pm_sweeteners', 'pm_pot_stills'], '40 grain + 40 sugar -> 35 groceries + 60 liquor'],
    ['building_furniture_manufactory', ['pm_lathe', 'pm_luxury_furniture'], '10 fabric + 15 hardwood + 15 wood + 5 tools -> 25 luxury_furniture + 40 furniture'],
  ];
  let falhas = 0;
  for (const [bid, esc, esperado] of casos) {
    const r = soma(bid, esc); const ok = r === esperado; if (!ok) falhas++;
    console.log((ok ? 'OK    ' : 'DIFFER ') + termos.en[bid] + ' [' + (esc.map((k) => termos.en[k]).join(' + ') || 'basic') + ']: ' + r + (ok ? '' : '   (expected: ' + esperado + ')'));
  }
  process.exitCode = falhas ? 1 : 0;
}
