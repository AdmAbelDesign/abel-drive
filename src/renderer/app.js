'use strict';

// Abel Drive — lógica do renderer (só UI; a rede vive no processo principal).
// Fluxo (desde 30/09/2026): e-mail → código (+ 2FA) → (escolher empresa) → conectado.
// A plataforma só mostra as empresas DEPOIS do código. Regras em login-flow.js.

const $ = (id) => document.getElementById(id);
const screens = ['screen-email', 'screen-company', 'screen-pin', 'screen-done'];

// pin/totp ficam guardados entre a 1a chamada do verify-pin e a escolha da
// empresa: a 2a chamada precisa do MESMO código (ele não é consumido).
const state = { email: '', companies: [], user: null, pin: '', totp: '' };

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
    NETWORK: 'Sem conexão com o Ecossistema. Verifique sua internet.',
    TOO_MANY_ATTEMPTS: 'Muitas tentativas. Aguarde alguns minutos.',
    PIN_INVALID: 'Código incorreto. Confira e tente de novo.',
    PIN_EXPIRED: 'Código vencido ou inválido. Peça um novo (Reenviar código).',
    PIN_NOT_REQUESTED: 'Peça um código primeiro (Reenviar código).',
    ACCOUNT_LOCKED: 'Conta bloqueada por tentativas. Aguarde 30 min.',
    TOTP_REQUIRED: 'Digite também o código do seu autenticador (2FA).',
    TOTP_INVALID: 'Código do autenticador incorreto.',
    COMPANY_BLOCKED: 'O acesso desta empresa está bloqueado.',
    COMPANY_SUSPENDED: 'A assinatura desta empresa está suspensa.',
    SEM_EMPRESA_ATIVA: 'Nenhuma empresa ativa disponível para esta conta.',
    ENDERECO_NAO_CONFERE: 'Esta conta não pertence a este endereço.',
    SESSION_INVALID: 'Sessão inválida. Faça login de novo.',
    INTERNAL_ERROR: 'Erro no servidor. Tente de novo em instantes.',
  };
  // Fallback mostra o código real — ajuda a diagnosticar erros novos.
  return map[err] || ('Não consegui entrar (' + (err || 'desconhecido') + ').');
}

// ── Tela 1: e-mail → request-pin ───────────────────────────────────────
async function doEmail() {
  const email = $('email').value.trim().toLowerCase();
  if (!email || !email.includes('@')) return msg('Digite um e-mail válido.');
  state.email = email;
  state.companies = []; state.user = null; state.pin = ''; state.totp = '';
  $('totp').value = '';
  $('totp-wrap').classList.add('hidden');
  busy($('btn-email'), true);
  await requestPin();
  busy($('btn-email'), false);
}

// ── request-pin → Tela do código ───────────────────────────────────────
// A resposta é a mesma exista ou não a conta ("se tiver conta, o código chega").
async function requestPin() {
  msg('Enviando o código para o seu e-mail…', 'info');
  const r = await window.abel.requestPin(state.email);
  if (!r.ok) return msg(friendly(r.error));
  $('pin-email').textContent = state.email;
  $('pin').value = '';
  show('screen-pin');
  msg('Se este e-mail tiver conta no Ecossistema, o código chega em instantes.', 'info');
  $('pin').focus();
}

// ── verify-pin (1a chamada, sem empresa) ───────────────────────────────
async function doVerify() {
  const pin = $('pin').value.trim();
  const totp = $('totp').value.trim();
  if (!pin) return msg('Digite o código que enviamos por e-mail.');
  state.pin = pin; state.totp = totp;
  busy($('btn-pin'), true);
  const r = await window.abel.verifyPin(state.email, pin, totp || null, null);
  busy($('btn-pin'), false);
  await handleVerify(r, null);
}

// ── Tela da empresa (só depois do código, quando há mais de uma) ───────
function renderCompanies() {
  const list = $('company-list');
  list.innerHTML = '';
  state.companies.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'company';
    b.innerHTML = `<span class="dot"></span><span>
      <span class="cname">${escapeHtml(c.name)}</span><br>
      <span class="crole">${escapeHtml(c.role || '')}</span></span>`;
    b.onclick = () => chooseCompany(c, b);
    list.appendChild(b);
  });
}

