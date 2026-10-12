// Victoria 3 production graph: reads the installed game and writes the page with all data embedded.
//
//   node generate.cjs                         body-only preview fragment        -> preview.html (next to this file)
//   node generate.cjs --site <dir>            also a public, self-contained     -> <dir>/index.html
//   node generate.cjs --verify                also checks three known recipes
//
// Options
//   --game <path>    game folder (the one that has common/, localization/, gfx/). Also: env VIC3_GAME.
//                    Default: the usual Steam path on Windows.
//   --mod <path>     a mod folder (the one that has common/ and .metadata/) read on top of the game. The fragment then goes to
//                    preview.<mod id>.html, and the page keeps its own saved choices, apart from the vanilla page.
//   --mod-url <url>  where the mod lives (Workshop page or repository), linked from the page's credits.
//   --variants <l>   with --site: the pages of this site, as "Label=folder" separated by commas, the vanilla one first with an
//                    empty folder, e.g. "Vanilla=,Tech & Res=techres". Each page then gets a menu to go to the others. The
//                    page being built is the one whose label is the mod's name, or the first one when there is no --mod.
//                    (Folders are written without slashes so that Git Bash on Windows does not rewrite them as paths.)
//   --todo <codes>   with --mod: writes translations/<mod id>/<code>.todo.json, the English mod terms that language still lacks.
//                    Several codes go separated by commas; "all" means every language but English.
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
const GAME = (opt('--game') || process.env.VIC3_GAME || 'C:/Program Files (x86)/Steam/steamapps/common/Victoria 3/game').replace(/\\/g, '/');
const MOD = opt('--mod') ? opt('--mod').replace(/\\/g, '/') : null;
const SITE = opt('--site');
const VERIFY = args.includes('--verify') || args.includes('--verifica'); // the old spelling still works
const PREVIEW_LANG = opt('--lang') || 'pt';
const REPO = 'https://github.com/isaacbatst/vic3chains';
const ANALYTICS = !args.includes('--no-analytics');
const SITE_URL = (opt('--url') || 'https://vic3chains.vercel.app/').replace(/\/*$/, '/');
const TEMPLATE = path.join(__dirname, 'template.html');
if (!fs.existsSync(path.join(GAME, 'common/buildings'))) { console.error('Game folder not found: ' + GAME + '\nPass --game <path> or set VIC3_GAME.'); process.exit(1); }
if (MOD && !fs.existsSync(path.join(MOD, 'common'))) { console.error('Mod folder not found: ' + MOD); process.exit(1); }
let mod = null;
if (MOD) {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(MOD, '.metadata/metadata.json'), 'utf8')); } catch (e) { /* keeps the folder name */ }
  // the Workshop name starts with the game version in brackets ("[1.13] Tech & Res")
  mod = { id: String(meta.id || path.basename(MOD)).replace(/[^\w.-]+/g, '-'), name: String(meta.name || path.basename(MOD)).replace(/^\[[^\]]*\]\s*/, ''), version: String(meta.version || '').replace(/[^\w.]+$/, ''), url: opt('--mod-url') || '' };
}
// where files are looked up: the mod first, then the game
const ROOTS = MOD ? [MOD, GAME] : [GAME];
const PREVIEW_OUT = path.join(__dirname, mod ? 'preview.' + mod.id + '.html' : 'preview.html');

