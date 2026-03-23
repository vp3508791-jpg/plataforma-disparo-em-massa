// ================================================
// server.js — WhatsApp Disparo Multi-Sessão
// Suporta múltiplos números simultâneos
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
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
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
const logger = pino({ level: 'silent' });

// ── Servir frontend ───────────────────────────
const FRONTEND_PATH = path.join(__dirname, 'public', 'index.html');
app.get('/', (req, res) => {
  if (fs.existsSync(FRONTEND_PATH)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(FRONTEND_PATH, 'utf-8'));
  } else {
    res.json({ status: 'ok', service: 'WhatsApp Disparo Multi-Sessão' });
  }
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ════════════════════════════════════════════════
// GERENCIADOR DE SESSÕES MÚLTIPLAS
// Cada slot = 1 número de WhatsApp independente
// ════════════════════════════════════════════════

const MAX_SLOTS = parseInt(process.env.MAX_SLOTS) || 3;

// Estado de cada slot
const slots = {};
for (let i = 1; i <= MAX_SLOTS; i++) {
  slots[i] = {
    id:           i,
    sock:         null,
    conectado:    false,
    disparando:   false,
    pausado:      false,
    campanhaAtiva: null,
    numero:       null,
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Conectar um slot específico ───────────────
async function conectarSlot(slotId) {
  const slot = slots[slotId];
  if (!slot) throw new Error('Slot inválido');

  const baseDir = process.env.RAILWAY_ENVIRONMENT ? '/tmp' : __dirname;
  const authDir = path.join(baseDir, `wa_auth_slot${slotId}`);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version }          = await fetchLatestBaileysVersion();

  slot.sock = makeWASocket({
    version, logger, auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => ({ conversation: '' }),
  });

  slot.sock.ev.on('creds.update', saveCreds);

  slot.sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrBase64 = await QRCode.toDataURL(qr);
      console.log(`📱 Slot ${slotId}: novo QR gerado`);
      await supabase.from('wa_sessao').upsert({
        id: `slot_${slotId}`,
        status: 'aguardando_qr',
        qr_code: qrBase64,
        atualizado_em: new Date().toISOString()
      });
    }

    if (connection === 'close') {
      slot.conectado = false;
      slot.numero    = null;
      const codigo         = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = codigo !== DisconnectReason.loggedOut;
      console.log(`❌ Slot ${slotId}: desconectado. Código:`, codigo);

      await supabase.from('wa_sessao').upsert({
        id: `slot_${slotId}`,
        status: 'desconectado',
        qr_code: null,
        numero_conectado: null,
        atualizado_em: new Date().toISOString()
      });

      if (deveReconectar) {
        console.log(`🔄 Slot ${slotId}: reconectando em 5s...`);
        setTimeout(() => conectarSlot(slotId), 5000);
      } else {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log(`🗑 Slot ${slotId}: sessão removida`);
        setTimeout(() => conectarSlot(slotId), 2000);
      }
    }

    if (connection === 'open') {
      slot.conectado = true;
      slot.numero    = slot.sock.user?.id?.split(':')[0] || '';
      console.log(`✅ Slot ${slotId}: conectado! Número: ${slot.numero}`);

      await supabase.from('wa_sessao').upsert({
        id: `slot_${slotId}`,
        status: 'conectado',
        qr_code: null,
        numero_conectado: slot.numero,
        atualizado_em: new Date().toISOString()
      });
    }
  });
}

