'use strict';

// Abel Drive — lógica do renderer (só UI; a rede vive no processo principal).
// Fluxo: e-mail → (escolher empresa) → PIN (+ 2FA) → conectado.

const $ = (id) => document.getElementById(id);
const screens = ['screen-email', 'screen-company', 'screen-pin', 'screen-done'];

const state = { email: '', companies: [], companyId: null, user: null, company: null };

function show(screenId) {
  screens.forEach((s) => $(s).classList.toggle('hidden', s !== screenId));
  hideMsg();
}
function msg(text, kind = 'error') {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg show ' + kind;
}
function hideMsg() { $('msg').className = 'msg'; }

function busy(btn, on) { btn.classList.toggle('spin', on); btn.disabled = on; }

// Mensagens amigáveis para os códigos de erro conhecidos da API.
function friendly(err) {
  const map = {
    USER_NOT_FOUND: 'E-mail não encontrado. Confira e tente de novo.',
    NETWORK: 'Sem conexão com o Ecossistema. Verifique sua internet.',
    TOO_MANY_ATTEMPTS: 'Muitas tentativas. Aguarde alguns minutos.',
    PIN_INVALID: 'Código incorreto. Confira e tente de novo.',
    PIN_EXPIRED: 'O código expirou. Peça um novo.',
    PIN_NOT_REQUESTED: 'Peça um código primeiro (Reenviar código).',
    ACCOUNT_LOCKED: 'Conta bloqueada por tentativas. Aguarde 30 min.',
    TOTP_REQUIRED: 'Digite também o código do seu autenticador (2FA).',
    TOTP_INVALID: 'Código do autenticador incorreto.',
    COMPANY_BLOCKED: 'O acesso desta empresa está bloqueado.',
    COMPANY_SUSPENDED: 'A assinatura desta empresa está suspensa.',
    SESSION_INVALID: 'Sessão inválida. Faça login de novo.',
    INTERNAL_ERROR: 'Erro no servidor. Tente de novo em instantes.',
  };
  // Fallback mostra o código real — ajuda a diagnosticar erros novos.
  return map[err] || ('Não consegui entrar (' + (err || 'desconhecido') + ').');
}

// ── Tela 1: e-mail → identify ──────────────────────────────────────────
async function doIdentify() {
  const email = $('email').value.trim().toLowerCase();
  if (!email || !email.includes('@')) return msg('Digite um e-mail válido.');
  state.email = email;
  busy($('btn-email'), true);
  const r = await window.abel.identify(email);
  busy($('btn-email'), false);

  if (!r.ok) return msg(friendly(r.error));
  state.companies = r.companies || [];
  state.user = r.user || null;

  if (state.companies.length === 0) return msg('Nenhuma empresa vinculada a este e-mail.');
  if (state.companies.length === 1) {
    state.companyId = state.companies[0].id;
    state.company = state.companies[0];
    return requestPin();
  }
  renderCompanies();
  show('screen-company');
}

// ── Tela 2: escolher empresa ───────────────────────────────────────────
function renderCompanies() {
  const list = $('company-list');
  list.innerHTML = '';
  state.companies.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'company';
    b.innerHTML = `<span class="dot"></span><span>
      <span class="cname">${escapeHtml(c.name)}</span><br>
      <span class="crole">${escapeHtml(c.role || '')}</span></span>`;
    b.onclick = () => { state.companyId = c.id; state.company = c; requestPin(); };
    list.appendChild(b);
  });
}

// ── request-pin → Tela 3 ───────────────────────────────────────────────
async function requestPin() {
  msg('Enviando o código para o seu e-mail…', 'info');
  const r = await window.abel.requestPin(state.email, state.companyId);
  if (!r.ok) return msg(friendly(r.error));
  $('pin-email').textContent = state.email;
  $('pin').value = '';
  show('screen-pin');
  $('pin').focus();
}

// ── verify-pin → Tela 4 ────────────────────────────────────────────────
async function doVerify() {
  const pin = $('pin').value.trim();
  const totp = $('totp').value.trim();
  if (!pin) return msg('Digite o código que enviamos por e-mail.');
  busy($('btn-pin'), true);
  const r = await window.abel.verifyPin(state.email, pin, totp || null);
  busy($('btn-pin'), false);

  if (!r.ok) {
    // 2FA: revela o campo do autenticador quando o backend pede.
    if (r.error === 'TOTP_REQUIRED') $('totp-wrap').classList.remove('hidden');
    return msg(friendly(r.error));
  }

  // Guarda um retrato leve para a tela e para sessões futuras.
  const profile = {
    name: (state.user && state.user.display_name) || state.email,
    company: (state.company && state.company.name) || '',
  };
  await window.abel.setProfile(profile);
  $('done-name').textContent = 'Conectado como ' + profile.name;
  $('done-company').textContent = profile.company;
  show('screen-done');
  refreshDrive();
}

