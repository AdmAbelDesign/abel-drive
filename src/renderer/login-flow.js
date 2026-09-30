'use strict';

// ══════════════════════════════════════════════════════════════════════
// Abel Drive — regras do login (puras, sem rede nem Electron)
// ----------------------------------------------------------------------
// Usado pelo processo principal (require) e pela tela (<script>), e testado
// em test/login-flow.test.js.
//
// Desde 30/09/2026 a plataforma não revela nada antes do código: o
// /auth/identify não diz mais se o e-mail tem conta nem em quais empresas.
// O fluxo do Drive passa a ser:
//
//   e-mail → request-pin (sem empresa) → verify-pin { empresa_depois: true }
//     · uma empresa  → a sessão já vem (session_id);
//     · várias       → { escolher_empresa, companies } SEM sessão; a pessoa
//                      escolhe e o Drive chama o verify-pin de novo com
//                      company_id + o MESMO código (e o mesmo 2FA).
//
// Plataforma antiga (antes do push de 30/09): o campo empresa_depois é
// descartado pelo schema e o verify-pin sem company_id abre na empresa
// padrão. Entra, só não oferece a escolha.
// ══════════════════════════════════════════════════════════════════════

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbelLogin = api;
}(typeof self !== 'undefined' ? self : this, function () {
  // Tipo de cliente no contrato do 01 (teto "1 aparelho de cada tipo").
  const CLIENT_TYPE = 'drive';
  const DEVICE_ID_MAX = 100;

  // Texto opcional: devolve o texto aparado, ou undefined (o backend aceita
  // os campos opcionais só como texto ou AUSENTES — nunca null).
  function textoOuNada(v) {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length ? t : undefined;
  }

  // O device_id guardado só vale se for texto de 1 a 100 caracteres.
  function deviceIdValido(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= DEVICE_ID_MAX;
  }

  // Corpo do POST /auth/request-pin. Sem empresa: o código vai pela empresa
  // do código (a escolha vem depois dele).
  function corpoDoRequestPin({ email }) {
    return { email };
  }

  // Corpo do POST /auth/verify-pin.
  function corpoDoVerifyPin({ email, pin, totp, companyId, deviceId }) {
    const body = {
      email,
      pin: textoOuNada(pin) || '',
      client_type: CLIENT_TYPE,
      empresa_depois: true,
    };
    if (deviceIdValido(deviceId)) body.device_id = deviceId;
    const t = textoOuNada(totp);
    if (t) body.totp = t;
    const c = textoOuNada(companyId);
    if (c) body.company_id = c;
    return body;
  }

  // Lê a resposta do verify-pin e diz o que a tela faz em seguida.
  //   { passo: 'entrou', sessionId, companyId }
  //   { passo: 'escolher', companies, user }
  //   { passo: 'erro', error, pedir2fa, voltarAoCodigo }
  function lerRespostaDoVerify(r) {
    const resp = r || {};
    if (resp.ok && resp.escolher_empresa) {
      const companies = (Array.isArray(resp.companies) ? resp.companies : []).filter((c) => c && c.id);
      if (companies.length === 0) return { passo: 'erro', error: 'SEM_EMPRESA_ATIVA', pedir2fa: false, voltarAoCodigo: false };
      return { passo: 'escolher', companies, user: resp.user || null };
    }
    if (resp.ok && resp.session_id) {
      return { passo: 'entrou', sessionId: resp.session_id, companyId: resp.company_id || null };
    }
    const error = resp.error || (resp.ok ? 'RESPOSTA_INESPERADA' : 'desconhecido');
    return {
      passo: 'erro',
      error,
      // O backend pede o autenticador: mostra o campo do 2FA.
      pedir2fa: error === 'TOTP_REQUIRED' || error === 'TOTP_INVALID',
      // Código vencido/errado ou trava: não adianta escolher empresa de novo.
      voltarAoCodigo: ['PIN_INVALID', 'PIN_EXPIRED', 'PIN_NOT_REQUESTED', 'ACCOUNT_LOCKED', 'TOTP_REQUIRED', 'TOTP_INVALID'].includes(error),
    };
  }

  return { CLIENT_TYPE, DEVICE_ID_MAX, deviceIdValido, corpoDoRequestPin, corpoDoVerifyPin, lerRespostaDoVerify };
}));
