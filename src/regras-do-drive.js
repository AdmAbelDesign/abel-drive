'use strict';

// ══════════════════════════════════════════════════════════════════════
// Abel Drive — regras puras do drive (sem rede nem Electron)  · 0.1.27
// ----------------------------------------------------------------------
// Usado pelo processo principal (main.js) e testado em
// test/regras-do-drive.test.js. Três assuntos:
//
//   1. Quem vê "Deixar um livro no computador" (sincronização). As rotas que
//      ela usa na plataforma (/api/vfs/manifest, blob, fileinfo) são só de
//      ADMIN/SUPER. Para os outros o menu NÃO aparece (nunca aparecer e
//      depois falhar). Marcado como experimental até a F5 do plano.
//   2. O motivo de uma recusa → a frase certa. Quem perdeu a autorização,
//      freelancer, empresa em saída, pessoa desativada: cada um lê a sua
//      frase, e nenhum deles lê "credencial expirou".
//   3. A lista de coleções (raiz do drive) se atualiza sozinha a cada 5 min,
//      para coleção excluída, arquivada ou de equipe da qual a pessoa saiu
//      sumir sem desconectar.
// ══════════════════════════════════════════════════════════════════════

// ── 1. Sincronização: só ADMIN e SUPER ──────────────────────────────────
const PAPEIS_DA_SINCRONIZACAO = ['ADMIN', 'SUPER'];

function podeVerSincronizacao(papel) {
  return typeof papel === 'string' && PAPEIS_DA_SINCRONIZACAO.includes(papel.trim().toUpperCase());
}

// Itens da bandeja da sincronização. Fora do ADMIN/SUPER (ou papel ainda
// desconhecido): lista vazia, nada aparece.
function itensDaSincronizacao({ papel, montado, baixando } = {}) {
  if (!podeVerSincronizacao(papel)) return [];
  return [
    { id: 'deixar', label: 'Deixar um livro no computador (experimental)…', enabled: !!montado && !baixando },
    { id: 'livros', label: 'Livros no computador (experimental)' },
    { id: 'enviar', label: 'Enviar minhas edições automaticamente (experimental)' },
  ];
}

// ── 2. Motivo da recusa → frase ─────────────────────────────────────────
// tipo:
//   'sem_acesso'   a pessoa (ou a empresa) não pode usar o Drive agora.
//                  Não adianta tentar de novo sozinho; a credencial guardada
//                  não serve mais.
//   'sessao'       a sessão do app terminou: entrar de novo com o código.
//   'transitorio'  rede, servidor, soluço: tenta de novo sozinho.
const SEM_ACESSO = {
  NOT_AUTHORIZED:
    'O administrador da sua empresa não liberou o Abel Drive para você (ou retirou a liberação). ' +
    'Peça a ele para ligar o Abel Drive na sua ficha de usuário e clique em Conectar de novo.',
  COLAB_SEM_DRIVE:
    'O Abel Drive é da equipe interna. Como freelancer, você acessa os arquivos da sua encomenda ' +
    'pela plataforma, em Meu trabalho.',
  MEMBER_DISABLED: 'Seu acesso a esta empresa foi desativado. Fale com o administrador da sua empresa.',
  MEMBERSHIP_NOT_FOUND: 'Você não faz mais parte desta empresa. Fale com o administrador da sua empresa.',
  USER_NOT_IN_COMPANY: 'Você não faz mais parte desta empresa. Fale com o administrador da sua empresa.',
  USER_BLOCKED: 'Seu acesso ao Ecossistema está bloqueado. Fale com o administrador da sua empresa.',
  COMPANY_BLOCKED: 'O acesso desta empresa ao Ecossistema está bloqueado. Fale com o administrador da sua empresa.',
  COMPANY_SUSPENDED: 'A assinatura desta empresa está suspensa. Fale com o administrador da sua empresa.',
  MODULE_DISABLED: 'O Abel Drive está desligado para esta empresa. Fale com o administrador da sua empresa.',
};
const EMPRESA_EM_SAIDA = 'EMPRESA_EM_SAIDA';
const FRASE_DA_SAIDA_PADRAO =
  'O contrato desta empresa terminou. O acesso agora é só do administrador, pela plataforma, para levar os dados.';

const DA_SESSAO = ['SESSION_INVALID', 'SESSION_EXPIRED', 'SESSION_REQUIRED', 'SESSION_NOT_FOUND'];
const FRASE_DA_SESSAO = 'Sua sessão no Abel Drive terminou. Clique em Sair e entre de novo com o código do e-mail.';

