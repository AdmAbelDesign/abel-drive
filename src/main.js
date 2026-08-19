'use strict';

// ══════════════════════════════════════════════════════════════════════
// Abel Drive — processo principal (Electron)
// ----------------------------------------------------------------------
// Responsável por: criar a janela, guardar o device_id e a sessão em disco
// (userData), e falar com a API do Ecossistema em nome do renderer (via IPC).
// O renderer NUNCA fala direto com a rede — tudo passa por aqui, para manter
// o segredo/sessão fora da camada de UI.
//
// M6a (esqueleto): só o fluxo de LOGIN (identify → request-pin → verify-pin).
// O mount do rclone entra no M6a-2.
// ══════════════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog, powerMonitor, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const os = require('os');
const net = require('net');

// Base da API do Ecossistema (backend no Fly.io / São Paulo, via domínio próprio).
const API_BASE = 'https://api.ecossistemaabel.com.br/api';
// Raiz do gateway WebDAV (lista as coleções que o usuário pode ver).
const WEBDAV_URL = 'https://api.ecossistemaabel.com.br/webdav';

const IS_MAC = process.platform === 'darwin';
// Binário do rclone por plataforma (empacotado em bin/).
const RCLONE_BIN = IS_MAC ? 'rclone' : 'rclone.exe';

// Ponto de montagem. Mac (FUSE-T): a PASTA ~/Abel Drive. Windows: a primeira
// LETRA de drive LIVRE (resolvida ao conectar). Antes era fixo em Z:, o que
// quebraria se o usuário já tivesse Z: ocupado.
function pickWindowsDriveLetter() {
  for (const L of ['Z', 'Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R', 'Q', 'P', 'O', 'N', 'M']) {
    try { if (!fs.existsSync(L + ':\\')) return L + ':'; } catch (_) {}
  }
  return 'Z:';
}
function resolveMountPoint() {
  return IS_MAC ? path.join(os.homedir(), 'Abel Drive') : pickWindowsDriveLetter();
}

// Junta o ponto de montagem com um caminho relativo. GOTCHA Windows: `path.join
// ("Z:", "x")` vira "Z:x" (relativo ao drive), não "Z:\x". Força a raiz.
function mountJoin(mp, rel) {
  if (IS_MAC) return path.join(mp, rel);
  return path.win32.join(mp.endsWith('\\') ? mp : mp + '\\', rel);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let didAutoConnect = false;

// ── Auto-reconexão (saída INESPERADA do rclone: blip de rede, wifi trocado,
// notebook que dormiu). Backoff exponencial com teto; credencial e cache
// persistem, então o remount é rápido e o warmPins pula o que já está em cache.
let reconnectTimer = null;
let reconnectAttempt = 0;
const RECONNECT_DELAYS = [3000, 6000, 12000, 30000, 60000]; // ms — teto ~60s
const RECONNECT_MAX = 6; // nº de tentativas antes de desistir (cai pra manual)

// ── store simples em disco (userData/abel-drive.json) ──────────────────
function storePath() {
  return path.join(app.getPath('userData'), 'abel-drive.json');
}
function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); }
  catch (_) { return {}; }
}
function writeStore(patch) {
  const cur = readStore();
  const next = { ...cur, ...patch };
  try { fs.writeFileSync(storePath(), JSON.stringify(next, null, 2), 'utf8'); }
  catch (e) { console.error('[store] falha ao gravar:', e.message); }
  return next;
}

// device_id estável por instalação (o backend usa para reconhecer o aparelho).
function getDeviceId() {
  const s = readStore();
  if (s.device_id) return s.device_id;
  const id = crypto.randomUUID();
  writeStore({ device_id: id });
  return id;
}

// ── helper de chamada à API ────────────────────────────────────────────
async function api(pathname, { method = 'POST', body = null, withSession = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withSession) {
    const s = readStore();
    if (s.session_id) headers['x-session-id'] = s.session_id;
  }
  let res, json;
  try {
    res = await fetch(API_BASE + pathname, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: 'NETWORK', message: e.message };
  }
  try { json = await res.json(); }
  catch (_) { json = { ok: res.ok }; }
  // Propaga o status HTTP para o renderer poder distinguir 401 etc.
  return { ...json, _status: res.status };
}

// ── IPC: fluxo de autenticação ─────────────────────────────────────────
ipcMain.handle('app:getState', () => {
  const s = readStore();
  return { hasSession: !!s.session_id, profile: s.profile || null };
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('auth:identify', async (_e, email) => {
  return api('/auth/identify', { body: { email } });
});

ipcMain.handle('auth:requestPin', async (_e, { email, companyId }) => {
  return api('/auth/request-pin', { body: { email, company_id: companyId } });
});

ipcMain.handle('auth:verifyPin', async (_e, { email, pin, totp }) => {
  // O schema do backend aceita `totp` só como texto ou AUSENTE — nunca null.
  // Sem 2FA, o campo é omitido (JSON.stringify descarta `undefined`).
  const body = { email, pin, device_id: getDeviceId() };
  if (totp) body.totp = totp;
  const out = await api('/auth/verify-pin', { body });
  if (out.ok && out.session_id) {
    writeStore({ session_id: out.session_id });
  }
  return out;
});

// Guarda um retrato leve do usuário/empresa para a tela "conectado".
ipcMain.handle('auth:setProfile', (_e, profile) => {
  writeStore({ profile: profile || null });
  return { ok: true };
});

ipcMain.handle('auth:logout', async () => {
  try { await api('/auth/logout', { withSession: true }); } catch (_) {}
  writeStore({ session_id: null, profile: null, cred_secret: null, cred_expires: null });
  return { ok: true };
});

// ══════════════════════════════════════════════════════════════════════
// DRIVE — credencial → rclone.conf → mount (rclone) → status
// ══════════════════════════════════════════════════════════════════════

let rcloneProc = null;
let mountState = { status: 'idle', mountPoint: null, message: '' };

// ── RC (remote control) do rclone — usado SÓ para LER o progresso de sync ──
// Escuta apenas em loopback (127.0.0.1), numa porta livre e com senha aleatória
// gerada a cada conexão. Nada disso fica exposto pra fora da máquina. Lemos
// vfs/stats (uploads na fila/em andamento) e core/stats (velocidade) para
// mostrar "enviando…" e "tudo sincronizado".
let rcAddr = null;           // '127.0.0.1:<porta>' resolvido a cada conexão
let rcAuth = null;           // { user, pass } gerado a cada conexão
let syncTimer = null;
const SYNC_ZERO = { state: 'idle', pending: 0, transfers: 0, percent: null, speed: 0, errored: 0 };
let syncState = { ...SYNC_ZERO };

// Notificacao do Windows quando um envio comeca/termina (estilo Mountain Duck).
// Dispara so na virada synced->uploading e uploading->synced (nao a cada poll).
let _uploadEpisode = false;
function maybeNotifyUpload(isUploading, firstName) {
  try {
    if (Notification && Notification.isSupported && !Notification.isSupported()) return;
    if (!_uploadEpisode && isUploading) {
      _uploadEpisode = true;
      const body = firstName ? ('Enviando: ' + firstName) : 'Enviando arquivos para o Abel Drive...';
      new Notification({ title: 'Abel Drive', body, silent: true }).show();
    } else if (_uploadEpisode && !isUploading) {
      _uploadEpisode = false;
      new Notification({ title: 'Abel Drive', body: 'Tudo sincronizado', silent: true }).show();
    }
  } catch (_) { /* notificacao e best-effort */ }
}

// Acha uma porta TCP livre no loopback (evita colisão com outro rclone/serviço).
function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(5579));
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function setMount(patch) {
  mountState = { ...mountState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('drive:state', mountState);
  }
  refreshTray();
}
function toast(kind, text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('drive:toast', { kind, text });
  }
}

// ── progresso de sync (lido do RC do rclone) ───────────────────────────
function setSync(patch) {
  syncState = { ...syncState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('drive:sync', syncState);
  }
}

// Chama um comando do RC do rclone (POST em loopback, Basic auth). Devolve o
// JSON ou null (quando o RC ainda não subiu ou o mount caiu).
async function rcCall(command, params) {
  if (!rcAddr || !rcAuth) return null;
  try {
    const res = await fetch('http://' + rcAddr + '/' + command, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(rcAuth.user + ':' + rcAuth.pass).toString('base64'),
      },
      body: JSON.stringify(params || {}),
    });
    return await res.json();
  } catch (_) { return null; }
}