// ── logout ─────────────────────────────────────────────────────────────
async function doLogout() {
  await window.abel.logout();
  state.companyId = null; state.company = null;
  $('email').value = '';
  show('screen-email');
  $('email').focus();
}

// ── Drive: conectar / desconectar / status / avisos ────────────────────
let lastDriveStatus = 'idle';
function renderDrive(s) {
  const st = (s && s.status) || 'idle';
  lastDriveStatus = st;
  if (st !== 'mounted') { $('drive-sync').classList.add('hidden'); $('pins').classList.add('hidden'); }
  // Nova tentativa de conexão limpa o último erro mostrado.
  if (st === 'connecting') $('drive-error').className = 'drive-error hidden';
  const dot = $('drive-dot');
  dot.className = 'drive-dot' + (
    st === 'mounted' ? ' on' :
    st === 'error' ? ' err' :
    st === 'idle' ? '' : ' busy'
  );
  const labels = {
    idle: 'Drive desconectado',
    connecting: 'Conectando…',
    mounted: 'Conectado em ' + ((s && s.mountPoint) || 'Z:'),
    disconnecting: 'Desconectando…',
    error: 'Desconectado',
  };
  $('drive-label').textContent = labels[st] || 'Drive';
  $('drive-msg').textContent = (s && s.message) || '';

  const btn = $('btn-drive');
  const busy = (st === 'connecting' || st === 'disconnecting');
  btn.disabled = busy;
  btn.classList.toggle('spin', busy);
  if (st === 'mounted') {
    btn.textContent = 'Desconectar';
    btn.classList.remove('btn-primary'); btn.classList.add('btn-ghost');
    $('btn-drive-open').classList.remove('hidden');
  } else {
    btn.textContent = 'Conectar meu drive';
    btn.classList.add('btn-primary'); btn.classList.remove('btn-ghost');
    $('btn-drive-open').classList.add('hidden');
  }
}

function refreshDrive() {
  window.abel.driveStatus().then(renderDrive);
  window.abel.driveSyncState().then(renderSync);
  window.abel.pinsList().then(renderPins);
}

// ── pastas fixas (pin) ─────────────────────────────────────────────────
function refreshPins() { window.abel.pinsList().then(renderPins); }

function renderPins(s) {
  const box = $('pins');
  if (lastDriveStatus !== 'mounted') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const pins = (s && s.pins) || [];
  const warm = (s && s.warm) || {};
  const list = $('pins-list');
  list.innerHTML = '';

  if (pins.length === 0) {
    const e = document.createElement('div');
    e.className = 'pins-empty';
    e.textContent = 'Nenhuma pasta fixa ainda. Fixe uma obra ou coleção inteira para abrir tudo instantâneo (baixa e mantém local).';
    list.appendChild(e);
  } else {
    pins.forEach((rel) => {
      const name = String(rel).split(/[\\/]/).pop();
      const row = document.createElement('div');
      row.className = 'pin-row';
      row.innerHTML =
        '<span class="pin-dot"></span>' +
        '<span class="pin-name" title="' + escapeHtml(rel) + '">' + escapeHtml(name) + '</span>';
      const x = document.createElement('button');
      x.className = 'pin-x';
      x.textContent = '✕';
      x.title = 'Desafixar';
      x.onclick = async () => { await window.abel.pinRemove(rel); refreshPins(); };
      row.appendChild(x);
      list.appendChild(row);
    });
  }

  const prog = $('pins-progress');
  if (warm && warm.warming) {
    prog.classList.remove('hidden');
    const done = warm.done || 0, total = warm.total || 0;
    if (total === 0) {
      // ainda descobrindo os primeiros arquivos — não é 0/0 travado.
      $('pins-progress-text').textContent = 'Preparando… (listando arquivos)';
      $('pins-fill').style.width = '0%';
    } else if (warm.listing) {
      // já baixando, mas ainda descobrindo mais arquivos (árvore grande).
      $('pins-progress-text').textContent = 'Baixando… ' + done + '/' + total + ' (ainda listando)';
      $('pins-fill').style.width = Math.round((done / total) * 100) + '%';
    } else {
      $('pins-progress-text').textContent = 'Baixando para uso local… ' + done + '/' + total;
      $('pins-fill').style.width = Math.round((done / total) * 100) + '%';
    }
  } else {
    prog.classList.add('hidden');
  }
}