// Códigos que a plataforma usa para "não consegui conferir agora" (não é recusa).
const TRANSITORIOS = ['NETWORK', 'MEMBERSHIP_CHECK_FAILED', 'SESSION_ERROR', 'INTERNAL_ERROR', 'GENERATE_ERROR'];

function lerMotivo({ error, status, message } = {}) {
  const codigo = typeof error === 'string' && error ? error : '';
  const st = Number(status) || 0;

  if (codigo === EMPRESA_EM_SAIDA) {
    const daPlataforma = typeof message === 'string' && message.trim() ? message.trim() : FRASE_DA_SAIDA_PADRAO;
    return {
      tipo: 'sem_acesso', codigo,
      frase: 'O Abel Drive foi desligado nesta empresa. ' + daPlataforma,
      zerarCredencial: true, tentarDeNovo: false,
    };
  }
  if (SEM_ACESSO[codigo]) {
    return { tipo: 'sem_acesso', codigo, frase: SEM_ACESSO[codigo], zerarCredencial: true, tentarDeNovo: false };
  }
  if (DA_SESSAO.includes(codigo)) {
    return { tipo: 'sessao', codigo, frase: FRASE_DA_SESSAO, zerarCredencial: true, tentarDeNovo: false };
  }
  if (TRANSITORIOS.includes(codigo) || st >= 500 || (!codigo && !st)) {
    const cod = codigo || (st ? 'HTTP_' + st : 'NETWORK');
    return {
      tipo: 'transitorio', codigo: cod,
      frase: 'Não consegui falar com o Ecossistema agora (' + cod + '). Confira sua internet e tente de novo.',
      zerarCredencial: false, tentarDeNovo: true,
    };
  }
  if (st === 401 || st === 403) {
    // Recusa que o app ainda não conhece: diz que foi recusa (não "expirou")
    // e mostra o código, para o suporte achar a causa.
    return {
      tipo: 'sem_acesso', codigo: codigo || 'HTTP_' + st,
      frase: 'O Ecossistema recusou o acesso ao Abel Drive (' + (codigo || 'HTTP ' + st) + '). ' +
        'Fale com o administrador da sua empresa.',
      zerarCredencial: true, tentarDeNovo: false,
    };
  }
  return {
    tipo: 'transitorio', codigo: codigo || 'HTTP_' + st,
    frase: 'Não consegui a credencial do drive agora (' + (codigo || 'HTTP ' + st) + '). Tente de novo em instantes.',
    zerarCredencial: false, tentarDeNovo: true,
  };
}

// Linha do log do rclone que indica credencial recusada pelo gateway (401).
function linhaDeAcessoRecusado(linha) {
  return /\b401\b|Unauthorized/i.test(String(linha || ''));
}

// ── 3. Lista de coleções: atualiza a raiz a cada 5 min ─────────────────
const INTERVALO_DA_RAIZ_MS = 5 * 60 * 1000;

// Agenda `atualizar()` a cada `intervaloMs`, sem sobrepor duas rodadas.
// `agora()` roda na hora (ao voltar do sono, por exemplo). Os relógios são
// injetáveis para o teste.
function criarAtualizadorDaRaiz({
  atualizar,
  intervaloMs = INTERVALO_DA_RAIZ_MS,
  agendar = setInterval,
  desagendar = clearInterval,
} = {}) {
  if (typeof atualizar !== 'function') throw new TypeError('atualizar precisa ser uma função');
  let timer = null;
  let rodando = false;

  async function agora() {
    if (rodando) return false;
    rodando = true;
    try { await atualizar(); return true; }
    catch (_) { return false; }   // best-effort: nunca derruba o app
    finally { rodando = false; }
  }
  function iniciar() {
    parar();
    timer = agendar(() => { agora(); }, intervaloMs);
    return timer;
  }
  function parar() {
    if (timer) { desagendar(timer); timer = null; }
  }
  return { iniciar, parar, agora, ativo: () => timer !== null };
}

module.exports = {
  PAPEIS_DA_SINCRONIZACAO,
  podeVerSincronizacao,
  itensDaSincronizacao,
  lerMotivo,
  linhaDeAcessoRecusado,
  INTERVALO_DA_RAIZ_MS,
  criarAtualizadorDaRaiz,
};