// verify-pin (2a chamada): a empresa escolhida + o MESMO código e 2FA.
async function chooseCompany(c, btn) {
  const all = document.querySelectorAll('#company-list .company');
  all.forEach((x) => { x.disabled = true; });
  busy(btn, true);
  const r = await window.abel.verifyPin(state.email, state.pin, state.totp || null, c.id);
  busy(btn, false);
  all.forEach((x) => { x.disabled = false; });
  await handleVerify(r, c);
}

async function handleVerify(r, chosen) {
  const res = window.AbelLogin.lerRespostaDoVerify(r);

  if (res.passo === 'escolher') {
    state.companies = res.companies;
    state.user = res.user;
    renderCompanies();
    show('screen-company');
    return;
  }

  if (res.passo === 'erro') {
    if (res.pedir2fa) $('totp-wrap').classList.remove('hidden');
    // Erro do código/2FA volta para a tela do código; erro da empresa
    // escolhida (bloqueada, suspensa) fica na lista para escolher outra.
    if (res.voltarAoCodigo || !chosen) {
      show('screen-pin');
      if (res.pedir2fa) $('totp').focus();
    }
    return msg(friendly(res.error));
  }

  // Entrou. Nome da pessoa e da empresa para a tela "conectado".
  const who = await window.abel.whoami();
  const profile = {
    name: (who && who.ok && who.name) || (state.user && state.user.display_name) || state.email,
    company: (who && who.ok && who.company) || (chosen && chosen.name) || '',
  };
  state.pin = ''; state.totp = '';
  await window.abel.setProfile(profile);
  $('done-name').textContent = 'Conectado como ' + profile.name;
  $('done-company').textContent = profile.company;
  show('screen-done');
  refreshDrive();
}

// ── logout ─────────────────────────────────────────────────────────────
async function doLogout() {
  await window.abel.logout();
  state.companies = []; state.user = null; state.pin = ''; state.totp = '';
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
  if (st === 'connecting' || st === 'mounted') $('drive-error').className = 'drive-error hidden';
  const dot = $('drive-dot');
  dot.className = 'drive-dot' + (
    st === 'mounted' ? ' on' :
    st === 'error' ? ' err' :
    st === 'idle' ? '' : ' busy'
  );
  const labels = {
    idle: 'Drive desconectado',
    connecting: 'Conectando…',
    reconnecting: 'Reconectando…',
    mounted: 'Conectado em ' + ((s && s.mountPoint) || 'Z:'),
    disconnecting: 'Desconectando…',
    error: 'Desconectado',
  };
  $('drive-label').textContent = labels[st] || 'Drive';
  $('drive-msg').textContent = (s && s.message) || '';

  const btn = $('btn-drive');
  const busy = (st === 'connecting' || st === 'disconnecting' || st === 'reconnecting');
  btn.disabled = busy;
  btn.classList.toggle('spin', busy);
  if (st === 'mounted') {
    btn.textContent = 'Desconectar';
    btn.classList.remove('btn-primary'); btn.classList.add('btn-ghost');
    $('btn-drive-open').classList.remove('hidden');
    $('btn-drive-refresh').classList.remove('hidden');
  } else {
    btn.textContent = 'Conectar meu drive';
    btn.classList.add('btn-primary'); btn.classList.remove('btn-ghost');
    $('btn-drive-open').classList.add('hidden');
    $('btn-drive-refresh').classList.add('hidden');
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
    if (s.percent != null) {
      // Bytes já subindo → barra real com %.
      let t = n > 0 ? ('Enviando ' + n + (n === 1 ? ' arquivo' : ' arquivos') + '…') : 'Enviando…';
      t += '  ' + s.percent + '%';
      const spd = fmtSpeed(s.speed);
      if (spd) t += ' · ' + spd;
      $('sync-text').textContent = t;
      bar.classList.remove('hidden', 'indeterminate');
      fill.style.width = s.percent + '%';
    } else {
      // Enfileirado, bytes ainda não começaram (percent null) → barra
      // INDETERMINADA em vez de "Enviando…" pelado (o "minuto sem barra").
      $('sync-text').textContent = n > 0
        ? ('Preparando envio de ' + n + (n === 1 ? ' arquivo' : ' arquivos') + '…')
        : 'Preparando envio…';
      fill.style.width = '';           // a animação CSS controla o bloco
      bar.classList.remove('hidden');
      bar.classList.add('indeterminate');
    }
  } else {
    // sincronizado (ou com erro de upload sendo retentado)
    dot.className = 'sync-dot ok';
    $('sync-text').textContent = (s.errored > 0)
      ? (s.errored + (s.errored === 1 ? ' arquivo com erro — tentando de novo' : ' arquivos com erro — tentando de novo'))
      : 'Tudo sincronizado';
    bar.classList.remove('indeterminate');
    bar.classList.add('hidden');
  }
}

