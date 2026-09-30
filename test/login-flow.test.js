'use strict';

// Testes do login do Abel Drive (desde 30/09/2026): e-mail → request-pin →
// verify-pin com empresa_depois → (escolher empresa) → sessão.
//
// Roda com `npm test` (node:test, sem dependências). Não fala com a rede:
// duas plataformas de mentira imitam o contrato NOVO (ecossistema-abel
// ac6c3fa5, auth.routes.js + AuthService.verifyPin) e o ANTIGO (antes dele).

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/login-flow');

const DEVICE = '3b8f2c1e-0000-4000-8000-000000000001';
const PIN = '123456';
const TOTP = '654321';

const EMPRESAS = {
  alpha: { id: 'co-alpha', name: 'Editora Alpha', role: 'ADMIN' },
  beta: { id: 'co-beta', name: 'Editora Beta', role: 'EDITOR' },
};

// ── Plataforma de mentira ──────────────────────────────────────────────
// `nova: true` segue o verify-pin novo; `nova: false`, o antigo (o schema zod
// descarta empresa_depois e o verify sem company_id vale a empresa padrão).
function plataforma({ nova, empresas, padrao, com2fa = false }) {
  const chamadas = [];
  let pinPedido = false;
  let sessoes = 0;

  function requestPin(body) {
    chamadas.push({ rota: 'request-pin', body });
    pinPedido = true;
    return { ok: true };
  }

  function verifyPin(body) {
    chamadas.push({ rota: 'verify-pin', body });
    if (!pinPedido) return { ok: false, error: 'PIN_EXPIRED' };
    if (body.pin !== PIN) return { ok: false, error: 'PIN_INVALID', attempts_left: 4 };
    if (com2fa) {
      if (!body.totp) return { ok: false, error: 'TOTP_REQUIRED' };
      if (body.totp !== TOTP) return { ok: false, error: 'TOTP_INVALID' };
    }
    const empresaDepois = nova && body.empresa_depois === true;
    let destino = padrao;
    if (empresaDepois) {
      if (body.company_id) {
        if (!empresas.some((c) => c.id === body.company_id)) return { ok: false, error: 'SEM_EMPRESA_ATIVA' };
        destino = body.company_id;
      } else if (empresas.length > 1) {
        return { ok: true, escolher_empresa: true, user: { display_name: 'Ana' }, companies: empresas };
      } else {
        destino = empresas[0].id;
      }
    } else if (body.company_id) {
      destino = body.company_id;
    }
    sessoes += 1;
    return { ok: true, session_id: 'sess-' + sessoes, user_id: 'u1', company_id: destino };
  }

  return { requestPin, verifyPin, chamadas, sessoes: () => sessoes };
}

// ── O fluxo da tela, sem DOM ───────────────────────────────────────────
// Mesmo roteiro de renderer/app.js: pede o código, verifica, e se vier a
// lista escolhe (via `escolher`) e verifica de novo com o MESMO código.
function entrar(p, { email = 'ana@editora.com', pin = PIN, totp, escolher } = {}) {
  const r0 = p.requestPin(L.corpoDoRequestPin({ email }));
  assert.equal(r0.ok, true);

  let res = L.lerRespostaDoVerify(p.verifyPin(L.corpoDoVerifyPin({ email, pin, totp, deviceId: DEVICE })));
  let listaVista = null;
  if (res.passo === 'escolher') {
    listaVista = res.companies;
    const c = escolher(res.companies);
    res = L.lerRespostaDoVerify(p.verifyPin(L.corpoDoVerifyPin({ email, pin, totp, companyId: c.id, deviceId: DEVICE })));
  }
  return { res, listaVista };
}

// ── Corpo dos pedidos ──────────────────────────────────────────────────
test('request-pin vai sem empresa', () => {
  assert.deepEqual(L.corpoDoRequestPin({ email: 'a@b.com' }), { email: 'a@b.com' });
});

test('verify-pin leva client_type drive, device_id fixo e empresa_depois', () => {
  const b = L.corpoDoVerifyPin({ email: 'a@b.com', pin: ' 123456 ', deviceId: DEVICE });
  assert.deepEqual(b, {
    email: 'a@b.com', pin: '123456', client_type: 'drive', empresa_depois: true, device_id: DEVICE,
  });
  // Campos opcionais vazios ficam AUSENTES (o schema recusa null).
  assert.equal('totp' in b, false);
  assert.equal('company_id' in b, false);
});

test('verify-pin com empresa e 2FA leva company_id e totp', () => {
  const b = L.corpoDoVerifyPin({ email: 'a@b.com', pin: PIN, totp: TOTP, companyId: 'co-beta', deviceId: DEVICE });
  assert.equal(b.company_id, 'co-beta');
  assert.equal(b.totp, TOTP);
  assert.equal(b.empresa_depois, true);
});

test('device_id acima de 100 caracteres não vai (o schema recusaria o login)', () => {
  assert.equal(L.deviceIdValido('x'.repeat(100)), true);
  assert.equal(L.deviceIdValido('x'.repeat(101)), false);
  assert.equal(L.deviceIdValido(''), false);
  assert.equal(L.deviceIdValido(null), false);
  const b = L.corpoDoVerifyPin({ email: 'a@b.com', pin: PIN, deviceId: 'x'.repeat(101) });
  assert.equal('device_id' in b, false);
});

