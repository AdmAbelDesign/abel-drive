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
function renderDrive(s) {
  const st = (s && s.status) || 'idle';
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

function refreshDrive() { window.abel.driveStatus().then(renderDrive); }

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

  window.abel.version().then((v) => {
    const el = $('app-version');
    if (el) el.textContent = 'Abel Drive · v' + v;
  });

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
