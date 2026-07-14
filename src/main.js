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

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const os = require('os');

// Base da API do Ecossistema (mesmo backend do /webdav validado no teste).
const API_BASE = 'https://ecossistema-abel-production.up.railway.app/api';
// Raiz do gateway WebDAV (lista as coleções que o usuário pode ver).
const WEBDAV_URL = 'https://ecossistema-abel-production.up.railway.app/webdav';

const IS_MAC = process.platform === 'darwin';
// Windows monta numa LETRA de drive; macOS (FUSE-T) monta numa PASTA.
const MOUNT_POINT = IS_MAC ? path.join(os.homedir(), 'Abel Drive') : 'Z:';
// Binário do rclone por plataforma (empacotado em bin/).
const RCLONE_BIN = IS_MAC ? 'rclone' : 'rclone.exe';

let mainWindow = null;
let tray = null;
let isQuitting = false;
let didAutoConnect = false;

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
  writeStore({ session_id: null, profile: null });
  return { ok: true };
});

// ══════════════════════════════════════════════════════════════════════
// DRIVE — credencial → rclone.conf → mount (rclone) → status
// ══════════════════════════════════════════════════════════════════════

let rcloneProc = null;
let mountState = { status: 'idle', mountPoint: null, message: '' };

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

function confPath() { return path.join(app.getPath('userData'), 'rclone.conf'); }

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
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/\b423\b|Locked/i.test(line)) {
      toast('warn', 'Um arquivo está em uso por outra pessoa — sua alteração não foi salva no servidor. Feche sem salvar.');
    } else if (/ERROR/i.test(line) && !/symlinks not supported/i.test(line)) {
      toast('error', 'Problema no drive: ' + line.replace(/^.*ERROR\s*:?\s*/i, '').slice(0, 140));
    }
  }
}

async function driveConnect() {
  if (rcloneProc) return mountState;
  setMount({ status: 'connecting', message: 'Pegando sua credencial…' });

  const cred = await api('/mountain-duck/credentials', {
    method: 'POST', body: { label: 'Abel Drive' }, withSession: true,
  });
  if (!cred.ok || !cred.data || !cred.data.secret) {
    setMount({ status: 'error', message: 'Não consegui gerar a credencial (' + (cred.error || 'erro') + ').' });
    return mountState;
  }

  let obscured;
  try {
    obscured = await rcloneObscure(cred.data.secret);
  } catch (e) {
    setMount({ status: 'error', message: 'rclone não encontrado. Coloque o rclone.exe na pasta bin do app.' });
    return mountState;
  }
  writeRcloneConf(obscured);

  setMount({ status: 'connecting', message: 'Montando o drive…' });
  // Cache PRÓPRIO do app (isolado do rclone manual, evita colisão de cache
  // entre remotes de mesmo nome apontando para caminhos diferentes).
  const cacheDir = path.join(app.getPath('userData'), 'rclone-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  const args = [
    'mount', 'abel:', MOUNT_POINT,
    '--config', confPath(),
    '--cache-dir', cacheDir,
    '--vfs-cache-mode', 'full',
    '--dir-cache-time', '10s',
    '--volname', 'Abel Drive',
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
    if (wasIntentional) setMount({ status: 'idle', mountPoint: null, message: '' });
    else setMount({ status: 'error', mountPoint: null, message: 'O drive desconectou (código ' + code + ').' });
  });

  // O mount não "termina" — fica rodando. Depois de alguns segundos sem crash,
  // consideramos montado.
  setTimeout(() => {
    if (rcloneProc) setMount({ status: 'mounted', mountPoint: MOUNT_POINT, message: 'Conectado' });
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
ipcMain.handle('drive:open', () => { openMount(); return { ok: true }; });

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
  const busy = st === 'connecting' || st === 'disconnecting';
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
      : { label: busy ? 'Conectando…' : 'Conectar meu drive', enabled: !busy, click: () => driveConnect() },
    { type: 'separator' },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
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
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on('click', showWindow);        // clique simples abre a janela
  tray.on('double-click', showWindow);
  refreshTray();
}

// Auto-update (só na versão instalada). require preguiçoso: em dev (npm start)
// o electron-updater pode nem estar instalado — não quebra.
function initAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { autoUpdater = require('electron-updater').autoUpdater; }
  catch (_) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', () => toast('info', 'Baixando uma atualização do Abel Drive…'));
  autoUpdater.on('update-downloaded', () => toast('info', 'Atualização pronta — será aplicada ao reiniciar o app.'));
  autoUpdater.on('error', (e) => console.error('[update]', e && (e.message || e)));
  autoUpdater.checkForUpdates().catch(() => {});
}

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