// ── Motor de disparo por slot ─────────────────
function randomDelay(config = {}) {
  const min = (config.delay_min_s || 10) * 1000;
  const max = (config.delay_max_s || 20) * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Caracteres invisíveis Unicode para variar cada mensagem
const INVISIBLES = ['\u200B','\u200C','\u200D','\uFEFF'];
function variarMensagem(texto) {
  const char = INVISIBLES[Math.floor(Math.random() * INVISIBLES.length)];
  const pos  = Math.floor(Math.random() * (texto.length + 1));
  return texto.slice(0, pos) + char + texto.slice(pos);
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

async function rodarDisparo(slotId, campanhaId, config = {}) {
  const slot = slots[slotId];
  if (!slot.conectado) throw new Error('WhatsApp não conectado neste slot');
  if (slot.disparando) throw new Error('Slot já está disparando');

  slot.disparando   = true;
  slot.pausado      = false;
  slot.campanhaAtiva = campanhaId;

  await supabase.from('campanhas').update({ status: 'ativa', slot_id: slotId }).eq('id', campanhaId);
  console.log(`🚀 Slot ${slotId}: disparo iniciado | campanha: ${campanhaId}`);

  const BATCH_SIZE     = config.batch_size     || 25;
  const BATCH_PAUSE_MS = (config.batch_pause_s || 180) * 1000;
  const DAILY_LIMIT    = config.daily_limit    || 150;
  let batchCount = 0;
  let dailyCount = 0;

  try {
    while (true) {
      while (slot.pausado) {
        await sleep(1000);
        if (!slot.disparando) break;
      }
      if (!slot.disparando) break;

      if (DAILY_LIMIT > 0 && dailyCount >= DAILY_LIMIT) {
        console.log(`⛔ Slot ${slotId}: limite diário (${DAILY_LIMIT}) atingido`);
        await supabase.from('campanhas').update({ status: 'pausada' }).eq('id', campanhaId);
        break;
      }

      // Buscar próximo lead pendente desta campanha
      const { data: leads, error } = await supabase
        .from('leads').select('*')
        .eq('campanha_id', campanhaId)
        .eq('status', 'pendente')
        .order('criado_em', { ascending: true })
        .limit(1);

      if (error) throw error;
      if (!leads || leads.length === 0) {
        console.log(`✅ Slot ${slotId}: todos os leads processados!`);
        break;
      }

      const lead   = leads[0];
      await supabase.from('leads').update({ status: 'enviando' }).eq('id', lead.id);
      const numero = limparNumero(lead.numero);

      if (!numero || numero.length < 10) {
        await supabase.from('leads').update({
          status: 'invalido', erro_msg: `Inválido: "${lead.numero}"`
        }).eq('id', lead.id);
        await supabase.rpc('increment_erros', { camp_id: campanhaId });
        continue;
      }

      try {
        await slot.sock.sendMessage(numero + '@s.whatsapp.net', { text: variarMensagem(lead.mensagem_final || '') });
        await supabase.from('leads').update({
          status: 'enviado',
          enviado_em: new Date().toISOString(),
          tentativas: (lead.tentativas || 0) + 1
        }).eq('id', lead.id);
        await supabase.rpc('increment_enviados', { camp_id: campanhaId });

        batchCount++;
        dailyCount++;
        console.log(`✓ Slot ${slotId} | ${numero} | lote:${batchCount} | hoje:${dailyCount}`);

        if (batchCount % BATCH_SIZE === 0) {
          console.log(`⏳ Slot ${slotId}: pausa de lote (${BATCH_PAUSE_MS/1000}s)`);
          await sleep(BATCH_PAUSE_MS);
        } else {
          await sleep(randomDelay(config));
        }
      } catch (e) {
        console.error(`✗ Slot ${slotId} erro:`, e.message);
        await supabase.from('leads').update({
          status: 'erro', erro_msg: e.message,
          tentativas: (lead.tentativas || 0) + 1
        }).eq('id', lead.id);
        await supabase.rpc('increment_erros', { camp_id: campanhaId });
      }
    }
  } finally {
    slot.disparando    = false;
    slot.campanhaAtiva = null;
    await supabase.from('campanhas').update({ status: 'concluida' }).eq('id', campanhaId);
    console.log(`🏁 Slot ${slotId}: disparo finalizado`);
  }
}

// ════════════════════════════════════════════════
// ROTAS API
// ════════════════════════════════════════════════

// Status de todos os slots
app.get('/api/status', async (req, res) => {
  const slotsStatus = {};
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const { data: sessao } = await supabase.from('wa_sessao')
      .select('*').eq('id', `slot_${i}`).single();
    slotsStatus[i] = {
      id:           i,
      conectado:    slots[i].conectado,
      disparando:   slots[i].disparando,
      pausado:      slots[i].pausado,
      numero:       slots[i].numero,
      campanhaAtiva: slots[i].campanhaAtiva,
      sessao:       sessao || {}
    };
  }
  res.json({ slots: slotsStatus, maxSlots: MAX_SLOTS });
});

// Status de um slot específico
app.get('/api/slot/:id/status', async (req, res) => {
  const slotId = parseInt(req.params.id);
  const slot   = slots[slotId];
  if (!slot) return res.status(404).json({ erro: 'Slot não encontrado' });
  const { data: sessao } = await supabase.from('wa_sessao')
    .select('*').eq('id', `slot_${slotId}`).single();
  res.json({ ...slot, sock: undefined, sessao: sessao || {} });
});

// QR Code de um slot
app.get('/api/slot/:id/qrcode', async (req, res) => {
  const slotId = parseInt(req.params.id);
  const { data: sessao } = await supabase.from('wa_sessao')
    .select('qr_code,status').eq('id', `slot_${slotId}`).single();
  res.json({ qr: sessao?.qr_code || null, status: sessao?.status || 'desconectado' });
});

// Desconectar slot
app.post('/api/slot/:id/desconectar', async (req, res) => {
  const slotId = parseInt(req.params.id);
  const slot   = slots[slotId];
  try {
    if (slot?.sock) await slot.sock.logout();
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

// Criar campanha com planilha
app.post('/api/campanha/criar', upload.single('planilha'), async (req, res) => {
  try {
    const { nome, mensagem, colunaNumero, colunaNome } = req.body;
    if (!req.file)  return res.status(400).json({ erro: 'Planilha não enviada' });
    if (!mensagem)  return res.status(400).json({ erro: 'Mensagem obrigatória' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:false });
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
        const numero   = String(row[colNum] || '').trim();
        const nomeLead = colNom >= 0 ? String(row[colNom] || '').trim() : '';
        const dados    = {};
        headers.forEach((h, idx) => { if (h) dados[h] = row[idx] || ''; });
        let msg = mensagem;
        headers.forEach((h, idx) => { if (h) msg = msg.split(`{${h}}`).join(row[idx] || ''); });
        msg = msg.split('{nome}').join(nomeLead).split('{numero}').join(numero);
        return { campanha_id: campanha.id, numero, nome: nomeLead, dados, mensagem_final: msg };
      });
      const { error: errL } = await supabase.from('leads').insert(chunk);
      if (errL) throw errL;
    }
    res.json({ ok: true, campanhaId: campanha.id, total: rows.length, headers });
  } catch (e) { console.error(e); res.status(500).json({ erro: e.message }); }
});

// Listar campanhas
app.get('/api/campanhas', async (req, res) => {
  const { data, error } = await supabase.from('campanhas').select('*').order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// Stats de campanha
app.get('/api/campanha/:id/stats', async (req, res) => {
  const { data: camp }       = await supabase.from('campanhas').select('*').eq('id', req.params.id).single();
  const { count: pendentes } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','pendente');
  const { count: enviados  } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','enviado');
  const { count: erros     } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','erro');
  res.json({ ...camp, pendentes, enviados, erros });
});

// Feed em tempo real
app.get('/api/campanha/:id/feed', async (req, res) => {
  const limit = parseInt(req.query.limit) || 25;
  const { data: recentes } = await supabase.from('leads')
    .select('id,numero,nome,status,enviado_em,erro_msg,mensagem_final')
    .eq('campanha_id', req.params.id)
    .in('status', ['enviado','erro','invalido','enviando'])
    .order('enviado_em', { ascending: false, nullsFirst: false })
    .limit(limit);
  const { count: pendentes } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','pendente');
  const { count: enviados  } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','enviado');
  const { count: erros     } = await supabase.from('leads').select('*',{count:'exact',head:true}).eq('campanha_id',req.params.id).eq('status','erro');
  const { data: camp }       = await supabase.from('campanhas').select('total_leads,status,slot_id').eq('id',req.params.id).single();
  res.json({
    recentes: recentes || [],
    contadores: { pendentes, enviados, erros, total: camp?.total_leads || 0 },
    status: camp?.status || 'desconhecido',
    slot_id: camp?.slot_id,
    disparando: Object.values(slots).some(s => s.campanhaAtiva === req.params.id)
  });
});

// Iniciar disparo em slot específico
app.post('/api/campanha/:id/iniciar', async (req, res) => {
  const slotId = parseInt(req.body.slotId) || 1;
  const slot   = slots[slotId];
  if (!slot)           return res.status(400).json({ erro: 'Slot inválido' });
  if (!slot.conectado) return res.status(400).json({ erro: `Slot ${slotId} não conectado` });
  if (slot.disparando) return res.status(400).json({ erro: `Slot ${slotId} já está disparando` });
  const config = req.body || {};
  rodarDisparo(slotId, req.params.id, config);
  res.json({ ok: true, mensagem: `Disparo iniciado no slot ${slotId}!`, slotId });
});

// Pausar / retomar / parar por slot
app.post('/api/slot/:id/pausar',  (req, res) => { const s=slots[parseInt(req.params.id)]; if(s) s.pausado=true;  res.json({ok:true}); });
app.post('/api/slot/:id/retomar', (req, res) => { const s=slots[parseInt(req.params.id)]; if(s) s.pausado=false; res.json({ok:true}); });
app.post('/api/slot/:id/parar',   async (req, res) => {
  const slotId = parseInt(req.params.id);
  const slot   = slots[slotId];
  if (slot) {
    slot.disparando = false;
    slot.pausado    = false;
    if (slot.campanhaAtiva) {
      await supabase.from('campanhas').update({ status: 'pausada' }).eq('id', slot.campanhaAtiva);
      slot.campanhaAtiva = null;
    }
  }
  res.json({ ok: true });
});

// Exportar relatório
app.get('/api/campanha/:id/exportar', async (req, res) => {
  const { data: leads } = await supabase.from('leads').select('*')
    .eq('campanha_id', req.params.id).order('criado_em', { ascending: true });
  const rows = leads.map(l => ({
    'Número': l.numero, 'Nome': l.nome||'', 'Status': l.status,
    'Mensagem': l.mensagem_final||'', 'Enviado em': l.enviado_em||'', 'Erro': l.erro_msg||''
  }));
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Relatório');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename=relatorio_${req.params.id}.xlsx`);
  res.send(buf);
});

// ════════════════════════════════════════════════
// INICIALIZAÇÃO
// ════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`\n🟢 Servidor na porta ${PORT} | ${MAX_SLOTS} slots disponíveis`);
  for (let i = 1; i <= MAX_SLOTS; i++) {
    console.log(`📱 Inicializando Slot ${i}...`);
    await conectarSlot(i);
    await sleep(2000); // pequeno delay entre slots
  }
  console.log('\n✅ Todos os slots inicializados!\n');
});
