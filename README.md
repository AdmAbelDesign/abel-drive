# Abel Drive

App desktop que dá acesso aos arquivos do Ecossistema Abel como um drive no
computador. Embrulha o `rclone` por baixo; a UI é a "carroceria" com a marca Abel.

Conhecimento do módulo e plano em `ecossistema-abel/docs/modulos/drive.md` e
`ecossistema-abel/docs/modulos/telas/drive-revisao-2026-10-plano.md` (especialista 51).

## Estado atual — 0.1.27 (08/10/2026)

**Versão publicada para os usuários: 0.1.23** (GitHub Releases, 08/08/2026). As
0.1.24 a 0.1.26 nunca foram publicadas; a 0.1.27 junta tudo e é a próxima a sair.

O que o app faz:

- **Entrar** por código no e-mail (2FA quando a pessoa tem). Quem tem várias
  empresas escolhe a empresa depois do código.
- **Drive montado** (primeira letra livre a partir de Z: no Windows; pasta
  `~/Abel Drive` no Mac). A raiz são as coleções da Produção que a pessoa vê
  pela régua da plataforma (equipe da coleção). Abrir e salvar direto; cada
  salvar vira versão; arquivo aberto por outra pessoa fica travado.
- **Arquivo novo do colega aparece sozinho** (pergunta ao servidor a cada 45 s
  o que mudou) e o botão **Atualizar** relê na hora.
- **Lista de coleções atualizada a cada 5 min** e ao voltar do sono (0.1.27):
  coleção excluída, arquivada, com "não mostrar no Drive" ou de equipe da qual
  a pessoa saiu some sem precisar desconectar. Se uma pasta estiver aberta no
  Explorer, aperte F5 nela.
- **Sempre neste computador** (pastas fixas): baixa e mantém local.
- **Mensagens certas** quando o acesso é recusado (0.1.27). Nenhum destes casos
  diz mais "Sua credencial expirou":
  - autorização retirada pelo administrador (ou nunca dada): pede para ligar o
    Abel Drive na ficha da pessoa;
  - freelancer: o Drive é da equipe interna, os arquivos da encomenda ficam na
    plataforma, em Meu trabalho;
  - empresa em saída: o Drive foi desligado, com a frase que a plataforma manda;
  - pessoa desativada, fora da empresa, empresa bloqueada ou suspensa;
  - sessão vencida: pede para sair e entrar de novo.
  O app confere a sessão e a credencial ao conectar, e de novo quando o drive
  montado recebe uma recusa (401) do servidor; nesses casos desliga o drive com a
  frase e não fica tentando reconectar.
- **"Deixar um livro no computador" (experimental)**: só para ADMIN (e SUPER).
  Para COORD, USER e os demais o menu da bandeja não aparece, porque as rotas
  que ele usa na plataforma ainda são só de ADMIN. Abre para todos na F5 do plano.

Onde está cada coisa:

- `src/main.js` — processo principal: janela, bandeja, store em disco, chamadas à
  API, rclone (mount), pastas fixas, sincronização.
- `src/regras-do-drive.js` — regras puras da 0.1.27: quem vê a sincronização,
  motivo da recusa → frase, atualização da raiz a cada 5 min.
- `src/renderer/login-flow.js` — regras puras do login.
- `src/preload.js` — ponte segura renderer ↔ main.
- `src/renderer/` — a tela, no design system do Ecossistema.

## Como rodar (Windows)

