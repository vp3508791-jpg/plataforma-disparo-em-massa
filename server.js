// ================================================
// server.js — Backend WhatsApp Disparo em Massa
// Baileys (WhatsApp Web API) + Supabase + Express
// ================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// ── Supabase ──────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Express ───────────────────────────────────
const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

// Health check for Railway
app.get('/', (req, res) => res.json({ status: 'ok', service: 'WhatsApp Disparo Backend', connected: isConnected }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use(express.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage() });

// ── Estado global ─────────────────────────────
let sock = null;
let isConnected = false;
let isDisparando = false;
let isPaused = false;
let campanhaAtiva = null;
let qrCodeBase64 = null;

// ── Logger silencioso para Baileys ────────────
const logger = pino({ level: 'silent' });

// ════════════════════════════════════════════════
// WHATSAPP CONNECTION (Baileys)
// ════════════════════════════════════════════════

async function conectarWhatsApp() {
  // Railway uses ephemeral filesystem — store in /tmp for the session
  // For persistent sessions across deploys, use a volume or store creds in Supabase
  const authDir = process.env.RAILWAY_ENVIRONMENT
    ? path.join('/tmp', 'wa_auth')
    : path.join(__dirname, 'wa_auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['WhatsApp Disparo', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  // Salvar credenciais sempre que atualizadas
  sock.ev.on('creds.update', saveCreds);

  // Eventos de conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Novo QR Code gerado — salvar como base64 para o frontend
      qrCodeBase64 = await QRCode.toDataURL(qr);
      console.log('📱 Novo QR Code gerado');
      await supabase.from('wa_sessao').update({
        status: 'aguardando_qr',
        qr_code: qrCodeBase64,
        atualizado_em: new Date().toISOString()
      }).eq('id', 'default');
    }

    if (connection === 'close') {
      isConnected = false;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = codigo !== DisconnectReason.loggedOut;
      console.log('❌ Conexão encerrada. Código:', codigo);

      await supabase.from('wa_sessao').update({
        status: 'desconectado',
        qr_code: null,
        numero_conectado: null,
        atualizado_em: new Date().toISOString()
      }).eq('id', 'default');

      if (deveReconectar) {
        console.log('🔄 Reconectando em 5s...');
        setTimeout(conectarWhatsApp, 5000);
      } else {
        // Usuário deslogou — apagar credenciais
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('🗑 Sessão removida. Reconecte via QR.');
        setTimeout(conectarWhatsApp, 2000);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      qrCodeBase64 = null;
      const numero = sock.user?.id?.split(':')[0] || '';
      console.log('✅ WhatsApp conectado! Número:', numero);

      await supabase.from('wa_sessao').update({
        status: 'conectado',
        qr_code: null,
        numero_conectado: numero,
        atualizado_em: new Date().toISOString()
      }).eq('id', 'default');
    }
  });

  return sock;
}

// ════════════════════════════════════════════════
// MOTOR DE DISPARO
// ════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  const min = parseInt(process.env.DELAY_MIN_MS) || 10000;
  const max = parseInt(process.env.DELAY_MAX_MS) || 20000;
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

async function enviarMensagem(numero, mensagem) {
  const jid = numero + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: mensagem });
}