// Uma leitura do progresso: uploads pendentes (vfs/stats) + velocidade e % do
// que está subindo agora (core/stats).
async function pollSyncOnce() {
  const [vfs, core] = await Promise.all([rcCall('vfs/stats'), rcCall('core/stats')]);
  if (!vfs && !core) return; // RC ainda subindo — mantém o estado atual
  const disk = (vfs && vfs.diskCache) || {};
  const pending = Number(disk.uploadsInProgress || 0) + Number(disk.uploadsQueued || 0);
  const transferring = (core && core.transferring) || [];
  let sumBytes = 0, sumSize = 0;
  for (const t of transferring) { sumBytes += Number(t.bytes || 0); sumSize += Number(t.size || 0); }
  const percent = sumSize > 0 ? Math.min(100, Math.round((sumBytes / sumSize) * 100)) : null;
  const uploading = pending > 0 || transferring.length > 0;
  maybeNotifyUpload(uploading, transferring[0] && transferring[0].name);
  setSync({
    state: uploading ? 'uploading' : 'synced',
    pending,
    transfers: transferring.length,
    percent,
    speed: Number((core && core.speed) || 0), // bytes/s
    errored: Number(disk.erroredFiles || 0),
  });
}

function startSyncPoll() {
  stopSyncPoll();
  pollSyncOnce();
  syncTimer = setInterval(pollSyncOnce, 1500);
}
function stopSyncPoll() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  setSync({ ...SYNC_ZERO });
}

// ══════════════════════════════════════════════════════════════════════
// AUTO-REFRESH — arquivo novo do colega aparece SOZINHO (sem clicar Atualizar)
// ----------------------------------------------------------------------
// O WebDAV nao avisa mudancas de fora, e o dir-cache do rclone e agressivo
// (1000h). Entao, de tempos em tempos, perguntamos ao servidor "o que mudou
// desde a ultima vez?" (GET /api/vfs/changes). Ele devolve so as PASTAS que
// mudaram, no caminho de EXIBICAO do mount — e damos vfs/refresh em cada uma.
// Leve: numa janela tipica muda 1-2 pastas; refresh de 1 pasta e barato e NAO
// mexe no cache dos arquivos ja baixados (as fixas continuam quentes).
const CHANGES_POLL_MS = 45000;      // pergunta a cada 45s
const CHANGES_OVERLAP_MS = 30000;   // recuo de seguranca (skew/commit atrasado)
let changesTimer = null;
let changesSince = null;
let changesBusy = false;

async function pollChangesOnce() {
  if (changesBusy || !rcloneProc || mountState.status !== 'mounted') return;
  changesBusy = true;
  try {
    const since = changesSince || new Date(Date.now() - 60000).toISOString();
    const out = await api('/vfs/changes?since=' + encodeURIComponent(since), { method: 'GET', withSession: true });
    if (!out || out.ok !== true) return;   // rede/sessao: tenta no proximo ciclo
    // Avanca o marcador COM RECUO — refresh repetido e barato; perder mudanca nao.
    if (out.now) {
      const t = Date.parse(out.now);
      changesSince = isFinite(t) ? new Date(t - CHANGES_OVERLAP_MS).toISOString() : since;
    }
    const dirs = Array.isArray(out.dirs) ? out.dirs : [];
    if (dirs.length === 0) return;
    pinLog('changes: ' + dirs.length + ' pasta(s) mudaram — atualizando listagem');
    let refreshRoot = false;
    for (const d of dirs) {
      if (!rcloneProc) break;
      if (d === '' || d === '/') { refreshRoot = true; continue; }
      await rcCall('vfs/refresh', { dir: String(d).replace(/\\/g, '/'), recursive: 'false' });
    }
    if (refreshRoot) await rcCall('vfs/refresh', { recursive: 'false' });
    await pollSyncOnce();
  } catch (_) { /* best-effort: nunca derruba o app */ }
  finally { changesBusy = false; }
}

function startChangesPoll() {
  stopChangesPoll();
  // Ao conectar o mount ja mostra o estado atual (dir-cache novo); o poller so
  // precisa pegar o que mudar DAQUI PRA FRENTE — comeca no ultimo minuto.
  changesSince = new Date(Date.now() - 60000).toISOString();
  changesTimer = setInterval(pollChangesOnce, CHANGES_POLL_MS);
  setTimeout(pollChangesOnce, 5000);   // 1a sondagem logo apos montar (RC ja subiu)
}
function stopChangesPoll() {
  if (changesTimer) { clearInterval(changesTimer); changesTimer = null; }
  changesBusy = false;
}

// ══════════════════════════════════════════════════════════════════════
// FIXAR PASTAS (pin) — mantém uma pasta sempre baixada no computador, pra
// abrir instantâneo (o INDD + a pasta de imagens). Guardamos os caminhos
// RELATIVOS ao drive (sobrevivem à troca de letra) e "pré-aquecemos" o cache
// do rclone lendo os arquivos (com --vfs-cache-mode full, ler = baixar).
// ══════════════════════════════════════════════════════════════════════

let pinTimer = null;
let pinWarm = { warming: false, done: 0, total: 0 };

function cacheRootDir() { return path.join(app.getPath('userData'), 'rclone-cache'); }

function emitPins() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('drive:pins', { pins: readStore().pins || [], warm: pinWarm });
  }
}

// Caminho RELATIVO ao ponto de montagem (sem a letra/raiz), com separador do SO.
function relToMount(abs, mp) {
  const norm = String(abs).replace(/[\\/]+$/, '');
  if (norm.toLowerCase() === mp.toLowerCase()) return '';
  if (!norm.toLowerCase().startsWith(mp.toLowerCase())) return null; // fora do drive
  return norm.slice(mp.length).replace(/^[\\/]+/, '');
}

// Percorre a pasta (recursivo) e entrega cada arquivo.
async function walkFiles(absDir, onFile) {
  let names;
  // GOTCHA: no mount FUSE (rclone) o readdir com { withFileTypes:true } pode
  // devolver o tipo como DESCONHECIDO → isDirectory()/isFile() ambos falsos e a
  // pasta inteira é pulada. Por isso lemos só os NOMES e damos stat em cada um.
  try { names = await fs.promises.readdir(absDir); }
  catch (e) { pinLog('readdir FALHOU ' + absDir + ': ' + (e && (e.message || e))); return; }
  for (const name of names) {
    if (!rcloneProc) return; // desmontou no meio
    const p = path.join(absDir, name);
    let st;
    try { st = await fs.promises.stat(p); } catch (_) { continue; }
    if (st.isDirectory()) await walkFiles(p, onFile);
    else if (st.isFile()) await onFile(p);
  }
}

// Lê o arquivo inteiro pra puxar pro cache (descarta os bytes). Pula o que já
// está cacheado (arquivo de cache com o mesmo tamanho) — re-aquecer fica barato.
async function warmFile(abs, mp) {
  try {
    const st = await fs.promises.stat(abs);
    if (!st.size) return;
    const rel = relToMount(abs, mp);
    if (rel == null) return;
    const cachePath = path.join(cacheRootDir(), 'vfs', 'abel', ...rel.split(/[\\/]/));
    try {
      const cs = await fs.promises.stat(cachePath);
      if (cs.size === st.size) return; // já em cache
    } catch (_) {}
    await new Promise((resolve) => {
      const rs = fs.createReadStream(abs);
      rs.on('data', () => {});
      rs.on('end', resolve);
      rs.on('error', resolve);
    });
  } catch (_) {}
}

// Pré-aquece todas as pastas fixas (uma passada). Idempotente e best-effort.
// Lista os filhos DIRETOS de uma pasta (NÃO recursivo) via o RC do rclone —
// uma chamada por pasta, rápida e sem risco de timeout (o recursivo na coleção
// inteira estourava em ~5min = "context canceled"). Devolve {Path,IsDir,Size}[]
// ou null se falhar.
// Pré-aquece a LISTAGEM (dir cache do rclone) das pastas fixas, em background.
// Com --dir-cache-time alto, uma vez listada a pasta fica instantânea pra navegar
// no Explorer. Só as fixas (não a empresa toda). Fire-and-forget.
function refreshPinnedDirs() {
  const pins = readStore().pins || [];
  for (const rel of pins) {
    if (!rcloneProc) break;
    rcCall('vfs/refresh', { recursive: 'true', dir: String(rel).replace(/\\/g, '/') })
      .then((r) => pinLog('vfs/refresh ' + rel + ': ' + (r ? 'ok' : 'sem resposta')))
      .catch(() => {});
  }
}

async function rcListDir(rel) {
  const r = await rcCall('operations/list', {
    fs: 'abel:', remote: String(rel).replace(/\\/g, '/'), opt: { recurse: false },
  });
  if (!r || !Array.isArray(r.list)) return null;
  return r.list;
}

