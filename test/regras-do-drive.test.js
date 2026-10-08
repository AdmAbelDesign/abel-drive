'use strict';

// Testes da versão de acerto 0.1.27 (08/10/2026): regras puras do drive.
//   1. "Deixar um livro no computador" só para ADMIN/SUPER, experimental.
//   2. Cada recusa com a sua frase; nenhuma diz "credencial expirou".
//   3. A lista de coleções (raiz) se atualiza sozinha a cada 5 min.
// Roda com `npm test` (node:test, sem rede nem Electron).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/regras-do-drive');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

// ── 1. Sincronização ────────────────────────────────────────────────────
test('sincronização: ADMIN e SUPER veem os 3 itens, todos marcados como experimental', () => {
  for (const papel of ['ADMIN', 'SUPER', 'admin']) {
    const itens = R.itensDaSincronizacao({ papel, montado: true, baixando: false });
    assert.deepEqual(itens.map((i) => i.id), ['deixar', 'livros', 'enviar']);
    for (const it of itens) assert.match(it.label, /\(experimental\)/);
    assert.equal(itens[0].enabled, true);
  }
});

test('sincronização: COORD, USER, freelancer e papel desconhecido não veem nada', () => {
  for (const papel of ['COORD', 'USER', 'EDITOR', 'COLAB', '', null, undefined, 42]) {
    assert.equal(R.podeVerSincronizacao(papel), false, String(papel));
    assert.deepEqual(R.itensDaSincronizacao({ papel, montado: true, baixando: false }), [], String(papel));
  }
  assert.deepEqual(R.itensDaSincronizacao(), []);
});

test('sincronização: "Deixar um livro" fica cinza com o drive desconectado ou já baixando', () => {
  assert.equal(R.itensDaSincronizacao({ papel: 'ADMIN', montado: false })[0].enabled, false);
  assert.equal(R.itensDaSincronizacao({ papel: 'ADMIN', montado: true, baixando: true })[0].enabled, false);
});

