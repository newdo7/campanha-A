require('dotenv').config();
const express = require('express'), path = require('path'), crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser'), QR = require('qrcode'), multer = require('multer'), rateLimit = require('express-rate-limit');

const E = process.env, BUCKET = 'media';
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const Q = async p => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };
const wrap = fn => (q, r, n) => fn(q, r, n).catch(e => { console.error(e.message); r.status(500).json({ error: 'Erro interno.' }); });
const defaults = { title: 'Campanha solidária', subtitle: 'Cada contribuição nos aproxima da cura.', goal: '300000', story: 'Conte aqui a história da campanha pelo painel administrativo.', purpose: 'Explique aqui a finalidade dos valores arrecadados.', thanks: '', pix_key: '', pix_name: '', pix_city: '' };
const S = async () => ({ ...defaults, ...Object.fromEntries((await Q(sb.from('settings').select('*'))).map(r => [r.k, r.v])) });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }), cookieParser());
app.use((q, r, n) => { r.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }); n(); });
app.get('/health', (q, r) => r.send('ok'));
app.get('/uploads/:f', (q, r) => r.redirect(302, `${E.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(q.params.f)}`));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Pix direto na chave (sem gateway) ----------
const MANUAL = () => !E.MP_ACCESS_TOKEN;
const f = (id, v) => id + String(v.length).padStart(2, '0') + v;
const clean = (s, n) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, n);
function normKey(k) { k = String(k).trim(); if (/^[\d\s()+-]+$/.test(k)) { const d = k.replace(/\D/g, ''); return d.length === 11 && !k.includes('+') && !/^\d{3}\.?\d{3}/.test(k) ? '+55' + d : '+' + (d.length <= 11 ? '55' + d : d); } return k; }
function crc(s) { let c = 0xFFFF; for (const ch of Buffer.from(s)) { c ^= ch << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1; c &= 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function brcode(key, name, city, amount) {
  const p = f('00', '01') + f('01', '12') + f('26', f('00', 'br.gov.bcb.pix') + f('01', key)) + f('52', '0000') + f('53', '986') + f('54', amount.toFixed(2)) + f('58', 'BR') + f('59', clean(name, 25) || 'DOACAO') + f('60', clean(city, 15) || 'BRASIL') + f('62', f('05', '***')) + '6304';
  return p + crc(p);
}

// ---------- Pix (Mercado Pago, opcional) ----------
const MP = 'https://api.mercadopago.com';
const mp = (p, o = {}) => fetch(MP + p, { ...o, headers: { Authorization: 'Bearer ' + E.MP_ACCESS_TOKEN, 'Content-Type': 'application/json', ...(o.headers || {}) } }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.message || 'Erro no gateway'); return j; });
const isTest = () => (E.MP_ACCESS_TOKEN || '').startsWith('TEST-');
async function sync(mpId) {
  const p = await mp('/v1/payments/' + mpId);
  const st = p.status === 'approved' ? 'confirmed' : ['rejected', 'cancelled', 'expired'].includes(p.status) ? 'failed' : 'pending';
  await Q(sb.from('donations').update({ status: st }).eq('mp_id', String(mpId)));
  if (st === 'confirmed') await Q(sb.from('donations').update({ paid: new Date().toISOString() }).eq('mp_id', String(mpId)).is('paid', null));
  return st;
}
app.post('/api/donate', rateLimit({ windowMs: 60000, max: 10 }), async (q, r) => {
  try {
    const amount = Math.round(Number(q.body.amount) * 100) / 100, name = String(q.body.name || '').slice(0, 60);
    if (!(amount >= 5 && amount <= 50000)) return r.status(400).json({ error: 'Valor deve ser entre R$ 5 e R$ 50.000.' });
    if (MANUAL()) {
      const s = await S(); if (!s.pix_key) return r.status(503).json({ error: 'Chave Pix ainda não configurada no painel.' });
      const code = brcode(normKey(s.pix_key), s.pix_name, s.pix_city, amount), id = 'M' + crypto.randomUUID();
      await Q(sb.from('donations').insert({ mp_id: id, amount, name }));
      return r.json({ id, qr: code, qr64: (await QR.toDataURL(code, { margin: 1, width: 440 })).split(',')[1], manual: true });
    }
    const p = await mp('/v1/payments', { method: 'POST', headers: { 'X-Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({
      transaction_amount: amount, description: 'Doação', payment_method_id: 'pix',
      payer: { email: 'doador@' + new URL(E.BASE_URL).hostname, first_name: name || 'Doador' },
      notification_url: E.BASE_URL + '/api/webhook', date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString().replace('Z', '-00:00') }) });
    await Q(sb.from('donations').insert({ mp_id: String(p.id), amount, name }));
    const t = p.point_of_interaction.transaction_data;
    r.json({ id: p.id, qr: t.qr_code, qr64: t.qr_code_base64, test: isTest() });
  } catch (e) { console.error(e.message); r.status(502).json({ error: 'Não foi possível gerar o Pix agora. Tente novamente.' }); }
});
app.get('/api/donate/:id', wrap(async (q, r) => {
  const d = (await Q(sb.from('donations').select('status').eq('mp_id', q.params.id).limit(1)))[0];
  if (!d) return r.status(404).end();
  if (d.status === 'pending' && !q.params.id.startsWith('M')) try { d.status = await sync(q.params.id); } catch {}
  r.json({ status: d.status });
}));
app.post('/api/webhook', async (q, r) => {
  try {
    const id = q.body?.data?.id || q.query['data.id'];
    if (E.MP_WEBHOOK_SECRET) {
      const sig = Object.fromEntries((q.get('x-signature') || '').split(',').map(s => s.trim().split('=')));
      const mac = crypto.createHmac('sha256', E.MP_WEBHOOK_SECRET).update(`id:${id};request-id:${q.get('x-request-id')};ts:${sig.ts};`).digest('hex');
      if (!sig.v1 || sig.v1.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(sig.v1), Buffer.from(mac))) return r.sendStatus(401);
    }
    if (id && (await Q(sb.from('donations').select('id').eq('mp_id', String(id)))).length) await sync(id);
    r.sendStatus(200);
  } catch (e) { console.error(e.message); r.sendStatus(500); }
});