// Pré-aquece as pastas fixas em ONDAS (BFS): lista pasta por pasta e vai baixando
// os arquivos conforme descobre, em paralelo. Assim nunca dá timeout (cada lista
// é 1 pasta), o progresso aparece na hora e aguenta qualquer tamanho de árvore.
async function warmPins(attempt = 0) {
  if (!rcloneProc || pinWarm.warming) return;
  const mp = mountState.mountPoint;
  if (!mp) return;
  const pins = readStore().pins || [];
  if (pins.length === 0) { pinWarm = { warming: false, listing: false, done: 0, total: 0 }; emitPins(); return; }

  pinWarm = { warming: true, listing: true, done: 0, total: 0 };
  emitPins();
  pinLog('warm início (ondas) — ' + JSON.stringify(pins) + (attempt ? ' (tentativa ' + (attempt + 1) + ')' : ''));

  const dirQueue = pins.map((r) => String(r).replace(/\\/g, '/'));  // rel POSIX
  const fileQueue = [];  // caminhos no mount a baixar
  let listedDirs = 0;

  // LISTER: BFS, uma pasta por vez (rápido, sem timeout).
  const lister = (async () => {
    while (dirQueue.length && rcloneProc) {
      const rel = dirQueue.shift();
      const items = await rcListDir(rel);
      if (!items) { pinLog('list falhou/vazio: ' + rel); continue; }
      listedDirs++;
      for (const it of items) {
        // GOTCHA: operations/list devolve Path COMPLETO (relativo à raiz do
        // drive), não relativo ao pai. Se já vier com o prefixo do pai, usa como
        // está; senão completa. (Sem isso o caminho dobrava → 404 em tudo.)
        const p = String(it.Path).replace(/\\/g, '/');
        const childRel = p.startsWith(rel + '/') ? p : rel + '/' + p;
        if (it.IsDir) dirQueue.push(childRel);
        else { fileQueue.push(mountJoin(mp, childRel)); pinWarm.total++; }
      }
      emitPins();
    }
    pinWarm.listing = false;
    pinLog('listagem concluída — ' + listedDirs + ' pasta(s), ' + pinWarm.total + ' arquivo(s)');
  })();

  // DOWNLOADERS: N workers baixam da fila conforme ela enche.
  const CONC = 4;
  const worker = async () => {
    while (rcloneProc) {
      if (fileQueue.length === 0) {
        if (!pinWarm.listing) break;                    // listou tudo e fila vazia
        await new Promise((res) => setTimeout(res, 300)); // espera descobrir mais
        continue;
      }
      const f = fileQueue.shift();
      await warmFile(f, mp);
      pinWarm.done++;
      emitPins();   // a cada arquivo → barra anda suave
    }
  };
  await Promise.all([lister, ...Array.from({ length: CONC }, () => worker())]);

  // Nada listado (mount pode não estar pronto) → tenta de novo.
  if (pinWarm.total === 0 && attempt < 3 && rcloneProc) {
    pinWarm = { warming: false, listing: false, done: 0, total: 0 };
    emitPins();
    pinLog('0 arquivos — nova tentativa em 4s');
    setTimeout(() => warmPins(attempt + 1), 4000);
    return;
  }

  pinLog('warm concluído — ' + pinWarm.done + '/' + pinWarm.total);
  pinWarm = { warming: false, listing: false, done: 0, total: 0 };
  emitPins();
}

function startPinLoop() {
  if (pinTimer) clearInterval(pinTimer);
  // Re-aquece de tempos em tempos pra segurar o cache (antes do max-age de 24h).
  pinTimer = setInterval(warmPins, 3 * 60 * 60 * 1000);
}
function stopPinLoop() {
  if (pinTimer) { clearInterval(pinTimer); pinTimer = null; }
  pinWarm = { warming: false, done: 0, total: 0 };
}

// Abre o seletor de pasta (dentro do drive) e fixa a escolhida.
async function pinAdd() {
  const mp = mountState.mountPoint;
  if (!mp || mountState.status !== 'mounted') return { ok: false, error: 'Conecte o drive primeiro.' };
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolha uma pasta do Abel Drive para deixar sempre no computador',
    defaultPath: mp,
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: true };
  const rel = relToMount(r.filePaths[0], mp);
  if (rel == null) return { ok: false, error: 'Escolha uma pasta de dentro do Abel Drive.' };
  if (!rel) return { ok: false, error: 'Escolha uma subpasta (não a raiz do drive).' };
  const pins = readStore().pins || [];
  if (!pins.some((p) => p.toLowerCase() === rel.toLowerCase())) {
    pins.push(rel);
    writeStore({ pins });
  }
  emitPins();
  warmPins();
  return { ok: true, rel };
}

function pinRemove(rel) {
  const pins = (readStore().pins || []).filter((p) => p.toLowerCase() !== String(rel).toLowerCase());
  writeStore({ pins });
  emitPins();
  return { ok: true };
}

ipcMain.handle('pins:list', () => ({ pins: readStore().pins || [], warm: pinWarm }));
ipcMain.handle('pins:add', () => pinAdd());
ipcMain.handle('pins:remove', (_e, rel) => pinRemove(rel));