async function doRefresh() {
  const btn = $('btn-drive-refresh');
  busy(btn, true);
  try {
    const r = await window.abel.driveRefresh();
    if (r && r.ok) {
      showToast({ kind: 'info', text: r.pending > 0
        ? ('Lista atualizada. Ainda enviando ' + r.pending + (r.pending === 1 ? ' arquivo' : ' arquivos') + '...')
        : 'Lista atualizada! Se uma pasta estava aberta no Explorer, aperte F5 nela pra ver os arquivos novos.' });
    } else {
      showToast({ kind: 'warn', text: (r && r.error) || 'Nao consegui atualizar agora.' });
    }
  } catch (_) {
    showToast({ kind: 'warn', text: 'Nao consegui atualizar agora.' });
  }
  busy(btn, false);
}

async function toggleDrive() {
  const s = await window.abel.driveStatus();
  if (s && s.status === 'mounted') await window.abel.driveDisconnect();
  else await window.abel.driveConnect();
}

// ── avisos: balão + linha dispensável (✕) + histórico ("central de avisos") ──
const avisosHist = [];
let avisosOpen = false;
function _p2(n) { return n < 10 ? '0' + n : '' + n; }
function _hm() { const d = new Date(); return _p2(d.getHours()) + ':' + _p2(d.getMinutes()); }

let toastTimer = null;
function showToast(t) {
  const el = $('toast');
  el.textContent = t.text;
  el.className = 'toast ' + (t.kind || 'info');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 6000);
  // Erros/avisos: linha fixa embaixo do status, agora DISPENSÁVEL (✕), e guardada
  // num histórico pra você poder ver depois sem ficar com a tela suja.
  if (t.kind === 'error' || t.kind === 'warn') {
    avisosHist.unshift({ kind: t.kind, text: t.text, at: _hm() });
    if (avisosHist.length > 30) avisosHist.length = 30;
    $('drive-error-text').textContent = t.text;
    $('drive-error').className = 'drive-error show' + (t.kind === 'warn' ? ' warn' : '');
    renderAvisos();
  }
}

function dismissDriveError() { $('drive-error').className = 'drive-error hidden'; }

function renderAvisos() {
  const btn = $('btn-avisos');
  const list = $('avisos-list');
  if (avisosHist.length === 0) { btn.classList.add('hidden'); list.classList.add('hidden'); avisosOpen = false; return; }
  btn.classList.remove('hidden');
  btn.textContent = (avisosOpen ? 'Ocultar avisos' : 'Avisos') + ' (' + avisosHist.length + ')';
  if (!avisosOpen) { list.classList.add('hidden'); return; }
  list.textContent = '';
  for (const a of avisosHist) {
    const row = document.createElement('div');
    row.className = 'aviso-item ' + (a.kind === 'warn' ? 'warn' : 'error');
    const time = document.createElement('span'); time.className = 'aviso-time'; time.textContent = a.at;
    const txt = document.createElement('span'); txt.className = 'aviso-text'; txt.textContent = a.text;
    row.appendChild(time); row.appendChild(txt);
    list.appendChild(row);
  }
  list.classList.remove('hidden');
}

function toggleAvisos() { avisosOpen = !avisosOpen; renderAvisos(); }

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
  $('btn-email').onclick = doEmail;
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') doEmail(); });

  $('btn-company-back').onclick = () => show('screen-pin');

  $('btn-pin').onclick = doVerify;
  $('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
  $('totp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
  $('btn-pin-resend').onclick = requestPin;

  $('btn-logout').onclick = doLogout;

  $('btn-drive').onclick = toggleDrive;
  $('btn-drive-open').onclick = () => window.abel.driveOpen();
  $('btn-drive-refresh').onclick = doRefresh;
  $('drive-error-x').onclick = dismissDriveError;
  $('btn-avisos').onclick = toggleAvisos;
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
