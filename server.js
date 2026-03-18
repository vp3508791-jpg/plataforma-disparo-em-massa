// ================================================
// server.js — WhatsApp Disparo em Massa
// ES Module (import) — compatível com Baileys v6
// ================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import XLSX from 'xlsx';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs, { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Supabase ──────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Express ───────────────────────────────────
const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage() });

// ── Servir o frontend ────────────────────────
const FRONTEND_PATH = path.join(__dirname, 'public', 'index.html');

app.get('/', (req, res) => {
  if (fs.existsSync(FRONTEND_PATH)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(FRONTEND_PATH, 'utf-8'));
  } else {
    res.json({ status: 'ok', service: 'WhatsApp Disparo Backend', connected: isConnected });
  }
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Estado global ─────────────────────────────
let sock         = null;
let isConnected  = false;
let isDisparando = false;
let isPaused     = false;
let campanhaAtiva = null;
const logger = pino({ level: 'silent' });

// ════════════════════════════════════════════════
// WHATSAPP CONNECTION
// ════════════════════════════════════════════════
async function conectarWhatsApp() {
  const authDir = process.env.RAILWAY_ENVIRONMENT
    ? '/tmp/wa_auth'
    : path.join(__dirname, 'wa_auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, logger, auth: state, printQRInTerminal: false,
    browser: ['WhatsApp Disparo','Chrome','120.0.0'],
    generateHighQualityLinkPreview: false, syncFullHistory: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrBase64 = await QRCode.toDataURL(qr);
      console.log('📱 Novo QR Code gerado');
      await supabase.from('wa_sessao').update({ status: 'aguardando_qr', qr_code: qrBase64, atualizado_em: new Date().toISOString() }).eq('id','default');
    }

    if (connection === 'close') {
      isConnected = false;
      const codigo         = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = codigo !== DisconnectReason.loggedOut;
      console.log('❌ Conexão encerrada. Código:', codigo);
      await supabase.from('wa_sessao').update({ status: 'desconectado', qr_code: null, numero_conectado: null, atualizado_em: new Date().toISOString() }).eq('id','default');
      if (deveReconectar) {
        console.log('🔄 Reconectando em 5s...');
        setTimeout(conectarWhatsApp, 5000);
      } else {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('🗑 Sessão removida.');
        setTimeout(conectarWhatsApp, 2000);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      const numero = sock.user?.id?.split(':')[0] || '';
      console.log('✅ WhatsApp conectado! Número:', numero);
      await supabase.from('wa_sessao').update({ status: 'conectado', qr_code: null, numero_conectado: numero, atualizado_em: new Date().toISOString() }).eq('id','default');
    }
  });
}