// Acha o rclone: bin/ do projeto → recurso empacotado → PATH.
function rclonePath() {
  const candidates = [
    process.env.ABEL_RCLONE,
    path.join(__dirname, '..', 'bin', RCLONE_BIN),
    path.join(process.resourcesPath || '', 'bin', RCLONE_BIN),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'rclone'; // deixa o PATH resolver
}

// Abre o ponto de montagem no Explorer (Win) / Finder (Mac).
function openMount() {
  const mp = mountState.mountPoint;
  if (!mp) return;
  shell.openPath(IS_MAC ? mp : mp + '\\');
}

// ── WinFsp (driver que o rclone precisa pra montar drive no Windows) ────
// No Mac o equivalente é o FUSE-T (instalado à parte pelo usuário).

// Mac: precisa de um provedor FUSE — FUSE-T (userspace, SEM kext, recomendado
// e melhor no Apple Silicon/versões novas) ou macFUSE. Detecta pelos arquivos
// que cada um instala. Sem provedor, o rclone falha com "failed to mount FUSE
// fs" — que era exatamente o erro no Mac da Raquel (o stub antigo devolvia
// `true` cegamente, então o app nem avisava a causa).
function macFuseAvailable() {
  const markers = [
    '/usr/local/lib/libfuse-t.dylib',       // FUSE-T
    '/usr/local/lib/libfuse-t.2.dylib',     // FUSE-T
    '/Library/Application Support/fuse-t',   // FUSE-T
    '/Library/Filesystems/macfuse.fs',       // macFUSE
    '/usr/local/lib/libosxfuse.2.dylib',     // macFUSE (antigo)
  ];
  return markers.some((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

function winfspInstalled() {
  if (IS_MAC) return macFuseAvailable();
  try {
    // A chave de registro do WinFsp existe quando ele está instalado.
    require('child_process').execFileSync(
      'reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\WinFsp', '/v', 'InstallDir'],
      { stdio: 'ignore' }
    );
    return true;
  } catch (_) { return false; }
}

function winfspInstallerPath() {
  const cands = [
    path.join(__dirname, '..', 'bin', 'winfsp.msi'),
    path.join(process.resourcesPath || '', 'bin', 'winfsp.msi'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

// Roda o instalador do WinFsp ELEVADO (UAC aparece uma vez). Só necessário
// numa máquina que ainda não tem o driver.
function runWinfspInstaller(msi) {
  return new Promise((resolve) => {
    const ps = "Start-Process msiexec -ArgumentList '/i','\"" + msi + "\"','/passive','/norestart' -Verb RunAs -Wait";
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err) => resolve(!err));
  });
}

// Garante o WinFsp antes de montar. Se faltar e tivermos o instalador embutido,
// instala (com UAC). Se faltar e não tiver embutido, orienta o usuário.
async function ensureWinFsp() {
  if (winfspInstalled()) return { ok: true };
  if (IS_MAC) {
    // Sem FUSE no Mac não dá pra montar. Orienta e para (sem loop).
    return { ok: false, error: 'Falta o FUSE para o Mac. Instale o FUSE-T (fuse-t.github.io) e clique em Conectar de novo.' };
  }
  const msi = winfspInstallerPath();
  // Build sem o instalador bundlado (asset ausente / pacote antigo) → manual.
  if (!msi) return { ok: false, error: 'Falta o WinFsp. Instale-o em winfsp.dev e conecte de novo.' };
  // Msi presente + driver ausente → auto-instala (UAC aparece uma vez). Ao
  // concluir, ensureWinFsp devolve ok e o driveConnect SEGUE pro mount sozinho.
  setMount({ status: 'connecting', message: 'Instalando o WinFsp — aceite o pedido de permissão do Windows…' });
  await runWinfspInstaller(msi);
  // Recusou o UAC ou o install falhou → acionável e sem loop (mantém o link).
  if (!winfspInstalled()) {
    return { ok: false, error: 'Não consegui instalar o WinFsp automaticamente. Baixe em winfsp.dev, instale e clique em Conectar.' };
  }
  return { ok: true };
}

function confPath() { return path.join(app.getPath('userData'), 'rclone.conf'); }
function logFilePath() { return path.join(app.getPath('userData'), 'rclone.log'); }
function pinLog(msg) {
  try { fs.appendFileSync(logFilePath(), '[pin] ' + new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
}

// O rclone guarda a senha OBSCURECIDA (não em texto puro). Rodamos
// `rclone obscure <segredo>` para obter o valor e gravar no .conf.
function rcloneObscure(secret) {
  return new Promise((resolve, reject) => {
    execFile(rclonePath(), ['obscure', secret], { windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout).trim());
    });
  });
}

function writeRcloneConf(obscured) {
  const conf =
    '[abel]\n' +
    'type = webdav\n' +
    'url = ' + WEBDAV_URL + '\n' +
    'vendor = other\n' +
    'user = abel-drive\n' +          // o gateway só valida a senha; usuário é ignorado
    'pass = ' + obscured + '\n';
  fs.writeFileSync(confPath(), conf, 'utf8');
}

// Interpreta o log do rclone e vira aviso na tela (o valor sobre o mount cru).
function handleRcloneLog(text) {
  // Persiste o log da sessão em arquivo (o balão some rápido; o log fica).
  try { fs.appendFileSync(logFilePath(), String(text)); } catch (_) {}
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/\b423\b|Locked/i.test(line)) {
      toast('warn', 'Um arquivo está em uso por outra pessoa — sua alteração não foi salva no servidor. Feche sem salvar.');
    } else if (/ERROR/i.test(line) &&
               !/symlinks not supported|ListJSON|directory not found|context canceled|operations\/list|502|Bad Gateway/i.test(line)) {
      // Erros de listagem/timeout são ruído da sondagem do pin — não alarmam.
      toast('error', 'Problema no drive: ' + line.replace(/^.*ERROR\s*:?\s*/i, '').slice(0, 140));
    }
  }
}

// Reusa a credencial guardada se ainda válida (folga de 7 dias); senão gera
// uma nova e guarda. Evita criar uma credencial a cada "Conectar".
async function getCredentialSecret() {
  const s = readStore();
  if (s.cred_secret && s.cred_expires) {
    const exp = new Date(s.cred_expires).getTime();
    if (isFinite(exp) && exp - Date.now() > 7 * 24 * 60 * 60 * 1000) {
      return { ok: true, secret: s.cred_secret, reused: true };
    }
  }
  const cred = await api('/mountain-duck/credentials', {
    method: 'POST', body: { label: 'Abel Drive' }, withSession: true,
  });
  if (!cred.ok || !cred.data || !cred.data.secret) {
    // Distingue AUTH (401/403 → credencial/sessão inválida) de rede/transitório.
    // Só auth deve zerar a credencial guardada; rede não.
    const authFailed = cred._status === 401 || cred._status === 403;
    return { ok: false, error: cred.error || 'erro', authFailed };
  }
  const expires = cred.data.credential && cred.data.credential.expires_at;
  writeStore({ cred_secret: cred.data.secret, cred_expires: expires || null });
  return { ok: true, secret: cred.data.secret, reused: false };
}

// Cancela qualquer reconexão pendente e zera o contador (saída intencional,
// mount OK, ou desistência).
function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempt = 0;
}

// Agenda a próxima tentativa de reconexão com backoff. Chamado quando o rclone
// sai SEM ser a pedido. Não descarta credencial (rede ≠ auth) — isso só
// acontece se a tentativa voltar 401/403 lá em driveConnect.
function scheduleReconnect() {
  if (isQuitting) return;
  if (reconnectAttempt >= RECONNECT_MAX) {
    // Esgotou o backoff (rede longa demais). Cai pro modo manual, mas mantém a
    // credencial guardada — não foi auth, foi rede.
    reconnectAttempt = 0;
    setMount({ status: 'error', mountPoint: null,
      message: 'Não consegui reconectar. Clique em Conectar para tentar de novo.' });
    return;
  }
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  setMount({ status: 'reconnecting', mountPoint: null,
    message: 'Reconectando… (tentativa ' + reconnectAttempt + ' de ' + RECONNECT_MAX + ')' });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(runReconnect, delay);
}

// Uma tentativa de reconexão. Reusa credencial + cache. Se a credencial voltar
// 401/403, driveConnect descarta e para o loop (_authFailed). Falha transitória
// (rede, winfsp, rclone não subiu) reagenda com backoff. Sucesso vira 'mounted'
// ~3,5s depois (fica 'connecting' no meio-tempo → não reagenda).
async function runReconnect() {
  reconnectTimer = null;
  if (isQuitting || rcloneProc) return;
  const res = await driveConnect({ reconnecting: true });
  if (res && res.status === 'error' && !res._authFailed) scheduleReconnect();
}

async function driveConnect(opts) {
  if (rcloneProc) return mountState;
  // Numa reconexão a credencial e o cache já existem; só num disparo manual/auto
  // limpamos o backoff pendente pra recomeçar do zero.
  if (!opts || !opts.reconnecting) cancelReconnect();
  setMount({ status: 'connecting', message: 'Pegando sua credencial…' });
  // Começa um log limpo por sessão (pra capturar erros do mount).
  try { fs.writeFileSync(logFilePath(), '=== Abel Drive — sessão ' + new Date().toISOString() + ' ===\n'); } catch (_) {}

  const c = await getCredentialSecret();
  if (!c.ok) {
    if (c.authFailed) {
      // AUTENTICAÇÃO falhou (401/403): agora sim a credencial guardada não vale.
      // Zera pra gerar uma nova no próximo "Conectar" e para o loop de reconexão.
      writeStore({ cred_secret: null, cred_expires: null });
      cancelReconnect();
      setMount({ status: 'error', mountPoint: null,
        message: 'Sua credencial expirou. Clique em Conectar para entrar de novo.' });
      return { ...mountState, _authFailed: true };
    }
    // Rede/transitório: mantém a credencial; runReconnect reagenda com backoff.
    setMount({ status: 'error', message: 'Não consegui a credencial (' + c.error + ').' });
    return mountState;
  }

  // Só (re)escreve o rclone.conf quando a credencial é nova ou o conf sumiu.
  if (!c.reused || !fs.existsSync(confPath())) {
    let obscured;
    try {
      obscured = await rcloneObscure(c.secret);
    } catch (e) {
      setMount({ status: 'error', message: 'rclone não encontrado. Coloque o rclone na pasta bin do app.' });
      return mountState;
    }
    writeRcloneConf(obscured);
  }

  // Garante o WinFsp (Windows). Na 1ª vez, numa máquina sem o driver, instala.
  const wf = await ensureWinFsp();
  if (!wf.ok) { setMount({ status: 'error', message: wf.error }); return mountState; }

  setMount({ status: 'connecting', message: 'Montando o drive…' });
  const mountPoint = resolveMountPoint();
  // Mac: o rclone monta numa PASTA (~/Abel Drive) que precisa EXISTIR antes.
  // No Windows é uma letra de drive (não precisa criar). Sem isso o rclone
  // falhava com "stat ~/Abel Drive: no such file or directory".
  if (IS_MAC) { try { fs.mkdirSync(mountPoint, { recursive: true }); } catch (_) {} }
  // Cache PRÓPRIO do app (isolado do rclone manual, evita colisão de cache).
  const cacheDir = path.join(app.getPath('userData'), 'rclone-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  // RC em porta livre + senha aleatória (só pra LER o progresso de sync).
  const rcPort = await getFreePort();
  rcAddr = '127.0.0.1:' + rcPort;
  rcAuth = { user: 'abel', pass: crypto.randomBytes(18).toString('hex') };
  const args = [
    'mount', 'abel:', mountPoint,
    '--config', confPath(),
    '--cache-dir', cacheDir,
    '--vfs-cache-mode', 'full',
    '--vfs-cache-max-age', '9999h',    // pin = "sempre no PC": NÃO expira por idade.
                                       // (era 24h — o rclone descartava as fixas no
                                       // remount após reboot/máquina desligada a noite,
                                       // e o warmPins rebaixava a coleção inteira do zero.)
    '--vfs-cache-max-size', '100G',    // teto do cache: quando encher, o rclone descarta
                                       // o MENOS usado 1º; as fixas, re-aquecidas a cada
                                       // 3h (startPinLoop), ficam "quentes" e sobrevivem
                                       // à limpeza por tamanho. Ajustável conforme o disco.
    '--vfs-fast-fingerprint',          // fingerprint por mtime+tamanho (INDD grande)
    // ── afinação de performance (15/jul) ──────────────────────────────
    '--dir-cache-time', '1000h',       // cache agressivo: pasta já vista = instantâneo
                                       // (sem polling no WebDAV → mudança de OUTRO
                                       // usuário só aparece no remount/refresh; ok no
                                       // piloto, reavaliar p/ equipe com vfs/refresh)
    '--attr-timeout', '5s',            // cache de atributos do kernel
    '--vfs-read-ahead', '128M',        // lê adiante em leitura sequencial (abrir INDD)
    '--buffer-size', '32M',            // buffer em memória por arquivo
    '--vfs-read-chunk-size', '32M',    // baixa o arquivo em pedaços maiores (menos idas)
    '--transfers', '8',                // mais uploads/downloads em paralelo (sync + pin)
    '--log-level', 'INFO',             // detalhe pro log (capturamos em arquivo)
    '--volname', 'Abel Drive',
    '--rc',                            // liga o remote control (só leitura de stats)
    '--rc-addr', rcAddr,
    '--rc-user', rcAuth.user,
    '--rc-pass', rcAuth.pass,
  ];
  rcloneProc = spawn(rclonePath(), args, { windowsHide: true });
  rcloneProc.stdout.on('data', handleRcloneLog);
  rcloneProc.stderr.on('data', handleRcloneLog);
  rcloneProc.on('error', (e) => {
    rcloneProc = null;
    setMount({ status: 'error', message: 'Falha ao iniciar o rclone: ' + e.message });
  });
  rcloneProc.on('exit', (code) => {
    const wasIntentional = mountState.status === 'disconnecting';
    rcloneProc = null;
    stopSyncPoll();
    stopPinLoop();
    stopChangesPoll();
    rcAddr = null; rcAuth = null;
    if (wasIntentional || isQuitting) {
      // Saída a pedido (Desconectar) ou app fechando → nada de reconectar.
      cancelReconnect();
      setMount({ status: 'idle', mountPoint: null, message: '' });
    } else {
      // Saída INESPERADA (blip de rede, wifi trocado, notebook dormiu). NÃO
      // descarta a credencial — rede ≠ auth. Reconecta com backoff; a credencial
      // só é zerada se a próxima tentativa voltar 401/403 (em driveConnect).
      scheduleReconnect();
    }
  });

  // O mount não "termina" — fica rodando. Depois de alguns segundos sem crash,
  // consideramos montado.
  setTimeout(() => {
    if (rcloneProc) {
      reconnectAttempt = 0; // montou de novo → zera o backoff da reconexão
      setMount({ status: 'mounted', mountPoint, message: 'Conectado' });
      // Pré-lê a raiz do drive pra "esquentar" a listagem no cache do rclone —
      // assim o Finder/Explorer já abre mostrando as coleções, reduzindo a
      // janela vazia / a demora na 1ª abertura no Mac. Best-effort: não bloqueia
      // e NÃO mexe em opção de mount (sem o risco que o `-o local` trouxe).
      fs.promises.readdir(mountPoint).catch(() => {});
      startSyncPoll();
      warmPins();          // baixa o conteúdo das pastas fixas
      refreshPinnedDirs(); // e pré-aquece a listagem delas (navegar = instantâneo)
      startPinLoop();      // re-aquece periodicamente
      startChangesPoll();  // auto-refresh: arquivo novo do colega aparece sozinho
    }
  }, 3500);

  return mountState;
}

function driveDisconnect() {
  if (!rcloneProc) { setMount({ status: 'idle', mountPoint: null, message: '' }); return mountState; }
  setMount({ status: 'disconnecting', message: 'Desconectando…' });
  try { rcloneProc.kill(); } catch (_) {}
  return mountState;
}

ipcMain.handle('drive:connect', () => driveConnect());
ipcMain.handle('drive:disconnect', () => driveDisconnect());
ipcMain.handle('drive:status', () => mountState);
ipcMain.handle('drive:syncState', () => syncState);
ipcMain.handle('drive:open', () => { openMount(); return { ok: true }; });

// Forca o drive a largar a lista de pastas em cache e reler do servidor agora.
// E o conserto do "vejo Tudo sincronizado mas falta arquivo": o WebDAV nao
// avisa mudancas de fora, entao a listagem fica velha ate isso rodar.
ipcMain.handle('drive:refresh', async () => {
  if (mountState.status !== 'mounted') return { ok: false, error: 'Conecte o drive primeiro.' };
  // Atualiza a LISTAGEM relendo do servidor, SEM despejar o cache inteiro.
  //
  // ANTES chamava `vfs/forget {}` sem alvo: isso manda o rclone esquecer TODO o
  // cache (listagens E arquivos ja baixados, inclusive as pastas fixas). Depois
  // de um clique, o drive inteiro fica "frio" — cada navegacao/abertura/salvamento
  // volta a bater no servidor pela internet -> tudo lento. Era a causa da lentidao.
  //
  // `vfs/refresh` re-le a pasta do servidor e ja detecta arquivo novo/substituido
  // (fingerprint por mtime+tamanho), mantendo o que ja esta em cache. Fazemos a
  // raiz (rapido) + as pastas fixas (recursivo), que sao a area de trabalho real.
  await rcCall('vfs/refresh', { recursive: 'false' });   // raiz — rapido
  refreshPinnedDirs();                                   // pastas fixas — recursivo
  await pollSyncOnce();
  return { ok: true, pending: syncState.pending, uploading: syncState.state === 'uploading' };
});

// ══════════════════════════════════════════════════════════════════════
// SINCRONIZAÇÃO (Abel Drive 2.0 — Fase 1): "Deixar um livro no computador"
// ----------------------------------------------------------------------
// Baixa a pasta INTEIRA (conferindo cada arquivo) pra uma pasta local de
// verdade em Documentos/Abel Drive, mantém em dia pelo /changes e sobrevive a
// reiniciar. ADITIVO: não mexe no mount nem na tela. UI mínima pela bandeja +
// diálogos nativos (a tela bonita entra numa fase posterior).
// ══════════════════════════════════════════════════════════════════════

const SYNC_CONC = 6;
let syncBusy = false;
let syncProgress = null;   // { book, done, total, bytesDone, bytesTotal, errors }
let syncUpdTimer = null;

function syncRootDir() { return path.join(app.getPath('documents'), 'Abel Drive'); }
function syncLocalDirFor(displayPath) { return path.join(syncRootDir(), ...String(displayPath).split('/')); }
function humanBytes(b) { b = Number(b) || 0; return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(0) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }
function apiGet(pathname) { return api(pathname, { method: 'GET', withSession: true }); }

// Linha rica de progresso do download: % + tamanho + tempo estimado.
function syncProgressLine() {
  if (!syncProgress) return '';
  const p = syncProgress;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  let eta = '';
  const elapsed = (Date.now() - (p.startAt || Date.now())) / 1000;
  if (elapsed > 3 && p.bytesDone > 0 && p.bytesTotal > 0) {
    const rate = p.bytesDone / elapsed;
    const remain = Math.max(0, p.bytesTotal - p.bytesDone);
    const secs = rate > 0 ? remain / rate : 0;
    eta = secs > 90 ? ' · ~' + Math.round(secs / 60) + ' min' : ' · ~' + Math.max(1, Math.round(secs)) + ' s';
  }
  return p.book + ' — ' + pct + '% · ' + humanBytes(p.bytesDone) + '/' + humanBytes(p.bytesTotal) + eta;
}

// Espaço livre no volume de destino (sobe até um diretório que exista).
function freeBytesAt(dir) {
  try {
    let probe = dir;
    while (probe && !fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
    const st = fs.statfsSync(probe);
    return st.bavail * st.bsize;
  } catch (_) { return null; }
}

// Mede um livro/pasta (via /manifest): total de bytes + lista de arquivos.
async function syncMeasure(displayPath) {
  const m = await apiGet('/vfs/manifest?path=' + encodeURIComponent(displayPath));
  if (!m || m.ok !== true) return { ok: false, error: (m && (m.error || m.message)) || 'ERRO' };
  return { ok: true, total_bytes: m.total_bytes, file_count: m.file_count, files: m.files || [], collection: m.collection, base_phys: m.base_phys };
}

// ── baseline por arquivo (sidecar .abel-sync.json no livro) — sustenta a
//    detecção de edição/conflito da Fase 3 ────────────────────────────────
function syncSidecarPath(localDir) { return path.join(localDir, '.abel-sync.json'); }
async function saveSidecar(localDir, sc) { try { await fs.promises.writeFile(syncSidecarPath(localDir), JSON.stringify(sc), 'utf8'); } catch (_) {} }
async function loadSidecar(localDir) { try { return JSON.parse(await fs.promises.readFile(syncSidecarPath(localDir), 'utf8')); } catch (_) { return null; } }

// Baixa 1 arquivo (segue o 302 pro link assinado) conferindo o tamanho. Grava
// em .part e só renomeia pro nome final DEPOIS de conferir — nunca deixa um
// arquivo pela metade com o nome real (é o que mata a imagem em branco).
async function downloadBlob(blobKey, destPath, expectedSize) {
  // Re-tenta erros transitórios (rede, 5xx do gateway, escrita, tamanho) com um
  // respiro crescente. Erro definitivo (ex.: 404) não insiste. É o que endurece
  // contra os "502" que a gente diagnosticou.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await downloadBlobOnce(blobKey, destPath, expectedSize);
    if (r.ok) return r;
    const transient = r.error === 'NETWORK' || r.error === 'WRITE' || r.error === 'SIZE_MISMATCH' || /^HTTP_5/.test(String(r.error));
    if (!transient) return r;
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  return { ok: false, error: 'RETRY_EXHAUSTED' };
}

async function downloadBlobOnce(blobKey, destPath, expectedSize) {
  const s = readStore();
  const headers = {};
  if (s.session_id) headers['x-session-id'] = s.session_id;
  let res;
  try { res = await fetch(API_BASE + '/vfs/blob?key=' + encodeURIComponent(blobKey), { headers }); }
  catch (_) { return { ok: false, error: 'NETWORK' }; }
  if (!res.ok || !res.body) return { ok: false, error: 'HTTP_' + res.status };
  try { await fs.promises.mkdir(path.dirname(destPath), { recursive: true }); } catch (_) {}
  const tmp = destPath + '.part';
  try {
    const { Readable } = require('stream');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      Readable.fromWeb(res.body).pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
  } catch (_) { try { fs.unlinkSync(tmp); } catch (_) {} return { ok: false, error: 'WRITE' }; }
  try {
    const st = await fs.promises.stat(tmp);
    if (expectedSize != null && st.size !== Number(expectedSize)) { try { fs.unlinkSync(tmp); } catch (_) {} return { ok: false, error: 'SIZE_MISMATCH' }; }
    await fs.promises.rename(tmp, destPath);
    return { ok: true, size: st.size };
  } catch (_) { try { fs.unlinkSync(tmp); } catch (_) {} return { ok: false, error: 'VERIFY' }; }
}

// Baixa o livro inteiro (N em paralelo). Pula o que já está com o tamanho certo
// (retomar/re-sync é barato). prune=true apaga local o que não existe mais.
async function syncDownload(displayPath, manifest, { prune = false, protectAfterMs = 0 } = {}) {
  if (syncBusy) return { ok: false, error: 'BUSY' };
  syncBusy = true;
  const localDir = syncLocalDirFor(displayPath);
  const files = manifest.files || [];
  syncProgress = { book: displayPath, done: 0, total: files.length, bytesTotal: Number(manifest.total_bytes) || 0, bytesDone: 0, errors: 0, startAt: Date.now() };
  refreshTray();
  try { new Notification({ title: 'Abel Drive', body: 'Baixando ' + displayPath + '…', silent: true }).show(); } catch (_) {}
  let idx = 0;
  const worker = async () => {
    while (true) {
      const i = idx++; if (i >= files.length) break;
      const f = files[i];
      const dest = path.join(localDir, ...String(f.rel).split('/'));
      try {
        const st = await fs.promises.stat(dest);
        if (f.size != null && st.size === Number(f.size)) { syncProgress.done++; syncProgress.bytesDone += Number(f.size) || 0; continue; }
        // SEGURANÇA (base da Fase 3): NÃO sobrescrever uma edição LOCAL sua. Se o
        // arquivo local foi modificado depois da última sincronização, é trabalho
        // seu — pula (o envio ao servidor / conflito é tratado na Fase 3). Nunca
        // clobbera o que você editou.
        if (protectAfterMs && st.mtimeMs > protectAfterMs) { syncProgress.done++; pinLog('sync protegeu edição local: ' + f.rel); continue; }
      } catch (_) {}
      const r = await downloadBlob(f.blob_key, dest, f.size);
      if (r.ok) syncProgress.bytesDone += Number(f.size) || 0;
      else { syncProgress.errors++; pinLog('sync erro ' + f.rel + ': ' + r.error); }
      syncProgress.done++;
      if (tray) { try { tray.setToolTip('Abel Drive — ' + syncProgressLine()); } catch (_) {} }
      if (syncProgress.done % 20 === 0) refreshTray();
    }
  };
  await Promise.all(Array.from({ length: SYNC_CONC }, () => worker()));

  // Prune SEGURO: apaga só o que SUMIU DO SERVIDOR — arquivos que estavam na
  // baseline anterior (sidecar) e não estão mais no manifesto. NUNCA toca em
  // arquivos que existem só localmente (cópias de conflito, arquivos novos seus),
  // nem em algo que você editou depois da última sync. Só roda se a lista veio
  // não-vazia e o download não teve erro.
  if (prune && files.length > 0 && syncProgress.errors === 0) {
    const prev = await loadSidecar(localDir);
    if (prev && prev.files) {
      const nowSet = new Set(files.map((f) => String(f.rel)));
      for (const rel of Object.keys(prev.files)) {
        if (nowSet.has(rel)) continue;
        const full = path.join(localDir, ...rel.split('/'));
        try { const st = await fs.promises.stat(full); if (protectAfterMs && st.mtimeMs > protectAfterMs) continue; } catch (_) {}
        try { await fs.promises.unlink(full); pinLog('sync removeu (sumiu do servidor): ' + full); } catch (_) {}
      }
    }
  }

  const errs = syncProgress.errors;
  const syncedAt = Date.now();
  const colName = manifest.collection || displayPath.split('/')[0];
  const basePhys = manifest.base_phys || '';
  // baseline por arquivo (tamanho + mtime local + "serverAt" = quando o servidor
  // tinha aquela versão). É o que sustenta a detecção de edição e conflito.
  try {
    const sc = { syncedAt, collection: colName, base_phys: basePhys, files: {} };
    for (const f of files) {
      try { const st = await fs.promises.stat(path.join(localDir, ...String(f.rel).split('/'))); sc.files[f.rel] = { size: st.size, mtime: st.mtimeMs, serverAt: f.updated_at || null }; } catch (_) {}
    }
    await saveSidecar(localDir, sc);
  } catch (e) { pinLog('sync sidecar falhou: ' + (e && e.message)); }
  const arr = (readStore().synced || []).filter((s) => s.path.toLowerCase() !== displayPath.toLowerCase());
  arr.push({ path: displayPath, localDir, at: new Date().toISOString(), syncedAt, collection: colName, base_phys: basePhys, fileCount: files.length, bytesTotal: Number(manifest.total_bytes) || 0, changesSince: new Date(Date.now() - 60000).toISOString() });
  writeStore({ synced: arr });
  syncProgress = null; syncBusy = false;
  refreshTray();
  try { new Notification({ title: 'Abel Drive', body: errs ? ('Baixado com ' + errs + ' aviso(s): ' + displayPath) : ('Pronto no computador: ' + displayPath), silent: true }).show(); } catch (_) {}
  return { ok: true, errors: errs, localDir };
}

// Fluxo "Deixar um livro no computador" (bandeja): escolher pasta no drive →
// medir → checar disco → confirmar → baixar.
async function syncAddFlow() {
  const mp = mountState.mountPoint;
  if (!mp || mountState.status !== 'mounted') { dialog.showMessageBox({ type: 'info', message: 'Conecte o drive primeiro pra escolher um livro.' }); return; }
  if (syncBusy) { dialog.showMessageBox({ type: 'info', message: 'Já estou baixando um livro. Espere terminar.' }); return; }
  const r = await dialog.showOpenDialog({ title: 'Escolha um livro/pasta do Abel Drive para deixar no computador', defaultPath: mp, properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return;
  const rel = relToMount(r.filePaths[0], mp);
  if (rel == null) { dialog.showMessageBox({ type: 'warning', message: 'Escolha uma pasta de dentro do Abel Drive (' + mp + ').' }); return; }
  if (!rel) { dialog.showMessageBox({ type: 'warning', message: 'Escolha uma subpasta (um livro), não a raiz do drive.' }); return; }
  const displayPath = rel.replace(/\\/g, '/');
  const m = await syncMeasure(displayPath);
  if (!m.ok) { dialog.showMessageBox({ type: 'error', message: 'Não consegui medir este livro.', detail: displayPath + '\n(' + m.error + ')' }); return; }
  const free = freeBytesAt(syncRootDir());
  const detail = displayPath + '\n\n' + m.file_count + ' arquivos · ' + humanBytes(m.total_bytes) + (free != null ? ('\nEspaço livre no disco: ' + humanBytes(free)) : '');
  if (free != null && free < m.total_bytes * 1.1) { dialog.showMessageBox({ type: 'warning', message: 'Espaço insuficiente pra baixar este livro.', detail }); return; }
  const c = await dialog.showMessageBox({ type: 'question', buttons: ['Baixar', 'Cancelar'], defaultId: 0, cancelId: 1, message: 'Deixar este livro no computador?', detail });
  if (c.response !== 0) return;
  syncDownload(displayPath, m).catch((e) => pinLog('sync falhou: ' + (e && e.message)));
}

// "Liberar espaço": apaga a cópia local (o servidor continua com tudo).
async function syncRemoveFlow(entry) {
  const c = await dialog.showMessageBox({ type: 'question', buttons: ['Liberar espaço', 'Cancelar'], defaultId: 1, cancelId: 1, message: 'Apagar a cópia local deste livro?', detail: entry.path + '\n\nSó apaga do seu computador — o servidor continua com tudo.' });
  if (c.response !== 0) return;
  try { await fs.promises.rm(entry.localDir, { recursive: true, force: true }); } catch (_) {}
  const arr = (readStore().synced || []).filter((s) => s.path.toLowerCase() !== entry.path.toLowerCase());
  writeStore({ synced: arr });
  refreshTray();
  try { new Notification({ title: 'Abel Drive', body: 'Espaço liberado: ' + entry.path, silent: true }).show(); } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════
// ESCRITA (Fase 3): suas edições SOBEM. Envio automático ligado por padrão.
// Sobe pelo caminho BLINDADO do gateway (trava 423 + snapshot de versão +
// conferência md5). Conflito = pergunta (opção 4) + guarda o lado não
// escolhido. Nunca perde trabalho — nem seu, nem do colega.
// ══════════════════════════════════════════════════════════════════════

function webdavAuthHeader() {
  const secret = readStore().cred_secret;
  if (!secret) return null;
  return 'Basic ' + Buffer.from('abel-drive:' + secret).toString('base64');
}
function webdavUrlFor(colName, within) {
  return WEBDAV_URL + '/' + encodeURIComponent(colName) + '/' + String(within).split('/').map(encodeURIComponent).join('/');
}

// Sobe um arquivo local pelo gateway (reusa a credencial WebDAV do mount).
async function uploadFileToServer(colName, within, filePath) {
  const auth = webdavAuthHeader();
  if (!auth) return { ok: false, error: 'NO_CRED' };
  let body;
  try { body = await fs.promises.readFile(filePath); } catch (_) { return { ok: false, error: 'READ' }; }
  let res;
  try {
    res = await fetch(webdavUrlFor(colName, within), {
      method: 'PUT',
      headers: { 'Authorization': auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
      body,
    });
  } catch (_) { return { ok: false, error: 'NETWORK' }; }
  if (res.status === 423) return { ok: false, error: 'LOCKED' };
  if (!res.ok) return { ok: false, error: 'HTTP_' + res.status };
  return { ok: true };
}

// Baixa a versão ATUAL do servidor (segue o 302 do WebDAV GET) pra um destino.
async function downloadServerVersion(colName, within, destPath) {
  const auth = webdavAuthHeader();
  if (!auth) return { ok: false, error: 'NO_CRED' };
  let res;
  try { res = await fetch(webdavUrlFor(colName, within), { headers: { 'Authorization': auth } }); }
  catch (_) { return { ok: false, error: 'NETWORK' }; }
  if (!res.ok || !res.body) return { ok: false, error: 'HTTP_' + res.status };
  try { await fs.promises.mkdir(path.dirname(destPath), { recursive: true }); } catch (_) {}
  try {
    const { Readable } = require('stream');
    await new Promise((resolve, reject) => { const out = fs.createWriteStream(destPath); Readable.fromWeb(res.body).pipe(out); out.on('finish', resolve); out.on('error', reject); });
    return { ok: true };
  } catch (_) { return { ok: false, error: 'WRITE' }; }
}

function syncFileInfo(colName, within) {
  return apiGet('/vfs/fileinfo?path=' + encodeURIComponent(colName + '/' + within));
}

// Detecta edições (por TAMANHO — evita disparo à toa por mtime) e arquivos novos.
async function syncScanEdits(localDir, sidecar) {
  const edited = [], created = [];
  const known = sidecar.files || {};
  for (const rel of Object.keys(known)) {
    try { const st = await fs.promises.stat(path.join(localDir, ...rel.split('/'))); if (st.size !== Number(known[rel].size)) edited.push(rel); } catch (_) {}
  }
  const knownSet = new Set(Object.keys(known).map((r) => path.join(localDir, ...r.split('/'))));
  const walk = async (dir, relBase) => {
    let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name === '.abel-sync.json' || e.name.endsWith('.part')) continue;
      if (/\((conflito|minha edição|servidor)/i.test(e.name)) continue;   // cópias de conflito não sobem
      const full = path.join(dir, e.name);
      const rel = relBase ? relBase + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(full, rel);
      else if (!knownSet.has(full)) created.push(rel);
    }
  };
  await walk(localDir, '');
  return { edited, created };
}

function conflictCopyName(filePath, tag) {
  const ext = path.extname(filePath);
  return filePath.slice(0, filePath.length - ext.length) + ' (' + tag + ')' + ext;
}

// Conflito (opção 4): pergunta com nome/horário, guarda o lado não escolhido.
async function syncHandleConflict(entry, sidecar, colName, rel, within, info) {
  const full = path.join(entry.localDir, ...rel.split('/'));
  const who = (info && info.updated_by_name) ? info.updated_by_name : 'outra pessoa';
  const when = info && info.updated_at ? new Date(info.updated_at).toLocaleString('pt-BR') : '';
  const r = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Ficar com a MINHA', 'Ficar com a do SERVIDOR', 'Decidir depois'],
    defaultId: 2, cancelId: 2,
    message: 'Conflito em ' + rel,
    detail: 'Você editou este arquivo, mas ' + who + ' subiu uma versão' + (when ? ' às ' + when : '') + '.\n\nO lado que você NÃO escolher fica guardado como cópia — nada se perde.',
  });
  if (r.response === 2) { pinLog('sync conflito adiado: ' + rel); return; }
  if (r.response === 0) {
    // MINHA vence: guarda a do servidor do lado, depois sobe a minha.
    await downloadServerVersion(colName, within, conflictCopyName(full, 'servidor de ' + who));
    const up = await uploadFileToServer(colName, within, full);
    if (up.ok) {
      const inf2 = await syncFileInfo(colName, within);
      let st; try { st = await fs.promises.stat(full); } catch (_) {}
      sidecar.files[rel] = { size: st ? st.size : (sidecar.files[rel] && sidecar.files[rel].size) || 0, mtime: st ? st.mtimeMs : Date.now(), serverAt: (inf2 && inf2.updated_at) || new Date().toISOString() };
      await saveSidecar(entry.localDir, sidecar);
      try { new Notification({ title: 'Abel Drive', body: 'Conflito resolvido (sua versão subiu): ' + rel, silent: true }).show(); } catch (_) {}
    } else { try { new Notification({ title: 'Abel Drive', body: 'Não consegui subir sua versão (' + up.error + '): ' + rel, silent: true }).show(); } catch (_) {} }
  } else {
    // SERVIDOR vence: guarda a minha do lado, depois baixo a do servidor por cima.
    try { await fs.promises.copyFile(full, conflictCopyName(full, 'minha edição')); } catch (_) {}
    const dl = await downloadServerVersion(colName, within, full);
    if (dl.ok) {
      const inf2 = await syncFileInfo(colName, within);
      let st; try { st = await fs.promises.stat(full); } catch (_) {}
      sidecar.files[rel] = { size: st ? st.size : 0, mtime: st ? st.mtimeMs : Date.now(), serverAt: (inf2 && inf2.updated_at) || new Date().toISOString() };
      await saveSidecar(entry.localDir, sidecar);
      try { new Notification({ title: 'Abel Drive', body: 'Conflito resolvido (versão do servidor): ' + rel, silent: true }).show(); } catch (_) {}
    }
  }
}

// Sobe suas edições locais de um livro. Ligado por padrão (readStore().syncUpload
// só desliga se for explicitamente false).
async function syncPushEdits(entry) {
  if (readStore().syncUpload === false) return;
  const localDir = entry.localDir;
  const sidecar = await loadSidecar(localDir);
  if (!sidecar) return;
  const colName = sidecar.collection || entry.collection || entry.path.split('/')[0];
  const base = sidecar.base_phys != null ? sidecar.base_phys : (entry.base_phys || '');
  const { edited, created } = await syncScanEdits(localDir, sidecar);
  const items = [...edited.map((r) => ({ rel: r })), ...created.map((r) => ({ rel: r }))];
  for (const it of items) {
    const rel = it.rel;
    const within = (base ? base + '/' : '') + rel;
    const full = path.join(localDir, ...rel.split('/'));
    let st; try { st = await fs.promises.stat(full); } catch (_) { continue; }
    const info = await syncFileInfo(colName, within);
    const baseServerAt = sidecar.files[rel] && sidecar.files[rel].serverAt ? Date.parse(sidecar.files[rel].serverAt) : 0;
    const serverChanged = info && info.ok && info.exists && info.updated_at && Date.parse(info.updated_at) > baseServerAt;
    if (serverChanged) { await syncHandleConflict(entry, sidecar, colName, rel, within, info); continue; }
    const up = await uploadFileToServer(colName, within, full);
    if (up.ok) {
      const inf2 = await syncFileInfo(colName, within);
      sidecar.files[rel] = { size: st.size, mtime: st.mtimeMs, serverAt: (inf2 && inf2.updated_at) || new Date().toISOString() };
      await saveSidecar(localDir, sidecar);
      pinLog('sync enviou: ' + rel);
    } else if (up.error === 'LOCKED') {
      try { new Notification({ title: 'Abel Drive', body: 'Arquivo aberto por outra pessoa — não enviei: ' + rel, silent: true }).show(); } catch (_) {}
    } else { pinLog('sync envio falhou ' + rel + ': ' + up.error); }
  }
}

// Atualizador: mantém os livros baixados em dia (usa o /changes; re-baixa só o
// que mudou e apaga o que sumiu). Um por vez, sem atrapalhar um download manual.
async function syncUpdaterTick() {
  if (syncBusy) return;
  const list = readStore().synced || [];
  for (const entry of list) {
    if (syncBusy) break;
    try {
      await syncPushEdits(entry);   // 1º: sobe SUAS edições locais (conferido + versão)
      const since = entry.changesSince || new Date(Date.now() - 60000).toISOString();
      const ch = await apiGet('/vfs/changes?since=' + encodeURIComponent(since));
      if (!ch || ch.ok !== true) continue;
      const nextSince = ch.now ? new Date(Date.parse(ch.now) - 30000).toISOString() : since;
      const dirs = Array.isArray(ch.dirs) ? ch.dirs : [];
      const p = entry.path.toLowerCase();
      const touched = dirs.some((d) => { const dl = String(d).toLowerCase(); return dl === p || dl.startsWith(p + '/'); });
      const store = readStore(); const arr = store.synced || []; const cur = arr.find((s) => s.path === entry.path);
      if (cur) { cur.changesSince = nextSince; writeStore({ synced: arr }); }
      if (!touched) continue;
      const m = await syncMeasure(entry.path);
      if (!m.ok) continue;
      await syncDownload(entry.path, m, { prune: true, protectAfterMs: entry.syncedAt || 0 });
    } catch (e) { pinLog('sync updater erro: ' + (e && e.message)); }
  }
}

function startSyncUpdater() {
  if (syncUpdTimer) return;
  syncUpdTimer = setInterval(() => { syncUpdaterTick().catch(() => {}); }, 90000);
  setTimeout(() => { syncUpdaterTick().catch(() => {}); }, 15000);
}

// Itens de bandeja dos livros baixados.
function buildSyncedItems() {
  const list = readStore().synced || [];
  if (!list.length) return [{ label: '(nenhum livro baixado ainda)', enabled: false }];
  return list.map((e) => ({
    label: e.path + '  (' + humanBytes(e.bytesTotal) + ')',
    submenu: [
      { label: 'Abrir a pasta', click: () => shell.openPath(e.localDir) },
      { label: 'Liberar espaço…', click: () => syncRemoveFlow(e) },
    ],
  }));
}

ipcMain.handle('sync:list', () => ({ synced: readStore().synced || [], progress: syncProgress }));
ipcMain.handle('sync:add', () => syncAddFlow());

// ══════════════════════════════════════════════════════════════════════
// BANDEJA (system tray) + auto-conectar + iniciar com o Windows
// ══════════════════════════════════════════════════════════════════════

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayMenu() {
  const st = mountState.status;
  const mounted = st === 'mounted';
  const busy = st === 'connecting' || st === 'disconnecting' || st === 'reconnecting';
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: mounted ? 'Drive conectado (' + (mountState.mountPoint || 'Z:') + ')' : 'Drive desconectado', enabled: false },
    { type: 'separator' },
    { label: 'Abrir o Abel Drive', click: showWindow },
    mounted
      ? { label: IS_MAC ? 'Abrir no Finder' : 'Abrir no Explorer', click: openMount }
      : { label: IS_MAC ? 'Abrir no Finder' : 'Abrir no Explorer', enabled: false },
    { type: 'separator' },
    mounted
      ? { label: 'Desconectar', click: () => driveDisconnect() }
      : { label: busy ? (st === 'reconnecting' ? 'Reconectando…' : 'Conectando…') : 'Conectar meu drive', enabled: !busy, click: () => driveConnect() },
    { type: 'separator' },
    ...(syncProgress ? [{ label: 'Baixando ' + syncProgressLine(), enabled: false }] : []),
    { label: 'Deixar um livro no computador…', enabled: mounted && !syncBusy, click: () => syncAddFlow() },
    { label: 'Livros no computador', submenu: buildSyncedItems() },
    { label: 'Enviar minhas edições automaticamente', type: 'checkbox', checked: readStore().syncUpload !== false, click: (item) => writeStore({ syncUpload: item.checked }) },
    { type: 'separator' },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Abrir log do drive', click: () => shell.openPath(logFilePath()) },
    { label: 'Sair', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  const st = mountState.status;
  tray.setToolTip('Abel Drive — ' + (st === 'mounted' ? 'conectado' : st === 'connecting' ? 'conectando…' : 'desconectado'));
}

function createTray() {
  if (tray) return;
  const raw = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  // Mac: o ícone vai pra BARRA DE MENU (topo) e precisa ser pequeno (~18px),
  // senão renderiza gigante/quebrado — foi o "erro na barra superior" do Mac.
  // Windows usa a bandeja, onde o tamanho cheio fica ok.
  const icon = (!raw.isEmpty() && IS_MAC) ? raw.resize({ width: 18, height: 18 }) : raw;
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on('click', showWindow);        // clique simples abre a janela
  tray.on('double-click', showWindow);
  refreshTray();
}

// ── Auto-update visível (status ao vivo + verificar manual + reiniciar) ──
let updateState = { status: 'idle', version: null, message: '' };
function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', updateState);
  }
}

let _updater = null;
function getUpdater() {
  if (_updater) return _updater;
  try { _updater = require('electron-updater').autoUpdater; }
  catch (_) { return null; }
  _updater.autoDownload = true;
  _updater.autoInstallOnAppQuit = true;
  _updater.on('checking-for-update', () => setUpdate({ status: 'checking', message: 'Procurando atualização…' }));
  _updater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i && i.version, message: 'Baixando a versão ' + (i && i.version) + '…' }));
  _updater.on('download-progress', (p) => setUpdate({ status: 'downloading', message: 'Baixando… ' + Math.round(p.percent || 0) + '%' }));
  _updater.on('update-not-available', () => setUpdate({ status: 'current', message: 'Você já está na versão mais recente.' }));
  _updater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i && i.version, message: 'Versão ' + (i && i.version) + ' pronta.' }));
  _updater.on('error', (e) => setUpdate({ status: 'error', message: 'Erro ao atualizar: ' + String((e && (e.message || e)) || 'desconhecido').slice(0, 180) }));
  return _updater;
}