async function addPin() {
  const r = await window.abel.pinAdd();
  if (r && !r.ok && r.error) msg(r.error, 'info');
  refreshPins();
}

// ── progresso de sync (enviando… / tudo sincronizado) ──────────────────
function fmtSpeed(bps) {
  if (!bps || bps < 1) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = bps, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i] + '/s';
}

function renderSync(s) {
  const box = $('drive-sync');
  const st = (s && s.state) || 'idle';
  // Só mostra quando o drive está montado e há algo a dizer.
  if (lastDriveStatus !== 'mounted' || st === 'idle') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const dot = $('sync-dot');
  const bar = $('sync-bar');
  const fill = $('sync-fill');

  if (st === 'uploading') {
    dot.className = 'sync-dot up';
    const n = s.pending || s.transfers || 0;
    let t = n > 0 ? ('Enviando ' + n + (n === 1 ? ' arquivo' : ' arquivos') + '…') : 'Enviando…';
    if (s.percent != null) t += '  ' + s.percent + '%';
    const spd = fmtSpeed(s.speed);
    if (spd) t += ' · ' + spd;
    $('sync-text').textContent = t;
    if (s.percent != null) { bar.classList.remove('hidden'); fill.style.width = s.percent + '%'; }
    else { bar.classList.add('hidden'); }
  } else {
    // sincronizado (ou com erro de upload sendo retentado)
    dot.className = 'sync-dot ok';
    $('sync-text').textContent = (s.errored > 0)
      ? (s.errored + (s.errored === 1 ? ' arquivo com erro — tentando de novo' : ' arquivos com erro — tentando de novo'))
      : 'Tudo sincronizado';
    bar.classList.add('hidden');
  }
}

async function toggleDrive() {
  const s = await window.abel.driveStatus();
  if (s && s.status === 'mounted') await window.abel.driveDisconnect();
  else await window.abel.driveConnect();
}

let toastTimer = null;
function showToast(t) {
  const el = $('toast');
  el.textContent = t.text;
  el.className = 'toast ' + (t.kind || 'info');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 6000);
  // Persiste erros/avisos numa linha fixa embaixo do status (o balão some rápido,
  // isso fica até reconectar).
  if (t.kind === 'error' || t.kind === 'warn') {
    const err = $('drive-error');
    err.textContent = t.text;
    err.className = 'drive-error show' + (t.kind === 'warn' ? ' warn' : '');
  }
}

// ── Atualização ────────────────────────────────────────────────────────
function renderUpdate(s) {
  const box = $('update-box');
  const st = (s && s.status) || 'idle';
  const text = (s && s.message) || '';
  const installBtn = $('btn-update-install');
  if (!text || st === 'idle') {
    box.className = 'update-box hidden';
    installBtn.classList.add('hidden');
    return;
  }
  box.className = 'update-box' + (st === 'error' ? ' err' : st === 'ready' ? ' ready' : '');
  $('update-msg').textContent = text;
  installBtn.classList.toggle('hidden', st !== 'ready');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── ligações ───────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  $('btn-email').onclick = doIdentify;
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') doIdentify(); });

  $('btn-company-back').onclick = () => show('screen-email');

  $('btn-pin').onclick = doVerify;
  $('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
  $('totp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
  $('btn-pin-resend').onclick = requestPin;

  $('btn-logout').onclick = doLogout;

  $('btn-drive').onclick = toggleDrive;
  $('btn-drive-open').onclick = () => window.abel.driveOpen();
  window.abel.onDriveState(renderDrive);
  window.abel.onDriveToast(showToast);
  window.abel.onDriveSync(renderSync);
  window.abel.onPins(renderPins);
  $('btn-pin-add').onclick = addPin;

  window.abel.version().then((v) => {
    const el = $('app-version');
    if (el) el.textContent = 'Abel Drive · v' + v;
  });

  $('btn-update-check').onclick = () => { window.abel.updateCheck().then(renderUpdate); };
  $('btn-update-install').onclick = () => window.abel.updateInstall();
  window.abel.onUpdateState(renderUpdate);
  window.abel.updateStatus().then(renderUpdate);

  // Se já houver sessão guardada, pula direto para a tela conectado.
  const st = await window.abel.getState();
  if (st.hasSession && st.profile) {
    $('done-name').textContent = 'Conectado como ' + st.profile.name;
    $('done-company').textContent = st.profile.company || '';
    show('screen-done');
    refreshDrive();
  } else {
    show('screen-email');
    $('email').focus();
  }
});