// ── Plataforma nova ────────────────────────────────────────────────────
test('nova · uma empresa: entra direto, sem tela de empresa', () => {
  const p = plataforma({ nova: true, empresas: [EMPRESAS.alpha], padrao: 'co-alpha' });
  const { res, listaVista } = entrar(p, { escolher: () => assert.fail('não devia pedir empresa') });
  assert.equal(res.passo, 'entrou');
  assert.equal(res.companyId, 'co-alpha');
  assert.equal(listaVista, null);
  assert.equal(p.chamadas.filter((c) => c.rota === 'verify-pin').length, 1);
  assert.equal(p.chamadas.some((c) => c.rota === 'identify'), false);
});

test('nova · várias empresas: mostra a lista e entra na escolhida com o mesmo código', () => {
  const p = plataforma({ nova: true, empresas: [EMPRESAS.alpha, EMPRESAS.beta], padrao: 'co-alpha' });
  const { res, listaVista } = entrar(p, { escolher: (lista) => lista.find((c) => c.id === 'co-beta') });
  assert.deepEqual(listaVista.map((c) => c.id), ['co-alpha', 'co-beta']);
  assert.equal(res.passo, 'entrou');
  assert.equal(res.companyId, 'co-beta');
  assert.equal(p.sessoes(), 1, 'a 1a chamada não abre sessão');

  const verifies = p.chamadas.filter((c) => c.rota === 'verify-pin').map((c) => c.body);
  assert.equal(verifies.length, 2);
  assert.equal(verifies[0].company_id, undefined);
  assert.equal(verifies[1].company_id, 'co-beta');
  assert.equal(verifies[1].pin, verifies[0].pin);
  assert.equal(verifies[1].empresa_depois, true);
  for (const v of verifies) {
    assert.equal(v.client_type, 'drive');
    assert.equal(v.device_id, DEVICE);
  }
});

test('nova · 2FA: sem o autenticador pede o campo; com ele entra', () => {
  const p = plataforma({ nova: true, empresas: [EMPRESAS.alpha], padrao: 'co-alpha', com2fa: true });
  const sem = entrar(p, { escolher: () => assert.fail() }).res;
  assert.equal(sem.passo, 'erro');
  assert.equal(sem.error, 'TOTP_REQUIRED');
  assert.equal(sem.pedir2fa, true);
  assert.equal(sem.voltarAoCodigo, true);

  const errado = entrar(p, { totp: '000000', escolher: () => assert.fail() }).res;
  assert.equal(errado.error, 'TOTP_INVALID');
  assert.equal(errado.pedir2fa, true);

  const com = entrar(p, { totp: TOTP, escolher: () => assert.fail() }).res;
  assert.equal(com.passo, 'entrou');
});

test('nova · 2FA com várias empresas: o mesmo 2FA vai nas duas chamadas', () => {
  const p = plataforma({ nova: true, empresas: [EMPRESAS.alpha, EMPRESAS.beta], padrao: 'co-alpha', com2fa: true });
  const { res } = entrar(p, { totp: TOTP, escolher: (lista) => lista[1] });
  assert.equal(res.passo, 'entrou');
  assert.equal(res.companyId, 'co-beta');
  const verifies = p.chamadas.filter((c) => c.rota === 'verify-pin').map((c) => c.body);
  assert.deepEqual(verifies.map((v) => v.totp), [TOTP, TOTP]);
});

test('nova · código errado não mostra empresa nenhuma', () => {
  const p = plataforma({ nova: true, empresas: [EMPRESAS.alpha, EMPRESAS.beta], padrao: 'co-alpha' });
  const { res, listaVista } = entrar(p, { pin: '999999', escolher: () => assert.fail('não devia listar') });
  assert.equal(res.passo, 'erro');
  assert.equal(res.error, 'PIN_INVALID');
  assert.equal(res.voltarAoCodigo, true);
  assert.equal(listaVista, null);
});

test('nova · empresa escolhida fora da lista: erro, fica na tela da empresa', () => {
  const r = L.lerRespostaDoVerify({ ok: false, error: 'COMPANY_BLOCKED' });
  assert.equal(r.passo, 'erro');
  assert.equal(r.voltarAoCodigo, false);
});

test('lista sem ids (resposta estranha) não vira tela de empresa vazia', () => {
  const r = L.lerRespostaDoVerify({ ok: true, escolher_empresa: true, companies: [{ id: null, name: '' }] });
  assert.equal(r.passo, 'erro');
  assert.equal(r.error, 'SEM_EMPRESA_ATIVA');
});

test('ok sem sessão e sem lista não conta como entrou', () => {
  const r = L.lerRespostaDoVerify({ ok: true });
  assert.equal(r.passo, 'erro');
});

// ── Plataforma antiga (antes do push) ──────────────────────────────────
test('antiga · uma empresa: entra', () => {
  const p = plataforma({ nova: false, empresas: [EMPRESAS.alpha], padrao: 'co-alpha' });
  const { res } = entrar(p, { escolher: () => assert.fail() });
  assert.equal(res.passo, 'entrou');
  assert.equal(res.companyId, 'co-alpha');
});

test('antiga · várias empresas: entra na padrão (sem escolha até o push)', () => {
  const p = plataforma({ nova: false, empresas: [EMPRESAS.alpha, EMPRESAS.beta], padrao: 'co-alpha' });
  const { res, listaVista } = entrar(p, { escolher: () => assert.fail('a antiga não devolve lista') });
  assert.equal(res.passo, 'entrou');
  assert.equal(res.companyId, 'co-alpha');
  assert.equal(listaVista, null);
});

test('antiga · 2FA: pede e entra', () => {
  const p = plataforma({ nova: false, empresas: [EMPRESAS.alpha], padrao: 'co-alpha', com2fa: true });
  assert.equal(entrar(p, { escolher: () => assert.fail() }).res.error, 'TOTP_REQUIRED');
  assert.equal(entrar(p, { totp: TOTP, escolher: () => assert.fail() }).res.passo, 'entrou');
});