let save = null;
if (opt('--save')) { save = JSON.parse(fs.readFileSync(opt('--save'), 'utf8')); if (!Array.isArray(save.techs)) throw new Error('--save: missing "techs" array'); }
let gameVersion = '?';
try { gameVersion = JSON.parse(fs.readFileSync(path.join(GAME, '../launcher/launcher-settings.json'), 'utf8')).rawVersion || '?'; } catch (e) { /* keeps "?" */ }

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
// Definitions of one folder, as [key, value, file]. With a mod, its files are read on top of the game's, the way the game does it:
// a mod file named like a game file replaces it; a key defined again (plain, REPLACE: or REPLACE_OR_CREATE:) replaces the definition;
// INJECT: adds to it (a block grows, a single value is overwritten). The file stays the one of the first definition.
function inject(target, extra) {
  for (const [k, v] of extra) {
    const e = k === null ? null : target.find((x) => x[0] === k);
    if (e && Array.isArray(e[1]) && Array.isArray(v)) e[1].push(...v); else if (e && v !== null) e[1] = v; else target.push([k, v]);
  }
}
function loadDir(d) {
  const files = new Map();
  for (const root of [...ROOTS].reverse()) { const dir = path.join(root, d); if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.txt')) files.set(f, path.join(dir, f)); }
  const defs = new Map(), loose = [];
  for (const f of [...files.keys()].sort()) for (const [k0, v] of parse(fs.readFileSync(files.get(f), 'utf8'))) {
    if (k0 === null) { loose.push([k0, v, f]); continue; }
    const m = /^(?:TRY_)?(INJECT|REPLACE|REPLACE_OR_CREATE|INJECT_OR_CREATE):(.+)$/.exec(k0), k = m ? m[2] : k0, old = defs.get(k);
    if (m && m[1].startsWith('INJECT') && old && Array.isArray(old[1]) && Array.isArray(v)) inject(old[1], v);
    else defs.set(k, [k, v, old ? old[2] : f]);
  }
  return [...defs.values(), ...loose];
}
const get = (b, k) => { const e = b.find((x) => x[0] === k); return e ? e[1] : undefined; };
const list = (v) => (Array.isArray(v) ? v.map((x) => x[0]) : []);

// ---------- structure (language-independent) ----------
// building category = the file the building is defined in; the page has its own names for them
const CATEGORIES = [[/industry/, 'industry'], [/agro/, 'agro'], [/mines/, 'mines'], [/plantation/, 'plantations'], [/misc_resource/, 'resources'],
  [/private_infrastructure/, 'infrastructure'], [/urban/, 'urban'], [/government/, 'government'], [/military/, 'military'],
  [/construction/, 'construction'], [/subsistence/, 'subsistence'], [/canal/, 'canals'], [/monument/, 'monuments'], [/compan/, 'companies']];
const HIDDEN = ['subsistence', 'canals', 'monuments', 'companies'];
const fileCategory = (f) => (CATEGORIES.find(([re]) => re.test(f)) || [null, null])[1];
// effects that are not goods, shown in neutral text after the recipe
const EFFECTS = { state_infrastructure_add: 'infrastructure', country_weekly_innovation_add: 'innovation', country_bureaucracy_add: 'bureaucracy',
  country_tax_capacity_add: 'tax', state_tax_capacity_add: 'tax', state_trade_capacity_add: 'trade', country_construction_add: 'construction',
  country_ship_construction_add: 'ship', country_minting_add: 'minting', country_influence_add: 'influence', country_authority_add: 'authority',
  country_prestige_add: 'prestige', country_convoys_capacity_add: 'convoys' };

const buildingDefs = loadDir('common/buildings'), buildingGroupDefs = loadDir('common/building_groups'), groupDefs = loadDir('common/production_method_groups'), methodDefs = loadDir('common/production_methods'), techDefs = loadDir('common/technology/technologies'), goodDefs = loadDir('common/goods');
const groupByKey = {}, methodByKey = {};
for (const e of groupDefs) if (e[1]) groupByKey[e[0]] = e[1];
for (const e of methodDefs) if (e[1]) methodByKey[e[0]] = e[1];

const techs = {}, used = { tech: new Set(), laws: new Set(), pmKeys: new Set(), pmgKeys: new Set() };
const useTech = (t) => { if (!(t in techs)) { const e = techDefs.find((x) => x[0] === t); const v = e && Array.isArray(e[1]) ? get(e[1], 'era') : null; techs[t] = v ? Number(String(v).replace('era_', '')) : 0; } used.tech.add(t); return t; };

function readMethod(k) {
  const p = methodByKey[k]; if (!p) return null;
  used.pmKeys.add(k);
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
  const notes = [], has = (x) => get(p, x) !== undefined;
  const lawsOf = (x) => list(get(p, x)).map((l) => { used.laws.add(l); return l; });
  const hasRegions = Array.isArray(get(p, 'unlocking_geographic_regions')) && get(p, 'unlocking_geographic_regions').length > 0;
  if (has('unlocking_principles')) notes.push(['principle']);
  if (has('unlocking_identity')) notes.push(['identity']);
  if (has('unlocking_laws')) notes.push(['law', lawsOf('unlocking_laws')]);
  if (has('disallowing_laws')) notes.push(['nolaw', lawsOf('disallowing_laws')]);
  if (has('unlocking_religions') || has('disallowing_religions')) notes.push(['religion']);
  if (has('unlocking_company_categories')) notes.push(['company']);
  if (hasRegions) notes.push(['region']);
  if (has('required_input_goods')) notes.push(['needs', String(get(p, 'required_input_goods'))]);
  const requires = list(get(p, 'unlocking_production_methods'));
  if (requires.length) { notes.push(['req', requires]); requires.forEach((r) => used.pmKeys.add(r)); }
  const conditional = ['unlocking_principles', 'unlocking_identity', 'unlocking_laws', 'unlocking_religions', 'unlocking_company_categories'].some(has) || hasRegions;
  const r = { id: k, tech: list(get(p, 'unlocking_technologies')).map(useTech), inputs: i, outputs: o, requires, conditional: conditional ? 1 : 0, isDefault: get(p, 'is_default') === 'yes' ? 1 : 0 };
  if (e.length) r.effects = e;
  if (notes.length) r.notes = notes;
  r._law = has('unlocking_laws') || has('disallowing_laws');
  return r;
}

// A building in a file the list above does not know (a mod's own files) takes the category of the game buildings that share its
// building group, or the nearest parent group that has any.
const parentGroup = {}, groupVotes = {};
for (const [k, v] of buildingGroupDefs) if (Array.isArray(v)) parentGroup[k] = get(v, 'parent_group');
const groupChain = (bv) => { const out = []; for (let g = get(bv, 'building_group'); g && !out.includes(g); g = parentGroup[g]) out.push(g); return out; };
for (const [, bv, f] of buildingDefs) { const c = Array.isArray(bv) && fileCategory(f); if (c) for (const g of groupChain(bv)) (groupVotes[g] = groupVotes[g] || {})[c] = (groupVotes[g][c] || 0) + 1; }
const catOf = (f, bv) => {
  const c = fileCategory(f); if (c) return c;
  for (const g of groupChain(bv)) if (groupVotes[g]) return Object.entries(groupVotes[g]).sort((a, b) => b[1] - a[1])[0][0];
  return 'other';
};

const buildings = [];
for (const [bk, bv, f] of buildingDefs) {
  if (!Array.isArray(bv)) continue;
  const groupKeys = list(get(bv, 'production_method_groups'));
  if (!groupKeys.length) continue;
  const groups = [];
  for (const g of groupKeys) {
    const methods = list(get(groupByKey[g] || [], 'production_methods')).map(readMethod).filter(Boolean);
    if (!methods.length) continue;
    used.pmgKeys.add(g);
    // law: group decided by laws, not by technology
    groups.push({ id: g, lawDriven: methods.every((m) => !m.tech.length) && methods.some((m) => m._law) ? 1 : 0, methods: methods.map(({ _law, ...r }) => r) });
  }
  if (!groups.length) continue;
  buildings.push({ id: bk, category: catOf(f, bv), tech: list(get(bv, 'unlocking_technologies')).map(useTech), notBuildable: get(bv, 'buildable') === 'no' ? 1 : 0, groups, _icon: get(bv, 'icon') });
}
const goods = goodDefs.filter((e) => Array.isArray(e[1])).map((e) => ({ id: e[0], price: Number(get(e[1], 'cost')), kind: String(get(e[1], 'category') || ''), _icon: get(e[1], 'texture') }));
const categories = CATEGORIES.map((c) => c[1]).filter((c) => buildings.some((b) => b.category === c));
if (save) save.techs.forEach(useTech);

// ---------- game terms, per language ----------
const LANGUAGES = [['en', 'english', 'English', 'en-US'], ['pt', 'braz_por', 'Português (Brasil)', 'pt-BR'], ['es', 'spanish', 'Español', 'es-ES'],
  ['fr', 'french', 'Français', 'fr-FR'], ['de', 'german', 'Deutsch', 'de-DE'], ['pl', 'polish', 'Polski', 'pl-PL'], ['ru', 'russian', 'Русский', 'ru-RU'],
  ['tr', 'turkish', 'Türkçe', 'tr-TR'], ['ja', 'japanese', '日本語', 'ja-JP'], ['ko', 'korean', '한국어', 'ko-KR'], ['zh', 'simp_chinese', '中文', 'zh-CN']]
  .filter((l) => fs.existsSync(path.join(GAME, 'localization', l[1])));
// names the game repeats or leaves without real text: only applied where the collision exists in that language
const NAME_FIXES = { pt: { building_motor_industry: 'Indústria de Motores' } };
// fromMod collects the keys whose text comes from the mod
function readLocalization(folder, fromMod) {
  const loc = {};
  for (const root of ROOTS) { const dir = path.join(root, 'localization', folder); if (fs.existsSync(dir)) (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.yml')) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([\w.\-]+):\d*\s*"(.*)"\s*(?:#.*)?$/); if (m && !(m[1] in loc)) { loc[m[1]] = m[2]; if (root === MOD) fromMod.add(m[1]); } } } })(dir); }
  return loc;
}
// A mod often ships its other languages as copies of the English text. Such a term takes, in this order: the translation in
// translations/<mod id>/<code>.json (English text -> translated text, machine-made), then the game's own translation of a game
// term with the same English text. Otherwise it stays in English.
const TRANSLATIONS = mod ? path.join(__dirname, 'translations', mod.id) : null;
const machine = {}, untranslated = {};
const terms = {}, missingByLang = {}, collisions = {};
let englishLoc = null;
for (const [code, folder] of LANGUAGES) {
  const fromMod = new Set(), modTerms = new Set();
  const loc = readLocalization(folder, fromMod);
  if (code === 'en') englishLoc = loc;
  const clean = (k) => {
    let t = loc[k]; if (t === undefined) return undefined;
    for (let n = 0; n < 6 && /\$[\w]+\$/.test(t); n++) t = t.replace(/\$([\w]+)\$/g, (m, r) => (loc[r] !== undefined ? loc[r] : englishLoc && englishLoc[r] !== undefined ? englishLoc[r] : ''));
    t = t.replace(/\[[^\]]*\]|#\w+|#!/g, '').replace(/\s+/g, ' ').trim();
    return t || undefined;
  };
  const dict = {}; let missing = 0;
  const put = (key, k) => { const v = clean(k); if (v === undefined) missing++; else { dict[key] = v; if (fromMod.has(k)) modTerms.add(key); } };
  goods.forEach((g) => put('g:' + g.id, g.id));
  buildings.forEach((b) => put(b.id, b.id));
  used.pmgKeys.forEach((k) => put(k, k));
  used.pmKeys.forEach((k) => put(k, k));
  used.tech.forEach((k) => put('t:' + k, k));
  used.laws.forEach((k) => put(k, k));
  if (mod && code !== 'en') {
    const file = path.join(TRANSLATIONS, code + '.json'), made = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}, own = {}, left = new Set();
    for (const key in dict) if (!modTerms.has(key) && terms.en[key] && dict[key] !== terms.en[key]) own[terms.en[key]] = dict[key];
    let n = 0;
    for (const key of modTerms) {
      const en = terms.en[key]; if (!en || dict[key] !== en) continue;
      if (made[en]) { dict[key] = made[en]; n++; } else if (own[en]) dict[key] = own[en]; else left.add(en);
    }
    if (n) machine[code] = n;
    untranslated[code] = [...left].sort();
  }
  // buildings: scenery monuments have a developer note instead of a name; a few buildings share one name
  const names = {};
  buildings.forEach((b) => { if (dict[b.id] && dict[b.id].length > 60) delete dict[b.id]; if (dict[b.id]) (names[dict[b.id]] = names[dict[b.id]] || []).push(b.id); });
  const col = [];
  for (const n in names) if (names[n].length > 1) {
    col.push(names[n].join('='));
    names[n].forEach((id, i) => {
      const fix = (NAME_FIXES[code] || {})[id], et = /_(\d)$/.exec(id);
      if (fix) dict[id] = fix;
      else if (names[n].includes('building_motor_industry')) { if (id === 'building_motor_industry' && code !== 'en') dict[id] = terms.en[id]; } // the motor one takes the English name; the automotive one keeps its own
      else if (et) dict[id] = n + ' ' + et[1];
      else if (i > 0 && code !== 'en' && terms.en && terms.en[id] && !Object.values(dict).includes(terms.en[id])) dict[id] = terms.en[id]; // falls back to the English name, which is distinct
      else if (i > 0) dict[id] = n + ' (' + (i + 1) + ')';
    });
  }
  // English is the fallback of every language: there, a missing building name becomes a readable key
  if (code === 'en') buildings.forEach((b) => { if (!dict[b.id]) dict[b.id] = b.id.replace(/^building_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); });
  terms[code] = dict; missingByLang[code] = missing; collisions[code] = col;
}
// drop what equals English (the page falls back to it), to keep the dictionaries small
for (const [code] of LANGUAGES) if (code !== 'en') for (const k in terms[code]) if (terms[code][k] === terms.en[k]) delete terms[code][k];

// ---------- icons: game .dds -> 40x40 PNG data URI ----------
const ICON_SIZE = 40;
// BC7 (DXGI formats 98 and 99), which mod icons often use. Per mode: subsets, rotation bits, index-selection bits, color bits,
// alpha bits, p-bits (0 none, 1 one per endpoint, 2 one per subset), index bits, bits of the second index set.
// Modes 0 and 2 (three subsets) are left out: no icon read so far uses them.
const BC7_MODES = { 1: [2, 0, 0, 6, 0, 2, 3, 0], 3: [2, 0, 0, 7, 0, 1, 2, 0], 4: [1, 2, 1, 5, 6, 0, 2, 3], 5: [1, 2, 0, 7, 8, 0, 2, 2], 6: [1, 0, 0, 7, 7, 1, 4, 0], 7: [2, 0, 0, 5, 5, 1, 2, 0] };
// the 64 two-subset partitions (bit i = subset of pixel i) and the anchor pixel of the second subset in each
const BC7_PARTITIONS = 'cccc8888eeeeecc8c880feecfec8ec80c800ffecfe80e800ffe8ff00fff0f000f710008e710008ce008c731031008cce088c31106666366c17e80ff0718e399caaaaf0f05a5a33cc3c3c55aa9696a55a73ce13c8324c3bdc6996c33c99660660027204e44e402720c936936c39c6639c93369cc6817ee718ccf00fcc7744ee22'.match(/.{4}/g).map((x) => parseInt(x, 16));
const BC7_ANCHORS = [...'fffffffffffffffff282288f28228822ff6828ff28222ff66268ff22fffff22f'].map((x) => parseInt(x, 16));
const BC7_WEIGHTS = { 2: [0, 21, 43, 64], 3: [0, 9, 18, 27, 37, 46, 55, 64], 4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64] };
function decodeBC7(d, w, h, px) {
  let o = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    let pos = o * 8; o += 16;
    const bits = (n) => { let v = 0; for (let i = 0; i < n; i++, pos++) v |= ((d[pos >> 3] >> (pos & 7)) & 1) << i; return v; };
    let mode = 0; while (mode < 8 && !bits(1)) mode++;
    if (!BC7_MODES[mode]) throw new Error('BC7 mode ' + mode + ' not supported');
    const [subsets, rotBits, selBits, cb, ab, pMode, ib, ib2] = BC7_MODES[mode];
    const part = subsets === 2 ? bits(6) : 0, rot = bits(rotBits), sel = bits(selBits);
    const ep = []; for (let i = 0; i < subsets * 2; i++) ep.push([0, 0, 0, 255]);
    for (let c = 0; c < (ab ? 4 : 3); c++) for (const e of ep) e[c] = bits(c === 3 ? ab : cb);
    const pb = pMode === 1 ? ep.map(() => bits(1)) : pMode === 2 ? [bits(1), bits(1)] : null;
    ep.forEach((e, i) => { for (let c = 0; c < (ab ? 4 : 3); c++) {
      let v = e[c], prec = c === 3 ? ab : cb;
      if (pb) { v = (v << 1) | pb[pMode === 1 ? i : i >> 1]; prec++; }
      v <<= 8 - prec; e[c] = v | (v >> prec);
    } });
    const mask = subsets === 2 ? BC7_PARTITIONS[part] : 0, anchor = subsets === 2 ? BC7_ANCHORS[part] : -1, i1 = [], i2 = [];
    for (let i = 0; i < 16; i++) i1.push(bits(i === 0 || i === anchor ? ib - 1 : ib));
    if (ib2) for (let i = 0; i < 16; i++) i2.push(bits(i === 0 ? ib2 - 1 : ib2));
    for (let i = 0; i < 16; i++) {
      const x = bx + (i & 3), y = by + (i >> 2); if (x >= w || y >= h) continue;
      const s = ((mask >> i) & 1) * 2, e0 = ep[s], e1 = ep[s + 1];
      let ci = i1[i], cn = ib, ai = ib2 ? i2[i] : i1[i], an = ib2 || ib;
      if (sel) { [ci, ai] = [ai, ci]; [cn, an] = [an, cn]; }
      const mix = (c, idx, n) => { const wt = BC7_WEIGHTS[n][idx]; return ((64 - wt) * e0[c] + wt * e1[c] + 32) >> 6; };
      const out = [mix(0, ci, cn), mix(1, ci, cn), mix(2, ci, cn), mix(3, ai, an)];
      if (rot) { const t = out[3]; out[3] = out[rot - 1]; out[rot - 1] = t; }
      px.set(out, (y * w + x) * 4);
    }
  }
}
// 8-bit RGBA PNG, not interlaced
function readPNG(b) {
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), line = w * 4;
  if (b[24] !== 8 || b[25] !== 6 || b[28] !== 0) throw new Error('unexpected PNG format');
  const parts = [];
  for (let o = 8; o + 12 <= b.length;) { const len = b.readUInt32BE(o); if (b.toString('ascii', o + 4, o + 8) === 'IDAT') parts.push(b.subarray(o + 8, o + 8 + len)); o += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(parts)), px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (line + 1)];
    for (let x = 0; x < line; x++) {
      const left = x >= 4 ? px[y * line + x - 4] : 0, up = y ? px[(y - 1) * line + x] : 0, upLeft = y && x >= 4 ? px[(y - 1) * line + x - 4] : 0;
      let pred = 0;
      if (f === 1) pred = left; else if (f === 2) pred = up; else if (f === 3) pred = (left + up) >> 1;
      else if (f === 4) { const p = left + up - upLeft, pa = Math.abs(p - left), pu = Math.abs(p - up), pc = Math.abs(p - upLeft); pred = pa <= pu && pa <= pc ? left : pu <= pc ? up : upLeft; }
      px[y * line + x] = (raw[y * (line + 1) + 1 + x] + pred) & 255;
    }
  }
  return { w, h, px };
}
function readDDS(p) {
  const b = fs.readFileSync(p);
  if (b.readUInt32BE(0) === 0x89504e47) return readPNG(b); // some mods ship a PNG under the .dds name, and the game takes it
  if (b.toString('ascii', 0, 4) !== 'DDS ') throw new Error('not a DDS');
  const h = b.readUInt32LE(12), w = b.readUInt32LE(16), cc = b.toString('ascii', 84, 88), d = b.subarray(128);
  const px = Buffer.alloc(w * h * 4);
  if (cc === 'DX10') {
    const format = b.readUInt32LE(128);
    if (format !== 98 && format !== 99) throw new Error('unexpected DXGI format ' + format);
    decodeBC7(b.subarray(148), w, h, px);
  } else if (cc === 'DXT1' || cc === 'DXT5') {
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
function downscale(im, S) {
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
  const chunk = (type, payload) => { const len = Buffer.alloc(4); len.writeUInt32BE(payload.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), payload]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const icons = {}; const noIcon = []; let iconBytes = 0;
const addIcon = (key, rel) => {
  if (!rel) { noIcon.push(key); return; }
  try { const p = png(downscale(readDDS(ROOTS.map((r) => path.join(r, String(rel).replace(/"/g, ''))).find((p) => fs.existsSync(p)) || path.join(GAME, String(rel).replace(/"/g, ''))), ICON_SIZE), ICON_SIZE); iconBytes += p.length; icons[key] = 'data:image/png;base64,' + p.toString('base64'); }
  catch (e) { noIcon.push(key + ' (' + e.message + ')'); }
};
for (const x of goods) { addIcon('g:' + x.id, x._icon); delete x._icon; }
for (const x of buildings) { addIcon('b:' + x.id, x._icon); delete x._icon; }

// ---------- output ----------
const today = new Date().toISOString().slice(0, 10);
if (mod) mod.machine = Object.keys(machine);
const base = { gameVersion, mod, generatedOn: today, repo: REPO, techs, goods, categories, hiddenCategories: HIDDEN, buildings, icons, languages: LANGUAGES.map((l) => [l[0], l[2], l[3]]), terms };
const template = fs.readFileSync(TEMPLATE, 'utf8');
if (!template.includes('/*DATA*/')) throw new Error('marker /*DATA*/ not found in the template');
const build = (extra) => template.replace('/*DATA*/', () => JSON.stringify({ ...base, ...extra }).replace(/</g, '\\u003c'));

fs.writeFileSync(PREVIEW_OUT, build({ site: 0, language: PREVIEW_LANG, save: save ? { label: String(save.label || ''), techs: save.techs } : null }));
const methodCount = buildings.reduce((s, b) => s + b.groups.reduce((t, g) => t + g.methods.length, 0), 0);
console.log(`game ${gameVersion} at ${GAME}` + (mod ? `; mod ${mod.name} ${mod.version} at ${MOD}` : ''));
console.log(`${buildings.length} buildings, ${methodCount} methods, ${goods.length} goods, ${Object.keys(techs).length} technologies; icons: ${Object.keys(icons).length} (${(iconBytes / 1024).toFixed(0)} KB PNG), ${noIcon.length} without icon`);
console.log('languages: ' + LANGUAGES.map((l) => `${l[0]} (${Object.keys(terms[l[0]]).length} terms${l[0] === 'en' ? '' : ' differing from en'}, ${missingByLang[l[0]]} missing${collisions[l[0]].length ? ', name collisions: ' + collisions[l[0]].length : ''})`).join('; '));
if (mod) console.log('mod terms left in English: ' + LANGUAGES.filter((l) => l[0] !== 'en').map((l) => `${l[0]} ${untranslated[l[0]].length}${machine[l[0]] ? ' (' + machine[l[0]] + ' machine-translated)' : ''}`).join(', '));
if (mod && opt('--todo')) {
  fs.mkdirSync(TRANSLATIONS, { recursive: true });
  for (const code of opt('--todo') === 'all' ? Object.keys(untranslated) : opt('--todo').split(',')) {
    if (!untranslated[code]) throw new Error('--todo: unknown language ' + code);
    fs.writeFileSync(path.join(TRANSLATIONS, code + '.todo.json'), JSON.stringify(untranslated[code], null, 1) + '\n');
    console.log('todo: ' + path.join(TRANSLATIONS, code + '.todo.json') + ' (' + untranslated[code].length + ')');
  }
}
if (mod && noIcon.length) console.log('without icon: ' + noIcon.join(', '));
console.log('motor/automotive collision: ' + (LANGUAGES.filter((l) => collisions[l[0]].some((c) => /building_motor_industry/.test(c))).map((l) => l[0]).join(', ') || 'none'));
console.log(`fragment: ${PREVIEW_OUT} (${(fs.statSync(PREVIEW_OUT).size / 1024).toFixed(0)} KB${save ? ', with save "' + save.label + '"' : ', no save'}, default language ${PREVIEW_LANG})`);

if (SITE) {
  // public build: full document, every language, no personal save
  let variants = null, variant = 0;
  if (opt('--variants')) {
    variants = opt('--variants').split(',').map((x) => { const i = x.lastIndexOf('='); const folder = x.slice(i + 1).trim().replace(/^\/+|\/+$/g, ''); return [x.slice(0, i).trim(), folder ? '/' + folder + '/' : '/']; });
    variant = mod ? variants.findIndex((v) => v[0] === mod.name) : 0;
    if (variants.some((v) => !v[0] || /[:\\ ]/.test(v[1])) || variant < 0) throw new Error('--variants: expected "Label=folder,..." with one label equal to the mod name' + (mod ? ' (' + mod.name + ')' : ''));
  }
  const frag = build({ site: 1, analytics: ANALYTICS ? 1 : 0, language: '', save: null, variants, variant });
  const grab = (re) => { const m = re.exec(frag); return m ? m[0] : ''; };
  const link = grab(/<link[^>]*>/), style = grab(/<style>[\s\S]*?<\/style>/);
  const body = frag.replace(/<title>[\s\S]*?<\/title>/, '').replace(link, '').replace(style, '');
  const TITLE = ('Victoria 3 Production Graph' + (mod ? ': ' + mod.name : '')).replace(/&/g, '&amp;');
  const DESC = `Interactive map of every production chain in Victoria 3${mod ? ' with the ' + mod.name + ' mod' : ''}: all buildings, goods and production methods, in 11 languages. Fan-made.`.replace(/&/g, '&amp;');
  // favicon: three linked nodes, in the colors of the page (a building block, a good, another block)
  const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#171717"/><path d="M10 10 L16 22 M22 10 L16 22" stroke="#a3a3a3" stroke-width="2" fill="none"/><rect x="4" y="5" width="11" height="9" rx="2.5" fill="#7c3aed"/><rect x="17" y="5" width="11" height="9" rx="2.5" fill="#4d7c0f"/><circle cx="16" cy="23" r="5" fill="#fafafa"/></svg>');
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${TITLE}</title>
<meta name="description" content="${DESC}">
<link rel="canonical" href="${SITE_URL}">
<meta property="og:type" content="website">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:url" content="${SITE_URL}">
<meta property="og:image" content="${SITE_URL}og.png">
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
${style}
</head>
<body>
${body.trim()}
${ANALYTICS ? '<script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>\n<script defer src="/_vercel/insights/script.js"></script>' : ''}
</body>
</html>
`;
  fs.mkdirSync(SITE, { recursive: true });
  const target = path.join(SITE, 'index.html');
  fs.writeFileSync(target, doc);
  if (!fs.existsSync(path.join(SITE, 'og.png'))) console.log('warning: ' + path.join(SITE, 'og.png') + ' is missing (link-preview image, 1200x630)');
  console.log(`site: ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB; dictionaries ${(Buffer.byteLength(JSON.stringify(terms)) / 1024).toFixed(0)} KB, icons ${(Buffer.byteLength(JSON.stringify(icons)) / 1024).toFixed(0)} KB)`);
}

if (VERIFY && mod) console.log('--verify skipped: the known recipes are the vanilla ones');
if (VERIFY && !mod) {
  const byId = Object.fromEntries(buildings.map((b) => [b.id, b]));
  const sumRecipe = (bid, choices) => {
    const b = byId[bid], i = {}, o = {};
    b.groups.forEach((g) => {
      const m = g.methods.find((x) => choices.includes(x.id)) || g.methods[0];
      for (const k in m.inputs) i[k] = (i[k] || 0) + m.inputs[k];
      for (const k in m.outputs) o[k] = (o[k] || 0) + m.outputs[k];
    });
    const f = (x) => Object.entries(x).filter(([, q]) => q > 1e-9).map(([k, q]) => q + ' ' + k).sort().join(' + ');
    return f(i) + ' -> ' + f(o);
  };
  const cases = [
    ['building_steel_mill', [], '30 coal + 40 iron -> 65 steel'],
    ['building_food_industry', ['pm_sweeteners', 'pm_pot_stills'], '40 grain + 40 sugar -> 35 groceries + 60 liquor'],
    ['building_furniture_manufactory', ['pm_lathe', 'pm_luxury_furniture'], '10 fabric + 15 hardwood + 15 wood + 5 tools -> 25 luxury_furniture + 40 furniture'],
  ];
  let failures = 0;
  for (const [bid, esc, expected] of cases) {
    const r = sumRecipe(bid, esc); const ok = r === expected; if (!ok) failures++;
    console.log((ok ? 'OK    ' : 'DIFFER ') + terms.en[bid] + ' [' + (esc.map((k) => terms.en[k]).join(' + ') || 'basic') + ']: ' + r + (ok ? '' : '   (expected: ' + expected + ')'));
  }
  process.exitCode = failures ? 1 : 0;
}