test('sincronização: a bandeja do main.js passa pela regra (sem item fixo fora dela)', () => {
  assert.match(MAIN, /\.\.\.trayItensDaSincronizacao\(mounted\)/);
  assert.doesNotMatch(MAIN, /label: 'Deixar um livro no computador…'/);
  // A ação e o atualizador também conferem o papel (não só o menu).
  assert.match(MAIN, /async function syncAddFlow\(\) \{\s+if \(!podeSincronizar\(\)\) return;/);
  assert.match(MAIN, /if \(syncBusy \|\| !podeSincronizar\(\)\) return;/);
});

// ── 2. Frases certas ────────────────────────────────────────────────────
const EXPIROU = /expir/i;

test('motivo: autorização retirada pelo admin (NOT_AUTHORIZED, 403)', () => {
  const m = R.lerMotivo({ error: 'NOT_AUTHORIZED', status: 403 });
  assert.equal(m.tipo, 'sem_acesso');
  assert.match(m.frase, /administrador/);
  assert.match(m.frase, /ligar o Abel Drive na sua ficha/);
  assert.doesNotMatch(m.frase, EXPIROU);
  assert.equal(m.tentarDeNovo, false);
  assert.equal(m.zerarCredencial, true);
});

test('motivo: freelancer (COLAB_SEM_DRIVE, 403)', () => {
  const m = R.lerMotivo({ error: 'COLAB_SEM_DRIVE', status: 403 });
  assert.equal(m.tipo, 'sem_acesso');
  assert.match(m.frase, /freelancer/);
  assert.match(m.frase, /Meu trabalho/);
  assert.doesNotMatch(m.frase, EXPIROU);
  assert.equal(m.tentarDeNovo, false);
});

test('motivo: empresa em saída usa a frase da plataforma (401 da sessão ou 403 da rota)', () => {
  const frase = 'O contrato de Editora X terminou em 30/09. O acesso agora é só do administrador, para levar os dados.';
  for (const status of [401, 403, 200]) {
    const m = R.lerMotivo({ error: 'EMPRESA_EM_SAIDA', status, message: frase });
    assert.equal(m.tipo, 'sem_acesso');
    assert.match(m.frase, /^O Abel Drive foi desligado nesta empresa\. /);
    assert.ok(m.frase.endsWith(frase));
    assert.doesNotMatch(m.frase, EXPIROU);
    assert.equal(m.tentarDeNovo, false);
  }
});

test('motivo: empresa em saída sem frase da plataforma usa a frase padrão', () => {
  const m = R.lerMotivo({ error: 'EMPRESA_EM_SAIDA', status: 403 });
  assert.match(m.frase, /contrato desta empresa terminou/);
  assert.doesNotMatch(m.frase, EXPIROU);
});

test('motivo: pessoa desativada, fora da empresa, empresa bloqueada', () => {
  for (const error of ['MEMBER_DISABLED', 'MEMBERSHIP_NOT_FOUND', 'USER_NOT_IN_COMPANY', 'USER_BLOCKED',
    'COMPANY_BLOCKED', 'COMPANY_SUSPENDED', 'MODULE_DISABLED']) {
    const m = R.lerMotivo({ error, status: 403 });
    assert.equal(m.tipo, 'sem_acesso', error);
    assert.equal(m.tentarDeNovo, false, error);
    assert.doesNotMatch(m.frase, EXPIROU, error);
  }
});

test('motivo: sessão vencida pede para entrar de novo (sem "credencial expirou")', () => {
  const m = R.lerMotivo({ error: 'SESSION_INVALID', status: 401 });
  assert.equal(m.tipo, 'sessao');
  assert.match(m.frase, /entre de novo/);
  assert.doesNotMatch(m.frase, /credencial expirou/i);
});

test('motivo: rede e servidor fora são passageiros (tenta de novo, não descarta a credencial)', () => {
  for (const r of [{ error: 'NETWORK' }, {}, { status: 502 }, { error: 'INTERNAL_ERROR', status: 500 },
    { error: 'MEMBERSHIP_CHECK_FAILED', status: 200 }, { error: 'SESSION_ERROR', status: 401 }]) {
    const m = R.lerMotivo(r);
    assert.equal(m.tipo, 'transitorio', JSON.stringify(r));
    assert.equal(m.tentarDeNovo, true);
    assert.equal(m.zerarCredencial, false);
  }
});

test('motivo: recusa desconhecida (401/403) diz que foi recusa e mostra o código', () => {
  const m = R.lerMotivo({ error: 'ALGO_NOVO', status: 403 });
  assert.equal(m.tipo, 'sem_acesso');
  assert.match(m.frase, /recusou/);
  assert.match(m.frase, /ALGO_NOVO/);
  assert.doesNotMatch(m.frase, EXPIROU);
});

test('motivo: nenhuma frase do app diz "credencial expirou"', () => {
  assert.doesNotMatch(MAIN, /credencial expirou/i);
  // O main lê o motivo em vez de decidir só pelo status HTTP.
  assert.match(MAIN, /Regras\.lerMotivo\(\{ error: cred\.error, status: cred\._status, message: cred\.message \}\)/);
});

test('log do rclone: 401 vira conferência de acesso (não balão técnico)', () => {
  assert.equal(R.linhaDeAcessoRecusado('2026/10/08 ERROR : Pasta: error listing: 401 Unauthorized'), true);
  assert.equal(R.linhaDeAcessoRecusado('ERROR : x: Unauthorized'), true);
  assert.equal(R.linhaDeAcessoRecusado('ERROR : x: 423 Locked'), false);
  assert.equal(R.linhaDeAcessoRecusado('INFO  : vfs cache: cleaned 4010 files'), false);
  assert.equal(R.linhaDeAcessoRecusado(null), false);
});

// ── 3. Lista de coleções a cada 5 min ───────────────────────────────────
function relogioDeMentira() {
  const agendas = [];
  return {
    agendas,
    agendar: (fn, ms) => { const t = { fn, ms, ativo: true }; agendas.push(t); return t; },
    desagendar: (t) => { t.ativo = false; },
  };
}

test('raiz: o intervalo é de 5 minutos', () => {
  assert.equal(R.INTERVALO_DA_RAIZ_MS, 5 * 60 * 1000);
  const rel = relogioDeMentira();
  const a = R.criarAtualizadorDaRaiz({ atualizar: async () => {}, agendar: rel.agendar, desagendar: rel.desagendar });
  a.iniciar();
  assert.equal(rel.agendas.length, 1);
  assert.equal(rel.agendas[0].ms, 300000);
  assert.equal(a.ativo(), true);
});

test('raiz: a cada volta do relógio relê a lista; parar desliga', async () => {
  let vezes = 0;
  const rel = relogioDeMentira();
  const a = R.criarAtualizadorDaRaiz({ atualizar: async () => { vezes++; }, agendar: rel.agendar, desagendar: rel.desagendar });
  a.iniciar();
  await rel.agendas[0].fn();
  await new Promise((r) => setImmediate(r));
  await rel.agendas[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(vezes, 2);
  a.parar();
  assert.equal(rel.agendas[0].ativo, false);
  assert.equal(a.ativo(), false);
});

test('raiz: iniciar de novo não deixa dois relógios ligados', () => {
  const rel = relogioDeMentira();
  const a = R.criarAtualizadorDaRaiz({ atualizar: async () => {}, agendar: rel.agendar, desagendar: rel.desagendar });
  a.iniciar(); a.iniciar();
  assert.equal(rel.agendas.filter((t) => t.ativo).length, 1);
});

test('raiz: não sobrepõe duas rodadas e erro não derruba o app', async () => {
  let soltar;
  let vezes = 0;
  const a = R.criarAtualizadorDaRaiz({
    atualizar: () => { vezes++; return new Promise((r) => { soltar = r; }); },
    agendar: () => 1, desagendar: () => {},
  });
  const primeira = a.agora();
  assert.equal(await a.agora(), false);   // a 1a ainda está rodando
  soltar();
  assert.equal(await primeira, true);
  assert.equal(vezes, 1);

  const comErro = R.criarAtualizadorDaRaiz({ atualizar: async () => { throw new Error('rede'); }, agendar: () => 1, desagendar: () => {} });
  assert.equal(await comErro.agora(), false);
});

test('raiz: com o relógio de verdade (mock), dispara aos 5 min e não antes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let vezes = 0;
  const a = R.criarAtualizadorDaRaiz({ atualizar: async () => { vezes++; } });
  a.iniciar();
  t.mock.timers.tick(4 * 60 * 1000 + 59 * 1000);
  assert.equal(vezes, 0);
  t.mock.timers.tick(1000);
  assert.equal(vezes, 1);
  a.parar();
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(vezes, 1);
});

test('main.js: toda função da 0.1.27 chamada existe (erro engolido pelo atualizador não passa)', () => {
  const chamadas = ['desligarComMotivo', 'conferirSessao', 'sondarCredencial', 'aoVerAcessoRecusado',
    'conferirCredencialNoAr', 'guardarPapel', 'podeSincronizar', 'trayItensDaSincronizacao', 'atualizarRaizAgora'];
  for (const nome of chamadas) {
    assert.match(MAIN, new RegExp('(async )?function ' + nome + '\\('), nome + ' não está definida');
  }
  assert.doesNotMatch(MAIN, /desligarSemAcesso/);
  assert.match(MAIN, /async function atualizarRaizAgora\(\)[\s\S]{0,300}desligarComMotivo\(motivo\)/);
});

test('raiz: o main liga ao montar, desliga ao sair, relê ao acordar e relê só a raiz', () => {
  assert.match(MAIN, /atualizadorDaRaiz\.iniciar\(\);/);
  assert.match(MAIN, /atualizadorDaRaiz\.parar\(\);/);
  assert.match(MAIN, /powerMonitor\.on\('resume'[\s\S]{0,300}atualizadorDaRaiz\.agora\(\)/);
  assert.match(MAIN, /async function atualizarRaizAgora\(\)[\s\S]{0,400}rcCall\('vfs\/refresh', \{ recursive: 'false' \}\)/);
});