// ════════════════════════════════════════════════
// MOTOR DE DISPARO
// ════════════════════════════════════════════════
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function randomDelay(config = {}) {
  const min = (config.delay_min_s || parseInt(process.env.DELAY_MIN_MS/1000) || 10) * 1000;
  const max = (config.delay_max_s || parseInt(process.env.DELAY_MAX_MS/1000) || 20) * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function limparNumero(raw) {
  if (!raw) return '';
  let n = String(raw).replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  else if (n.startsWith('0')) n = n.slice(1);
  if (n.startsWith('55') && n.length >= 12) return n;
  if (n.length === 10 || n.length === 11) return '55' + n;
  if (n.length >= 12 && n.length <= 15) return n;
  return n;
}

async function rodarDisparo(campanhaId, config = {}) {
  if (!isConnected)  throw new Error('WhatsApp não conectado');
  if (isDisparando)  throw new Error('Disparo já em andamento');
  isDisparando = true; isPaused = false; campanhaAtiva = campanhaId;
  await supabase.from('campanhas').update({ status: 'ativa' }).eq('id', campanhaId);
  console.log('🚀 Disparo iniciado:', campanhaId, '| Config:', JSON.stringify(config));

  try {
    let batchCount = 0;
    const BATCH_SIZE     = config.batch_size     || 25;
    const BATCH_PAUSE_MS = (config.batch_pause_s || 180) * 1000;
    const DAILY_LIMIT    = config.daily_limit    || 150;
    let dailyCount = 0;

    while (true) {
      while (isPaused) { await sleep(1000); if (!isDisparando) break; }
      if (!isDisparando) break;

      const { data: leads, error } = await supabase.from('leads').select('*')
        .eq('campanha_id', campanhaId).eq('status', 'pendente')
        .order('criado_em', { ascending: true }).limit(1);

      if (error) throw error;
      if (!leads || leads.length === 0) { console.log('✅ Todos os leads processados!'); break; }

      // Daily limit check
      if (DAILY_LIMIT > 0 && dailyCount >= DAILY_LIMIT) {
        console.log(`⛔ Limite diário (${DAILY_LIMIT}) atingido.`);
        await supabase.from('campanhas').update({ status: 'pausada', obs: 'Limite diário atingido' }).eq('id', campanhaId);
        break;
      }

      const lead   = leads[0];
      await supabase.from('leads').update({ status: 'enviando' }).eq('id', lead.id);
      const numero = limparNumero(lead.numero);

      if (!numero || numero.length < 10) {
        await supabase.from('leads').update({ status: 'invalido', erro_msg: `Inválido: "${lead.numero}"` }).eq('id', lead.id);
        await supabase.rpc('increment_erros', { camp_id: campanhaId });
        continue;
      }

      try {
        await sock.sendMessage(numero + '@s.whatsapp.net', { text: lead.mensagem_final || '' });
        await supabase.from('leads').update({ status: 'enviado', enviado_em: new Date().toISOString(), tentativas: (lead.tentativas||0)+1 }).eq('id', lead.id);
        await supabase.rpc('increment_enviados', { camp_id: campanhaId });
        batchCount++;
        dailyCount++;
        console.log(`✓ ${numero} | lote:${batchCount} | hoje:${dailyCount}`);

        if (batchCount % BATCH_SIZE === 0) {
          console.log(`⏳ Pausa de lote...`);
          await sleep(BATCH_PAUSE_MS);
        } else {
          await sleep(randomDelay(config));
        }
      } catch (e) {
        console.error('✗ Erro:', e.message);
        await supabase.from('leads').update({ status: 'erro', erro_msg: e.message, tentativas: (lead.tentativas||0)+1 }).eq('id', lead.id);
        await supabase.rpc('increment_erros', { camp_id: campanhaId });
      }
    }
  } finally {
    isDisparando = false; campanhaAtiva = null;
    await supabase.from('campanhas').update({ status: 'concluida' }).eq('id', campanhaId);
    console.log('🏁 Disparo finalizado.');
  }
}

// ════════════════════════════════════════════════
// ROTAS
// ════════════════════════════════════════════════
app.get('/api/status', async (req, res) => {
  const { data: sessao } = await supabase.from('wa_sessao').select('*').eq('id','default').single();
  res.json({ conectado: isConnected, disparando: isDisparando, pausado: isPaused, campanhaAtiva, sessao: sessao||{} });
});

app.get('/api/qrcode', async (req, res) => {
  const { data: sessao } = await supabase.from('wa_sessao').select('qr_code,status').eq('id','default').single();
  res.json({ qr: sessao?.qr_code||null, status: sessao?.status||'desconectado' });
});

app.post('/api/desconectar', async (req, res) => {
  try { if (sock) await sock.logout(); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, erro: e.message }); }
});

app.post('/api/campanha/criar', upload.single('planilha'), async (req, res) => {
  try {
    const { nome, mensagem, colunaNumero, colunaNome } = req.body;
    if (!req.file)  return res.status(400).json({ erro: 'Planilha não enviada' });
    if (!mensagem)  return res.status(400).json({ erro: 'Mensagem obrigatória' });

    const wb      = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const json    = XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:false });
    if (!json || json.length < 2) return res.status(400).json({ erro: 'Planilha vazia' });

    const headers = json[0].map(h => String(h).trim());
    const rows    = json.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
    const colNum  = parseInt(colunaNumero) || 0;
    const colNom  = colunaNome !== undefined ? parseInt(colunaNome) : -1;

    const { data: campanha, error: errC } = await supabase.from('campanhas')
      .insert({ nome: nome || 'Campanha ' + new Date().toLocaleString('pt-BR'), mensagem, total_leads: rows.length })
      .select().single();
    if (errC) throw errC;

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i+500).map(row => {
        const numero   = String(row[colNum]||'').trim();
        const nomeLead = colNom >= 0 ? String(row[colNom]||'').trim() : '';
        const dados    = {};
        headers.forEach((h,idx) => { if(h) dados[h] = row[idx]||''; });
        let msg = mensagem;
        headers.forEach((h,idx) => { if(h) msg = msg.split(`{${h}}`).join(row[idx]||''); });
        msg = msg.split('{nome}').join(nomeLead).split('{numero}').join(numero);
        return { campanha_id: campanha.id, numero, nome: nomeLead, dados, mensagem_final: msg };
      });
      const { error: errL } = await supabase.from('leads').insert(chunk);
      if (errL) throw errL;
    }
    res.json({ ok: true, campanhaId: campanha.id, total: rows.length, headers });
  } catch (e) { console.error(e); res.status(500).json({ erro: e.message }); }
});