async function rodarDisparo(campanhaId) {
  if (!isConnected) throw new Error('WhatsApp não conectado');
  if (isDisparando) throw new Error('Disparo já em andamento');

  isDisparando = true;
  isPaused = false;
  campanhaAtiva = campanhaId;

  // Atualizar status da campanha
  await supabase.from('campanhas').update({ status: 'ativa' }).eq('id', campanhaId);

  console.log(`🚀 Iniciando disparo da campanha: ${campanhaId}`);

  try {
    let batchCount = 0;
    const BATCH_SIZE = 25;
    const BATCH_PAUSE_MS = 3 * 60 * 1000; // 3 minutos

    while (true) {
      // Pausado?
      while (isPaused) {
        await sleep(1000);
        if (!isDisparando) break;
      }
      if (!isDisparando) break;

      // Buscar próximo lead pendente
      const { data: leads, error } = await supabase
        .from('leads')
        .select('*')
        .eq('campanha_id', campanhaId)
        .eq('status', 'pendente')
        .order('criado_em', { ascending: true })
        .limit(1);

      if (error) throw error;
      if (!leads || leads.length === 0) {
        console.log('✅ Todos os leads processados!');
        break;
      }

      const lead = leads[0];

      // Marcar como enviando
      await supabase.from('leads').update({ status: 'enviando' }).eq('id', lead.id);

      const numero = limparNumero(lead.numero);

      if (!numero || numero.length < 10) {
        // Número inválido
        await supabase.from('leads').update({
          status: 'invalido',
          erro_msg: `Número inválido: "${lead.numero}"`
        }).eq('id', lead.id);
        await supabase.rpc('increment_erros', { camp_id: campanhaId }).maybeSingle();
        console.log(`⚠ #${lead.id} Inválido: ${lead.numero}`);
        continue;
      }

      try {
        await enviarMensagem(numero, lead.mensagem_final || lead.numero);

        // Sucesso
        await supabase.from('leads').update({
          status: 'enviado',
          enviado_em: new Date().toISOString(),
          tentativas: (lead.tentativas || 0) + 1
        }).eq('id', lead.id);

        // Incrementar enviados via SQL direto
        await supabase.rpc('increment_enviados', { camp_id: campanhaId }).maybeSingle();

        batchCount++;
        console.log(`✓ Enviado → ${numero} (lote: ${batchCount})`);

        // Pausa entre lotes
        if (batchCount > 0 && batchCount % BATCH_SIZE === 0) {
          console.log(`⏳ Pausa de lote (${BATCH_PAUSE_MS / 60000} min)...`);
          await sleep(BATCH_PAUSE_MS);
        } else {
          // Delay aleatório normal
          const delay = randomDelay();
          console.log(`⏱ Aguardando ${Math.round(delay / 1000)}s...`);
          await sleep(delay);
        }

      } catch (sendErr) {
        console.error(`✗ Erro ao enviar ${numero}:`, sendErr.message);
        await supabase.from('leads').update({
          status: 'erro',
          erro_msg: sendErr.message,
          tentativas: (lead.tentativas || 0) + 1
        }).eq('id', lead.id);
          await supabase.rpc('increment_erros', { camp_id: campanhaId }).maybeSingle();
      }
    }
  } finally {
    isDisparando = false;
    campanhaAtiva = null;
    await supabase.from('campanhas').update({
      status: 'concluida'
    }).eq('id', campanhaId);
    console.log('🏁 Disparo finalizado.');
  }
}

// ════════════════════════════════════════════════
// ROTAS DA API
// ════════════════════════════════════════════════

// Status geral
app.get('/api/status', async (req, res) => {
  const { data: sessao } = await supabase
    .from('wa_sessao')
    .select('*')
    .eq('id', 'default')
    .single();

  res.json({
    conectado: isConnected,
    disparando: isDisparando,
    pausado: isPaused,
    campanhaAtiva,
    sessao: sessao || {}
  });
});

// QR Code atual
app.get('/api/qrcode', async (req, res) => {
  const { data: sessao } = await supabase
    .from('wa_sessao')
    .select('qr_code, status')
    .eq('id', 'default')
    .single();

  res.json({
    qr: sessao?.qr_code || null,
    status: sessao?.status || 'desconectado'
  });
});

