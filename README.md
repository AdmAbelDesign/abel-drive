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
2. Se você tem acesso a mais de uma empresa, escolhe uma.
3. Chega um **código por e-mail** — digita na tela.
4. Se você tiver 2FA, o campo do autenticador aparece.
5. Conectado. (O próximo passo, montar o drive, ainda está em construção.)

A sessão fica guardada, então da próxima vez abre já conectado (use **Sair** para trocar).

## Notas

- A API usada é a de produção (`ecossistema-abel-production.up.railway.app`).
- `device_id`, sessão e perfil ficam em `%APPDATA%/abel-drive/abel-drive.json`.
- Nada de senha é guardado — o login é por código de uso único.
