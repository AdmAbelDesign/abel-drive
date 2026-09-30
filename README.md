# Abel Drive

App desktop que dá acesso aos arquivos do Ecossistema Abel como um drive no
computador. Embrulha o `rclone` por baixo; a UI é a "carroceria" com a marca Abel.

Ver o plano em `06 - TI e operações / 2026-07-14-plano-abel-drive-nivel2` (Drive).

## Estado atual — M6a (esqueleto)

Só o **login** por enquanto (passwordless por PIN no e-mail, com 2FA opcional).
O mount do rclone entra no próximo incremento (M6a-2).

- `src/main.js` — processo principal: janela, store em disco (device_id + sessão), chamadas à API.
- `src/preload.js` — ponte segura renderer ↔ main.
- `src/renderer/` — a UI (login) no design system do Ecossistema.

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
npm test     # fluxo do login: uma empresa, várias, 2FA, plataforma nova e antiga
npm run lint # checagem de sintaxe de todos os .js
```

## Notas

- A API usada é a de produção (`ecossistema-abel-production.up.railway.app`).
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