app.get('/api/campanhas', async (req, res) => {
  const { data, error } = await supabase.from('campanhas').select('*').order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

app.get('/api/campanha/:id/stats', async (req, res) => {
  const { data: camp }     = await supabase.from('campanhas').select('*').eq('id', req.params.id).single();
  const { count: pendentes } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','pendente');
  const { count: enviados  } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','enviado');
  const { count: erros     } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','erro');
  res.json({ ...camp, pendentes, enviados, erros });
});

app.post('/api/campanha/:id/iniciar', async (req, res) => {
  if (!isConnected)  return res.status(400).json({ erro: 'WhatsApp não conectado' });
  if (isDisparando)  return res.status(400).json({ erro: 'Disparo já em andamento' });
  const config = req.body || {};
  rodarDisparo(req.params.id, config);
  res.json({ ok: true, mensagem: 'Disparo iniciado!', config });
});

app.post('/api/disparo/pausar',  (req, res) => { isPaused = true;  res.json({ ok: true }); });
app.post('/api/disparo/retomar', (req, res) => { isPaused = false; res.json({ ok: true }); });
app.post('/api/disparo/parar',   async (req, res) => {
  isDisparando = false; isPaused = false;
  if (campanhaAtiva) await supabase.from('campanhas').update({ status: 'pausada' }).eq('id', campanhaAtiva);
  campanhaAtiva = null;
  res.json({ ok: true });
});

// Feed em tempo real — últimos envios e pendentes
app.get('/api/campanha/:id/feed', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;

  const { data: recentes } = await supabase.from('leads')
    .select('id,numero,nome,status,enviado_em,erro_msg,mensagem_final')
    .eq('campanha_id', req.params.id)
    .in('status', ['enviado','erro','invalido','enviando'])
    .order('enviado_em', { ascending: false, nullsFirst: false })
    .limit(limit);

  const { count: pendentes } = await supabase.from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('campanha_id', req.params.id).eq('status', 'pendente');

  const { count: enviados } = await supabase.from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('campanha_id', req.params.id).eq('status', 'enviado');

  const { count: erros } = await supabase.from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('campanha_id', req.params.id).eq('status', 'erro');

  const { data: camp } = await supabase.from('campanhas')
    .select('total_leads,status').eq('id', req.params.id).single();

  res.json({
    recentes: recentes || [],
    contadores: { pendentes, enviados, erros, total: camp?.total_leads || 0 },
    status: camp?.status || 'desconhecido',
    disparando: isDisparando
  });
});

app.get('/api/campanha/:id/exportar', async (req, res) => {
  const { data: leads } = await supabase.from('leads').select('*').eq('campanha_id', req.params.id).order('criado_em',{ascending:true});
  const rows = leads.map(l => ({ 'Número':l.numero,'Nome':l.nome||'','Status':l.status,'Mensagem':l.mensagem_final||'','Enviado em':l.enviado_em||'','Erro':l.erro_msg||'' }));
  const wb   = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Relatório');
  const buf  = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename=relatorio_${req.params.id}.xlsx`);
  res.send(buf);
});

// ════════════════════════════════════════════════
// INICIAR
// ════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n🟢 Servidor na porta ${PORT}`);
  console.log('📱 Conectando WhatsApp...\n');
  await conectarWhatsApp();
});