// Desconectar
app.post('/api/desconectar', async (req, res) => {
  try {
    if (sock) await sock.logout();
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// Upload de planilha + criação de campanha
app.post('/api/campanha/criar', upload.single('planilha'), async (req, res) => {
  try {
    const { nome, mensagem, colunaNumero, colunaNome } = req.body;

    if (!req.file) return res.status(400).json({ erro: 'Planilha não enviada' });
    if (!mensagem) return res.status(400).json({ erro: 'Mensagem obrigatória' });

    // Ler planilha
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });

    if (!json || json.length < 2) return res.status(400).json({ erro: 'Planilha vazia' });

    const headers = json[0].map(h => String(h).trim());
    const rows = json.slice(1).filter(r => r.some(c => String(c).trim() !== ''));

    const colNum = parseInt(colunaNumero) || 0;
    const colNom = colunaNome !== undefined ? parseInt(colunaNome) : -1;

    // Criar campanha
    const { data: campanha, error: errCamp } = await supabase
      .from('campanhas')
      .insert({ nome: nome || 'Campanha ' + new Date().toLocaleString('pt-BR'), mensagem, total_leads: rows.length })
      .select()
      .single();

    if (errCamp) throw errCamp;

    // Montar leads em lotes de 500 para insert
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map(row => {
        const numero = String(row[colNum] || '').trim();
        const nome_lead = colNom >= 0 ? String(row[colNom] || '').trim() : '';
        const dados = {};
        headers.forEach((h, idx) => { if (h) dados[h] = row[idx] || ''; });

        // Substituir variáveis na mensagem
        let msg = mensagem;
        headers.forEach((h, idx) => { if (h) msg = msg.split(`{${h}}`).join(row[idx] || ''); });
        msg = msg.split('{nome}').join(nome_lead);
        msg = msg.split('{numero}').join(numero);

        return { campanha_id: campanha.id, numero, nome: nome_lead, dados, mensagem_final: msg };
      });

      const { error: errLeads } = await supabase.from('leads').insert(chunk);
      if (errLeads) throw errLeads;
    }

    res.json({ ok: true, campanhaId: campanha.id, total: rows.length, headers });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// Listar campanhas
app.get('/api/campanhas', async (req, res) => {
  const { data, error } = await supabase
    .from('campanhas')
    .select('*')
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// Stats de uma campanha
app.get('/api/campanha/:id/stats', async (req, res) => {
  const { data: camp } = await supabase.from('campanhas').select('*').eq('id', req.params.id).single();
  const { count: pendentes } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('campanha_id', req.params.id).eq('status', 'pendente');
  const { count: enviados } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('campanha_id', req.params.id).eq('status', 'enviado');
  const { count: erros } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('campanha_id', req.params.id).eq('status', 'erro');
  res.json({ ...camp, pendentes, enviados, erros });
});

// Iniciar disparo
app.post('/api/campanha/:id/iniciar', async (req, res) => {
  if (!isConnected) return res.status(400).json({ erro: 'WhatsApp não conectado' });
  if (isDisparando) return res.status(400).json({ erro: 'Disparo já em andamento' });
  try {
    rodarDisparo(req.params.id); // roda em background
    res.json({ ok: true, mensagem: 'Disparo iniciado!' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Pausar
app.post('/api/disparo/pausar', (req, res) => {
  isPaused = true;
  res.json({ ok: true });
});

// Retomar
app.post('/api/disparo/retomar', (req, res) => {
  isPaused = false;
  res.json({ ok: true });
});

// Parar
app.post('/api/disparo/parar', async (req, res) => {
  isDisparando = false;
  isPaused = false;
  if (campanhaAtiva) {
    await supabase.from('campanhas').update({ status: 'pausada' }).eq('id', campanhaAtiva);
  }
  campanhaAtiva = null;
  res.json({ ok: true });
});

// Exportar relatório
app.get('/api/campanha/:id/exportar', async (req, res) => {
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .eq('campanha_id', req.params.id)
    .order('criado_em', { ascending: true });

  const rows = leads.map(l => ({
    'Número': l.numero,
    'Nome': l.nome || '',
    'Status': l.status,
    'Mensagem': l.mensagem_final || '',
    'Enviado em': l.enviado_em || '',
    'Erro': l.erro_msg || ''
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Relatório');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=relatorio_campanha_${req.params.id}.xlsx`);
  res.send(buf);
});

// ════════════════════════════════════════════════
// INICIALIZAÇÃO
// ════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`\n🟢 Servidor rodando em http://localhost:${PORT}`);
  console.log('📱 Conectando WhatsApp...\n');
  await conectarWhatsApp();
});