Precisa do **Node.js** instalado (https://nodejs.org — versão LTS).

Na pasta do projeto, no cmd:

```
npm install
npm start
```

Deve abrir uma janela "Abel Drive" com a tela de login. Fluxo:

1. Digita seu e-mail → **Continuar**.
2. Chega um **código por e-mail** — digita na tela.
3. Se você tiver 2FA, o campo do autenticador aparece.
4. Se você tem acesso a mais de uma empresa, escolhe uma (só depois do código).
5. Conectado.

A sessão fica guardada, então da próxima vez abre já conectado (use **Sair** para trocar).

Por dentro (desde 30/09/2026): `request-pin` sem empresa → `verify-pin` com
`empresa_depois: true`, `client_type: "drive"` e o `device_id` da instalação.
Com várias empresas a resposta traz `escolher_empresa` + `companies`, e o Drive
chama o `verify-pin` de novo com `company_id` e o mesmo código/2FA. O
`/auth/identify` não é mais usado. Regras em `src/renderer/login-flow.js`.

## Testes

```
npm test     # login (uma empresa, várias, 2FA, plataforma nova e antiga)
             # + regras da 0.1.27 (sincronização só ADMIN, frases, raiz a cada 5 min)
npm run lint # checagem de sintaxe de todos os .js
```

Não há teste automático do mount nem da sincronização (precisam do rclone e do
WinFsp de verdade): confira na máquina, com uma coleção de teste. Nunca apague
arquivo real do acervo num teste.

## Gerar e publicar uma versão (só o Juliano)

1. Suba a versão em `package.json` (`"version"`) e anote o que mudou abaixo.
2. No cmd, na pasta do projeto: `npm install`, `npm test`, `npm run lint`.
3. Gere o instalador do Windows: `npm run dist`. Sai em
   `dist/Abel-Drive-Setup-<versão>.exe`, junto com o `.blockmap` e o `latest.yml`.
   (Sem assinatura, o Windows mostra "editor desconhecido".)
4. No GitHub, repositório `AdmAbelDesign/abel-drive` › **Releases** ›
   **Draft a new release**: tag `v<versão>`, título `Abel Drive <versão>`, anexe
   os três arquivos (`.exe`, `.exe.blockmap`, `latest.yml`) e **Publish release**.
   O app instalado procura atualização ao abrir e baixa sozinho.

## Versões

- **0.1.27** (08/10/2026): sincronização só para ADMIN, marcada como experimental;
  frase certa para autorização retirada, freelancer, empresa em saída e pessoa
  desativada (fim do "Sua credencial expirou" nesses casos); lista de coleções
  atualizada a cada 5 min e ao voltar do sono. Leva junto o que nunca foi
  publicado: login com escolha da empresa depois do código (30/09) e a
  sincronização de 19/08.
- 0.1.24 a 0.1.26: geradas ou só no código, nunca publicadas.
- **0.1.23** (08/08/2026): a versão que os usuários têm hoje.

## Notas

- A API usada é a de produção (`api.ecossistemaabel.com.br`, servidor no Fly; o Railway foi encerrado em 23/09/2026).
- `device_id`, sessão e perfil ficam em `%APPDATA%/abel-drive/abel-drive.json`.
- Nada de senha é guardado — o login é por código de uso único.

## WinFsp bundlado (Windows)

O rclone precisa do driver **WinFsp** para montar o drive no Windows. Para não
depender de instalação manual em máquina nova, o instalador é **empacotado** com o
app em `bin/winfsp.msi` e auto-instalado (com UAC) na primeira conexão quando o
driver ainda não existe — ver `ensureWinFsp()` em `src/main.js`.

- O `bin/` inteiro vai pro pacote via `extraResources` (`package.json` → `build`),
  landando em `resources/bin/winfsp.msi`; é onde `winfspInstallerPath()` procura em
  produção (em dev procura em `../bin`).
- **Origem/licença:** WinFsp é redistribuível (mesma prática do rclone/Mountain
  Duck). Instalador baixado de https://winfsp.dev — versão **`<preencher: ex. 2.0 (Bento)`** *(anote aqui a versão exata baixada ao adicionar o `bin/winfsp.msi`)*.
- Para atualizar: baixe o novo `.msi` de winfsp.dev, salve **exatamente** como
  `bin/winfsp.msi` e atualize a versão acima.