// ---------- Público ----------
app.get('/api/public', wrap(async (q, r) => {
  const { pix_key, pix_name, pix_city, ...pub } = await S();
  const ok = await Q(sb.from('donations').select('amount').eq('status', 'confirmed').limit(10000));
  r.json({ ...pub, manual: MANUAL(), total: ok.reduce((a, x) => a + Number(x.amount), 0), donors: ok.length, test: isTest(),
    media: await Q(sb.from('media').select('id,file,kind,is_main').order('is_main', { ascending: false }).order('pos').order('id')),
    updates: await Q(sb.from('updates').select('*').order('created', { ascending: false }).order('id', { ascending: false })) });
}));

// ---------- Admin ----------
const hash = bcrypt.hashSync(E.ADMIN_PASSWORD || crypto.randomUUID(), 10), SECRET = E.JWT_SECRET || crypto.randomBytes(32).toString('hex');
app.post('/api/admin/login', rateLimit({ windowMs: 900000, max: 10 }), (q, r) => {
  if (q.body.user === E.ADMIN_USER && bcrypt.compareSync(String(q.body.password || ''), hash)) {
    r.cookie('adm', jwt.sign({ a: 1 }, SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'strict', secure: q.secure, maxAge: 6048e5 });
    return r.json({ ok: 1 });
  }
  r.status(401).json({ error: 'Usuário ou senha incorretos.' });
});
const auth = (q, r, n) => { try { jwt.verify(q.cookies.adm, SECRET); n(); } catch { r.status(401).json({ error: 'Sessão expirada.' }); } };
const A = express.Router(); A.use(auth); app.use('/api/admin', A);
const get = (p, fn) => A.get(p, wrap(fn)), post = (p, fn) => A.post(p, wrap(fn)), del = (p, fn) => A.delete(p, wrap(fn));
get('/me', async (q, r) => r.json({ ok: 1 }));
get('/settings', async (q, r) => r.json(await S()));
A.put('/settings', wrap(async (q, r) => { const rows = Object.keys(defaults).filter(k => k in q.body).map(k => ({ k, v: String(q.body[k]).slice(0, 20000) })); if (rows.length) await Q(sb.from('settings').upsert(rows)); r.json({ ok: 1 }); }));
const kinds = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video' };
const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (q, f, c) => c(null, !!kinds[f.mimetype]) });
A.post('/media', up.array('files', 10), wrap(async (q, r) => {
  for (const f of q.files || []) {
    const name = crypto.randomUUID() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    await Q(sb.storage.from(BUCKET).upload(name, f.buffer, { contentType: f.mimetype }));
    await Q(sb.from('media').insert({ file: name, kind: kinds[f.mimetype], pos: Date.now() % 1e9 }));
  }
  const has = await Q(sb.from('media').select('id').eq('is_main', true).limit(1));
  if (!has.length) { const im = await Q(sb.from('media').select('id').eq('kind', 'image').order('id').limit(1)); if (im[0]) await Q(sb.from('media').update({ is_main: true }).eq('id', im[0].id)); }
  r.json({ ok: 1 });
}));
get('/media', async (q, r) => r.json(await Q(sb.from('media').select('*').order('is_main', { ascending: false }).order('pos').order('id'))));
post('/media/:id/main', async (q, r) => { await Q(sb.from('media').update({ is_main: false }).neq('id', 0)); await Q(sb.from('media').update({ is_main: true }).eq('id', q.params.id).eq('kind', 'image')); r.json({ ok: 1 }); });
post('/media/:id/move', async (q, r) => {
  const l = (await Q(sb.from('media').select('id').order('pos').order('id'))).map(x => x.id), i = l.indexOf(+q.params.id), j = i + (q.body.dir === 'up' ? -1 : 1);
  if (i > -1 && l[j]) { [l[i], l[j]] = [l[j], l[i]]; for (const [n, id] of l.entries()) await Q(sb.from('media').update({ pos: n }).eq('id', id)); }
  r.json({ ok: 1 });
});
del('/media/:id', async (q, r) => { const m = (await Q(sb.from('media').select('file').eq('id', q.params.id)))[0]; if (m) { await sb.storage.from(BUCKET).remove([m.file]); await Q(sb.from('media').delete().eq('id', q.params.id)); } r.json({ ok: 1 }); });
post('/updates', async (q, r) => { const { section, title, body } = q.body; if (!['treatment', 'accounts'].includes(section) || !title) return r.status(400).json({ error: 'Dados inválidos.' }); await Q(sb.from('updates').insert({ section, title: String(title).slice(0, 200), body: String(body || '').slice(0, 20000) })); r.json({ ok: 1 }); });
del('/updates/:id', async (q, r) => { await Q(sb.from('updates').delete().eq('id', q.params.id)); r.json({ ok: 1 }); });
get('/donations', async (q, r) => {
  const rows = await Q(sb.from('donations').select('id,name,amount,status,created,paid').order('id', { ascending: false }).limit(500)), ok = rows.filter(x => x.status === 'confirmed').map(x => Number(x.amount));
  r.json({ rows, stats: { total: ok.reduce((a, b) => a + b, 0), n: ok.length, avg: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0, max: Math.max(0, ...ok) } });
});
post('/donations/:id/confirm', async (q, r) => { await Q(sb.from('donations').update({ status: 'confirmed', paid: new Date().toISOString() }).eq('id', q.params.id).like('mp_id', 'M%')); r.json({ ok: 1 }); });
del('/donations/:id', async (q, r) => { await Q(sb.from('donations').delete().eq('id', q.params.id).like('mp_id', 'M%')); r.json({ ok: 1 }); });
get('/export.csv', async (q, r) => { const rows = await Q(sb.from('donations').select('paid,name,amount').eq('status', 'confirmed').order('paid')); r.type('text/csv').attachment('doacoes.csv').send('data,doador,valor\n' + rows.map(x => `${x.paid},"${(x.name || 'Anônimo').replace(/"/g, '""')}",${x.amount}`).join('\n')); });

app.listen(E.PORT || 3000, () => console.log('Rodando na porta', E.PORT || 3000));