function initAutoUpdate() {
  if (!app.isPackaged) { setUpdate({ status: 'dev', message: 'Atualização só na versão instalada.' }); return; }
  const u = getUpdater();
  if (!u) { setUpdate({ status: 'error', message: 'Módulo de atualização indisponível.' }); return; }
  u.checkForUpdates().catch(() => {});
}

ipcMain.handle('update:status', () => updateState);
ipcMain.handle('update:check', () => {
  if (!app.isPackaged) return { status: 'dev', message: 'Atualização só na versão instalada.' };
  const u = getUpdater();
  if (u) u.checkForUpdates().catch(() => {});
  return updateState;
});
ipcMain.handle('update:install', () => {
  const u = getUpdater();
  if (u && updateState.status === 'ready') { isQuitting = true; u.quitAndInstall(); }
  return { ok: true };
});

// Monta o drive sozinho ao abrir, se já houver sessão salva. Uma vez por
// execução (o did-finish-load dispara também em reloads).
function maybeAutoConnect() {
  if (didAutoConnect) return;
  didAutoConnect = true;
  const s = readStore();
  if (s.session_id && mountState.status === 'idle') {
    driveConnect();
  }
}

// ── janela ─────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 660,
    resizable: false,
    fullscreenable: false,
    title: 'Abel Drive',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#f0eeeb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Fechar a janela NÃO sai do app — esconde na bandeja (como Dropbox).
  // Só sai de verdade pelo "Sair" da bandeja (isQuitting).
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });

  // Depois que a UI carregou, monta o drive sozinho se já houver sessão.
  mainWindow.webContents.on('did-finish-load', maybeAutoConnect);
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  initAutoUpdate();
  startSyncUpdater();   // mantém os livros "deixados no computador" em dia

  // Notebook acordou: se estávamos reconectando (ou já caímos pra erro por
  // rede), tenta AGORA em vez de esperar o backoff. Não quebra se powerMonitor
  // não existir na plataforma.
  try {
    if (powerMonitor && typeof powerMonitor.on === 'function') {
      powerMonitor.on('resume', () => {
        if (isQuitting || rcloneProc) return;
        if (mountState.status === 'reconnecting' || mountState.status === 'error') {
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          reconnectAttempt = 0;
          runReconnect();
        }
      });
    }
  } catch (_) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Ao fechar o app, desmonta o drive (mata o rclone) para não deixar o Z:
// pendurado no Windows.
app.on('before-quit', () => {
  if (rcloneProc) { try { rcloneProc.kill(); } catch (_) {} }
});

app.on('window-all-closed', () => {
  // Não sai: o Abel Drive vive na bandeja. Sair só pelo menu da bandeja
  // (ou Cmd+Q no Mac, na fase M6b).
});
