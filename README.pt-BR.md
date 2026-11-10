# Wheels Collection — versão Web (HTML + Tailwind + Alpine + Firebase)

[English](README.md) · **Português (Brasil)**

Aplicação **SPA estática** para organizar uma coleção de carrinhos Hot Wheels.
Esta é a versão que substitui o aplicativo Flutter: não precisa de compilação,
não usa Flutter Web e roda em qualquer hospedagem compartilhada, inclusive na
Hostinger, dentro de `public_html/app`.

- **Front-end:** HTML5, Tailwind CSS (compilado em `css/tailwind.css`) e Alpine.js 3.14.9 (ESM).
- **Back-end as a Service:** Firebase Auth (e-mail/senha) e Cloud Firestore.
- **Imagens:** recorte quadrado no navegador com Canvas, exportadas em
  **500 × 500 px** e salvas como **Base64 dentro do documento do Firestore**.
- **Idiomas:** `en-CA`, `fr-CA` e `pt-BR`, com troca instantânea, sem recarregar.
- **Preferências:** tema, paleta de cores e idioma em `localStorage`.
- **Rotas:** baseadas em hash (`#/...`), portanto funcionam em qualquer
  subpasta sem `mod_rewrite`.

---

## 1. Estrutura de arquivos

```text
appphp/
├── index.html                 # Toda a interface da SPA (telas, modais, navbar)
├── css/
│   ├── tailwind.css           # GERADO por "npm run css" (não editar)
│   └── styles.css             # Tokens das 5 paletas, tema escuro e componentes
├── js/
│   ├── controller.js          # Componente Alpine: sessão, rotas, CRUD, busca, crop
│   ├── app.js                 # Motor de OCR local (Tesseract.js) e parsers da embalagem
│   ├── firebase-config.js     # Configuração pública do Firebase + limites
│   ├── firebase.js            # Inicialização, Auth e Firestore
│   ├── i18n.js                # Carregamento e tradução dos dicionários
│   ├── image-crop.js          # Crop/zoom/rotação em Canvas e exportação 500×500
│   ├── ocr.js                 # Pipeline de pré-processamento (cinza, CLAHE, escala, margem)
│   ├── preferences.js         # Tema, paleta e idioma em localStorage
│   └── router.js              # Roteador por hash
├── lang/
│   ├── en-CA.json
│   ├── fr-CA.json
│   └── pt-BR.json
├── assets/
│   └── app_icon.png
├── tools/                     # CLI local (não publicar)
│   ├── wheels.mjs             # debug, check, configure e build
│   ├── wheels.cmd             # atalho para Windows
│   ├── wheels.sh              # atalho para macOS/Linux
│   ├── .htaccess              # bloqueia acesso se a pasta for enviada por engano
│   └── lib/                   # módulos internos do CLI
├── package.json               # atalhos npm (não publicar)
├── tailwind.config.cjs        # Config do Tailwind usada por "npm run css" (não publicar)
├── tailwind.src.css           # Ponto de entrada do CLI do Tailwind (não publicar)
├── build/                     # GERADO por "npm run build" (não editar)
├── .wheels/                   # GERADO: backups e manifesto do último build
├── .htaccess                  # Cache, compressão e cabeçalhos (Apache/LiteSpeed)
├── firebase.json              # Configuração do Firebase CLI (rules/indexes)
├── firestore.rules            # Regras de segurança do Firestore
├── firestore.indexes.json     # Índices (vazio: a consulta não exige índice)
├── manifest.webmanifest       # Metadados de instalação (PWA básico)
├── robots.txt                 # Bloqueia indexação (app privado)
├── README.md                  # Versão em inglês
└── README.pt-BR.md            # Este arquivo
```

> Arquivos de desenvolvimento (`README.md`, `README.pt-BR.md`, `firebase.json`,
> `firestore.rules`, `firestore.indexes.json`, `.firebaserc`, `tools/`,
> `package.json`, `tailwind.config.cjs`, `tailwind.src.css`, `build/` e
> `.wheels/`) **não precisam** ser enviados para a Hostinger. O comando `build`
> já monta uma pasta limpa apenas com o runtime.
> O `.htaccess` também bloqueia esses caminhos caso algo seja enviado por engano.

### Rotas

| Rota | Tela | Protegida |
| --- | --- | --- |
| `#/` | Dashboard com busca e grid | Sim |
| `#/login` | Login, cadastro e recuperação de senha | Não |
| `#/settings` | Aparência, paleta, idioma e conta | Sim |
| `#/collection/new` | Cadastro de carrinho | Sim |
| `#/collection/:id` | Detalhes do carrinho | Sim |
| `#/collection/:id/edit` | Edição do carrinho | Sim |
| qualquer outra | Página 404 | — |

Usuário não autenticado que tenta abrir uma rota protegida é enviado para
`#/login`; depois do login ele volta para a rota pretendida. Usuário
autenticado que abre `#/login` é enviado para o dashboard.

---

## 2. Modelo de dados

Coleção do Firestore:

```text
hotwheels_items/{itemId}
```

| Campo | Tipo | Regra |
| --- | --- | --- |
| `userId` | `string` | Igual ao UID do Firebase Auth; imutável na prática |
| `name` | `string` | 1 a 120 caracteres |
| `description` | `string` | 1 a 2000 caracteres |
| `imageBase64` | `string` | JPEG sem o prefixo `data:`; até 900.000 caracteres |
| `createdAt` | `timestamp` | `serverTimestamp()` na criação |
| `updatedAt` | `timestamp` | `serverTimestamp()` na criação e na edição |

As regras em `firestore.rules`:

- só permitem leitura/escrita quando `request.auth != null`;
- exigem `userId == request.auth.uid`;
- validam todos os campos, tamanhos e tipos;
- impedem alterar `createdAt` em uma edição;
- impedem ler ou alterar documentos de outra conta.

A consulta do app é apenas
`where('userId', '==', uid)`. Como há **um único filtro de igualdade**, nenhum
índice composto é necessário (`firestore.indexes.json` fica vazio). A ordenação
por data é feita no cliente.

> A coleção antiga do app Flutter era `cars`, com o campo `ownerId`. Os dados
> antigos **não aparecem automaticamente** nesta versão. Veja a seção
> [Migrar os dados antigos](#13-migrar-os-dados-antigos-opcional).

---

## 3. Configurar o Firebase

### 3.1 Criar o projeto e o app Web

1. Abra <https://console.firebase.google.com/> e crie um projeto (ou use um
   existente).
2. Em **Visão geral do projeto → Configurações do projeto → Geral**, role até
   **Seus apps** e clique no ícone **Web** (`</>`).
3. Dê um apelido (ex.: `wheelscollection-web`) e registre o app. Não é
   necessário configurar Firebase Hosting.
4. Copie o objeto `firebaseConfig` exibido.

O arquivo `js/firebase-config.js` já vem preenchido com o projeto existente
`wheelscollection-ee9af`. Se você for usar outro projeto, substitua os valores:

```js
export const firebaseConfig = Object.freeze({
  apiKey: '...',
  authDomain: 'SEU_PROJETO.firebaseapp.com',
  projectId: 'SEU_PROJETO',
  messagingSenderId: '...',
  appId: '1:...:web:...',
  measurementId: 'G-...', // opcional; o app não inicializa Analytics
});
```

Campos obrigatórios verificados pelo app: `apiKey`, `authDomain`, `projectId`
e `appId`. Se algum estiver vazio ou com texto de exemplo (`YOUR_...`), o app
mostra uma tela de configuração em vez de quebrar.

> A `apiKey` do Firebase é **pública por projeto**. Ela identifica o projeto,
> não autoriza acesso aos dados. A proteção real vem das Security Rules e dos
> domínios autorizados.

### 3.2 Ativar autenticação por e-mail e senha

1. No Console: **Criação → Authentication → Começar**.
2. Aba **Métodos de login → E-mail/senha** → ative **E-mail/senha** e salve.
3. Em **Authentication → Configurações → Domínios autorizados**, confira:
   - `localhost` (já vem por padrão, para desenvolvimento);
   - `SEU_PROJETO.firebaseapp.com` (padrão);
   - **o domínio da Hostinger**, por exemplo `seudominio.com`,
     `www.seudominio.com` e/ou `app.seudominio.com`.
4. Opcional: em **Modelos de e-mail**, personalize o remetente e o texto do
   e-mail de redefinição de senha.

Sem o domínio correto em **Domínios autorizados**, o login funciona localmente
mas falha em produção com `auth/unauthorized-domain`.

### 3.3 Criar o Cloud Firestore

1. No Console: **Criação → Firestore Database → Criar banco de dados**.
2. Escolha o modo **Produção** (as regras deste projeto já bloqueiam acesso
   indevido).
3. Escolha a região mais próxima dos usuários. **A região não pode ser
   alterada depois.** Para usuários no Brasil, `southamerica-east1` costuma ser
   uma boa escolha.
4. Não é necessário criar coleções ou índices manualmente. A coleção
   `hotwheels_items` é criada no primeiro cadastro.

### 3.4 Publicar as regras de segurança

#### Opção A — Firebase CLI (recomendado)

Requisitos: Node.js 18+ e uma conta Google com acesso ao projeto.

```bash
cd appphp
npx firebase-tools@latest login
npx firebase-tools@latest use SEU_PROJECT_ID
npx firebase-tools@latest deploy --only firestore:rules,firestore:indexes
```

O `firebase.json` desta pasta já aponta para `firestore.rules` e
`firestore.indexes.json`. O comando `use` cria um `.firebaserc` local — não
envie esse arquivo para o servidor.

Se preferir instalar a CLI globalmente:

```bash
npm install -g firebase-tools
firebase login
firebase use SEU_PROJECT_ID
firebase deploy --only firestore:rules,firestore:indexes
```

#### Opção B — Console do Firebase

1. Abra **Firestore Database → Regras**.
2. Copie todo o conteúdo de `firestore.rules`.
3. Cole no editor, substituindo as regras existentes, e clique em
   **Publicar**.

As regras são o que impede um usuário de ler os carrinhos de outro. Publique-as
**antes** de divulgar a URL do app.

### 3.5 Verificar a configuração

1. Rode `npm run configure` (seção 6.1) para gravar as chaves e testar a
   `apiKey`.
2. Rode `npm run check` e corrija qualquer erro apontado.
3. Abra o app localmente (seção 6).
4. Crie uma conta de teste em `#/login → Criar conta`.
5. Cadastre um carrinho com foto.
6. No Console, confira em **Firestore → hotwheels_items** se o documento tem
   `userId`, `name`, `description`, `imageBase64`, `createdAt` e `updatedAt`.
7. Saia e entre novamente para confirmar a persistência da sessão.

---

## 4. Preferências locais

Chaves usadas em `localStorage` (definidas em `js/preferences.js`):

| Chave | Valores | Padrão |
| --- | --- | --- |
| `wheels.themeMode` | `light`, `dark`, `system` | `system` |
| `wheels.palette` | `crimson`, `ocean`, `emerald`, `violet`, `amber` | `crimson` |
| `wheels.locale` | `en-CA`, `fr-CA`, `pt-BR` | idioma do navegador |
| `wheels.ocrAuto` | `1`, `0` | `1` (leitura automática da embalagem) |

- O tema `system` acompanha `prefers-color-scheme` em tempo real.
- As paletas são aplicadas por variáveis CSS em `<html data-palette="...">`.
- Um pequeno script no `<head>` aplica tema e paleta **antes da primeira
  pintura**, evitando o “flash” branco.
- O idioma inicial é detectado pelo navegador; se não for `en`, `fr` ou `pt`,
  usa `pt-BR`.
- Limpar os dados do site no navegador restaura os padrões.
- A sessão do Firebase Auth é mantida em `localStorage`/IndexedDB pelo próprio
  SDK (`browserLocalPersistence`).

### Idiomas

Os dicionários ficam em `lang/*.json` e são carregados via `fetch`. A chave
ausente em um idioma cai para `en-CA` e, por último, para o nome da chave.
Datas usam `Intl.DateTimeFormat` com o locale ativo.

Para adicionar um idioma:

1. Crie `lang/xx-YY.json` copiando as chaves de `en-CA.json`.
2. Adicione o idioma ao array `LOCALES` em `js/i18n.js`.
3. Adicione o código à função `detectLocale()` se quiser detectá-lo
   automaticamente.
4. O seletor da navbar e da tela de configurações passa a exibi-lo sozinho.

> Nomes de arquivo diferenciam maiúsculas de minúsculas em servidores Linux.
> Mantenha exatamente `en-CA.json`, `fr-CA.json` e `pt-BR.json`.

---

## 5. Como as imagens são tratadas

1. O usuário escolhe **galeria** ou **câmera** (`accept="image/*"` e
   `capture="environment"`).
2. O arquivo é validado: precisa ser imagem e ter no máximo **20 MB**.
3. A imagem é decodificada com `createImageBitmap` (respeitando a orientação
   EXIF) e, se indisponível, com `Image` + `URL.createObjectURL`.
4. Abre o modal de recorte:
   - arrastar para reposicionar (mouse, toque ou caneta);
   - slider de zoom de 100% a 300%;
   - rotação de 90° para os lados;
   - botão de redefinir.
5. A exportação desenha um canvas de **500 × 500** e tenta qualidades JPEG
   `0.82 → 0.72 → 0.62 → 0.50` até o Base64 caber em **900.000 caracteres**.
6. O Base64 é salvo em `imageBase64` **sem** o prefixo `data:image/jpeg;base64,`.
   Na exibição, o prefixo é adicionado por `imageSrc()`.
7. O limite de 900.000 caracteres mantém o documento abaixo do limite de
   1 MiB do Firestore, com folga para nome, descrição e timestamps.

Observações:

- O Firestore **não** é o lugar ideal para arquivos grandes, mas foi o
  requisito do projeto (sem Firebase Storage). Uma foto 500×500 em JPEG
  costuma ficar entre 30 e 150 KB (`~40.000` a `~200.000` caracteres em
  Base64), bem abaixo do limite.
- Formatos como HEIC podem não ser decodificados por todos os navegadores.
  Se o recorte falhar, use JPEG, PNG ou WebP.
- O SVG não é usado como imagem de item: tudo é reencodado para JPEG pelo
  Canvas, o que também elimina scripts maliciosos embutidos em imagens.

### 5.1 OCR local da embalagem (Tesseract.js)

O formulário em `#/collection/new` e `#/collection/:id/edit` lê a embalagem
localmente, logo depois de aplicar o recorte:

- **automático por padrão**: ao concluir "Aplicar recorte", a leitura começa
  ~350 ms depois, sem clique;
- o botão **Escanear embalagem** passa a **Ler novamente**: é a saída quando a
  leitura automática falha e o único caminho que sobrescreve campos já
  preenchidos;
- o resultado automático **nunca sobrescreve** o que o usuário digitou — só
  preenche campos vazios;
- o Tesseract.js 7 é carregado sob demanda do CDN jsDelivr, somente na primeira
  leitura;
- o reconhecimento roda em um **canvas de 1600 px em memória**, derivado da foto
  original (não da imagem 500×500 salva), então o texto pequeno da embalagem
  chega com cerca do dobro da resolução anterior. Nada extra é persistido;
- o layout é analisado com regiões candidatas e saída antecipada: cartela
  inteira, faixa inferior (nome do modelo), faixa lateral girada (nome da
  coleção) e, se necessário, uma região focada no número da coleção;
- `extractCarName`, `extractCollectionNumber` e `extractDescription` limpam o
  texto, descartam ruídos (MATTEL, HOT WHEELS, faixas etárias, códigos, escalas
  como `1/64`, avisos de direitos autorais) e sugerem Nome e Descrição;
- a descrição usa o formato `Nome da coleção · XX/YYY`, por exemplo
  `HW THE '90S · 2/10`;
- o resultado é apenas sugestivo: os campos continuam editáveis e a persistência
  segue na camada existente (Firebase/Firestore neste projeto).

Observações:

- a primeira leitura baixa o core do Tesseract e o modelo `eng` (**~7 MB**);
  depois o navegador reutiliza o cache. O painel mostra o download e oferece
  **Cancelar**;
- a leitura automática é pulada quando o navegador informa `saveData`, conexão
  2G, ou quando a caixa **Ler a embalagem automaticamente** está desmarcada
  (`wheels.ocrAuto` no `localStorage`);
- fotos nítidas, sem reflexo e com a cartela inteira melhoram a assertividade;
- em edição sem foto nova não existe canvas de alta resolução, então o scanner
  cai para a imagem de 500×500 salva (precisão menor);
- o botão fica desabilitado enquanto não há foto ou enquanto a leitura está em
  andamento.

Diagnóstico: `localStorage.setItem('wheels.ocrDebug', '1')` guarda os seis
últimos recortes enviados ao Tesseract em `window.__wheelsOcrDebug` (cada item
tem a região, o tempo, o texto bruto e um helper `toPng()`).

---

## 6. Debug local

O app **precisa ser servido por HTTP**. Abrir `index.html` com duplo clique
(`file://`) não funciona porque o navegador bloqueia módulos ES e `fetch` de
JSON por CORS.

### 6.1 Script do projeto (recomendado)

O CLI em `tools/` roda em **Windows, macOS e Linux**, não instala dependências
e exige apenas Node.js 18 ou superior (<https://nodejs.org/>).

```bash
cd appphp

# Windows (cmd ou PowerShell)
tools\wheels.cmd

# macOS / Linux (primeira vez)
chmod +x tools/wheels.sh
./tools/wheels.sh

# Qualquer sistema
node tools/wheels.mjs
```

O menu interativo oferece:

1. debug local com live reload;
2. verificação completa do projeto;
3. configuração guiada do Firebase;
4. geração da pasta `build/`;
5. abertura da pasta `build/`;
6. ajuda.

Comandos diretos:

```bash
npm run dev -- --port 3000   # servidor em http://localhost:3000
npm run check                # arquivos, HTML, CSS, JS, traduções e Firebase
npm run check:online         # também testa CDNs e a apiKey
npm run css                  # recompila css/tailwind.css após mudar classes
npm run configure            # grava as chaves em js/firebase-config.js
npm run build                # gera build/ pronta para a Hostinger
```

Sem npm, use `node tools/wheels.mjs <comando>`. O servidor escuta em
`127.0.0.1` por padrão, injeta o live reload e envia `Cache-Control: no-store`.
Ele também bloqueia `tools/`, `build/`, `.wheels/` e os arquivos de
configuração, imitando a produção.

Para testar no celular:

```bash
npm run dev -- --host 0.0.0.0 --no-open
```

Abra `http://IP-DA-MAQUINA:8080` no celular e autorize esse endereço no Firebase
(seção 6.5).

### 6.2 Python (já disponível na maioria das máquinas)

```bash
cd appphp
python -m http.server 8080
```

Abra **<http://localhost:8080>**.

> Use `localhost`, não `127.0.0.1`. O Firebase autoriza `localhost` por padrão;
> `127.0.0.1` pode exigir cadastro manual em **Domínios autorizados**.

Para encerrar, pressione `Ctrl+C`.

### 6.3 Node.js

```bash
cd appphp
npx serve .
# ou
npx http-server . -p 8080
```

Abra o endereço mostrado no terminal (normalmente `http://localhost:3000` ou
`http://localhost:8080`).

### 6.4 VS Code / Live Server

1. Instale a extensão **Live Server**.
2. Clique com o botão direito em `appphp/index.html`.
3. Escolha **Open with Live Server**.

### 6.5 Testar no celular na mesma rede

Com o CLI:

```bash
npm run dev -- --host 0.0.0.0 --no-open
```

Ou com Python:

```bash
python -m http.server 8080 --bind 0.0.0.0
```

Acesse `http://IP-DA-MAQUINA:8080` no celular. Para o **login** funcionar nesse
endereço, o domínio/IP precisa estar em **Domínios autorizados** do Firebase.
O caminho mais simples é usar um túnel HTTPS (Cloudflare Tunnel, ngrok etc.) e
autorizar o domínio gerado.

### 6.6 O que observar no DevTools

- **Console:** erros de módulo, CORS, regras (`permission-denied`) e chaves de
  tradução ausentes.
- **Network:** status de `lang/*.json`, dos scripts CDN e das chamadas do
  Firestore.
- **Application → Local Storage:** confira `wheels.themeMode`,
  `wheels.palette` e `wheels.locale`.
- **Application → Clear storage:** útil para simular primeiro acesso.
- **Responsive mode:** teste em 390×844 (celular) e 1440×900 (desktop).

### 6.7 Contas de teste

Crie uma conta real de teste pelo formulário de cadastro. Não há ambiente de
mock no código entregue. Para limpar os testes, exclua os documentos no
Console do Firestore e, se quiser, a conta em **Authentication → Usuários**.

---

## 7. “Build” para a web

Esta aplicação é **estática**: não existe etapa de compilação como
`flutter build web`. O “build” é a validação dos arquivos + empacotamento para
upload. O CLI da seção 6.1 automatiza as duas etapas.

### 7.1 Build em um comando (recomendado)

```bash
cd appphp
npm run build
# equivalente:
node tools/wheels.mjs build
```

O comando:

1. roda as mesmas verificações de `check`;
2. recusa o build se o Firebase estiver incompleto (salvo com
   `--allow-placeholder`);
3. apaga e recria `build/` do zero;
4. copia apenas o runtime: `index.html`, `css/`, `js/`, `lang/`, `assets/`,
   `manifest.webmanifest`, `robots.txt` e `.htaccess`;
5. confere se nenhum arquivo de desenvolvimento entrou na pasta;
6. grava o manifesto em `.wheels/last-build.json`;
7. mostra a contagem e o tamanho dos arquivos.

Saída esperada:

```text
[OK] Build concluido: 27 arquivos, 640.5 KB.
Conteudo de build/:
- index.html
- manifest.webmanifest
- robots.txt
- .htaccess
- css
- js (8 arquivos)
- lang (3 arquivos)
- assets
```

Opções úteis:

```bash
npm run build -- --online          # testa CDNs e apiKey antes
npm run build -- --open            # abre a pasta build ao final
npm run build -- --skip-check      # emergência; não recomendado
npm run build -- --allow-placeholder
npm run build -- --webgpu          # inclui o runtime ONNX WebGPU (+21 MB)
```

O resultado é `appphp/build/`, pronta para upload. Envie o **conteúdo** dela
para `public_html/app` — não envie a pasta `build` em si.

### 7.2 Validação manual (alternativa)

Se preferir não usar o CLI, os comandos abaixo fazem parte da mesma checagem.

Com Node.js instalado, dentro de `appphp`:

**PowerShell (Windows):**

```powershell
Get-ChildItem js -Filter *.js | ForEach-Object {
  Get-Content -Raw $_.FullName | node --input-type=module --check
  if ($LASTEXITCODE -ne 0) { throw "Erro de sintaxe em $($_.Name)" }
}
```

**Bash / macOS / Linux / Git Bash:**

```bash
for f in js/*.js; do
  node --input-type=module --check < "$f" || exit 1
done
```

**Validar os três dicionários:**

```bash
node -e "const fs=require('fs');for(const f of ['en-CA','fr-CA','pt-BR']){JSON.parse(fs.readFileSync('lang/'+f+'.json','utf8'));console.log(f,'ok')}"
```

**Conferir se todas as chaves usadas existem nos três idiomas:**

```bash
node -e "const fs=require('fs');const d=Object.fromEntries(['en-CA','fr-CA','pt-BR'].map(l=>[l,JSON.parse(fs.readFileSync('lang/'+l+'.json','utf8'))]));const used=new Set();for(const f of ['index.html','js/app.js']){const s=fs.readFileSync(f,'utf8');for(const m of s.matchAll(/\bt\(\s*'([a-zA-Z0-9_]+)'/g))used.add(m[1])}for(const l in d){const miss=[...used].filter(k=>!(k in d[l]));console.log(l,miss.length?'faltando: '+miss.join(', '):'ok')}"
```

### 7.3 Checklist manual antes de publicar

- [ ] Login, cadastro e “esqueci a senha” funcionam.
- [ ] Rotas protegidas redirecionam para o login.
- [ ] Dashboard lista os itens e a busca filtra por **nome e descrição**.
- [ ] Cadastro salva nome, descrição e foto.
- [ ] A foto exportada tem exatamente 500×500 (veja em uma nova aba a imagem
      salva, ou inspecione o Base64).
- [ ] Edição mantém a imagem atual quando nenhuma nova é escolhida.
- [ ] Exclusão remove o documento do Firestore.
- [ ] Tema claro/escuro/sistema, as 5 paletas e os 3 idiomas persistem após
      recarregar.
- [ ] Layout em coluna única no celular e grid no desktop.
- [ ] Console sem erros (`permission-denied`, 404 de `lang/*.json`, CORS).
- [ ] Teste em Chrome/Edge e, se possível, Safari/Firefox.

### 7.4 O que vai para o build

`npm run build` copia exatamente estes itens:

```text
index.html
css/
js/
lang/
assets/
manifest.webmanifest
robots.txt
.htaccess
```

**Nunca entram** no build: `README.md`, `README.pt-BR.md`, `firebase.json`,
`firestore.rules`, `firestore.indexes.json`, `.firebaserc`,
`firebase-debug.log`, `tools/`, `package.json`, `build/` e `.wheels/`.

Se preferir montar a pasta manualmente, copie a lista de runtime para `build/`
(ou direto para `public_html/app`), incluindo o `.htaccess`.

### 7.5 Opcional: minificar

A minificação não é necessária para funcionar, mas reduz o download:

```bash
npx html-minifier-terser --collapse-whitespace --remove-comments \
  --minify-css true --minify-js true index.html -o index.min.html
```

Se usar `index.min.html`, renomeie para `index.html` **depois de testar**.
O mesmo vale para CSS/JS. Evite minificar `firebase-config.js` manualmente
antes de configurar as chaves.

### 7.6 Tailwind é compilado (sem CDN)

O app carrega uma folha **já compilada**, `css/tailwind.css`. Não existe mais
`cdn.tailwindcss.com`: o CDN compilava as classes no navegador a cada carga,
imprimia um aviso de produção e custava ~400 KB de JavaScript.

Como funciona:

- `tailwind.config.cjs` (raiz) declara `darkMode: 'class'`, os `content`
  (`index.html`, `js/**/*.js`) e a paleta `brand` ligada às variáveis CSS;
- `tailwind.src.css` (raiz) é o ponto de entrada do CLI;
- `css/tailwind.css` é a saída gerada e **fica versionada**, então o app
  continua funcionando sem build.

Regenere quando nomes de classe mudarem:

```bash
npm run css         # uma vez, minificado (~26 KB)
npm run css:watch   # reconstrói enquanto você edita o index.html
```

O `npm run check` compara as datas e avisa quando `index.html` ou algum
`js/*.js` está mais novo que `css/tailwind.css` — sinal de que a folha precisa
ser regerada. A primeira execução precisa de internet, porque o `npx` baixa o
`tailwindcss@3`; depois ele vem do cache do npm.

Se você usar uma classe que o Tailwind não gera (valor arbitrário com espaço,
ou classe montada dinamicamente em JavaScript), inclua-a num `safelist` do
`tailwind.config.cjs`.

### 7.7 Versionamento e cache

- `index.html`, `lang/*.json` e `firebase-config.js` são servidos com
  `no-cache` + revalidação pelo `.htaccess`.
- CSS e JS são revalidados a cada carregamento (`no-cache, must-revalidate`):
  o deploy aparece no próximo recarregamento e um arquivo igual custa um 304.
  Ícones e fontes mantêm cache de 1 dia.
- Após atualizar arquivos, limpe o cache da Hostinger (seção 8.7) e faça um
  hard refresh (`Ctrl+Shift+R`).
- Se precisar forçar a troca de um arquivo específico, adicione `?v=2` nas
  referências dentro do `index.html`.

---

## 8. Deploy na Hostinger (`public_html/app`)

O objetivo final:

```text
public_html/
└── app/
    ├── index.html
    ├── .htaccess
    ├── css/
    ├── js/
    ├── lang/
    └── assets/
```

A URL ficará `https://seudominio.com/app/`.

### 8.1 Antes de subir

1. Confirme que as regras do Firestore foram publicadas (seção 3.4).
2. Confirme que o domínio está em **Authentication → Domínios autorizados**.
3. Faça o checklist da seção 7.3 localmente.
4. Rode `npm run build` (seção 7.1) e tenha em mãos o **conteúdo** de
   `appphp/build/` (seção 7.4).

### 8.2 Criar a pasta no hPanel

1. Entre no **hPanel** da Hostinger.
2. Vá em **Sites → Gerenciar → Gerenciador de arquivos**.
3. Abra `public_html`.
4. Crie a pasta `app` (minúscula, sem espaços).
5. Entre em `public_html/app`.

Se você já tem WordPress ou outro site na raiz, não há problema: o app fica
isolado em `/app`.

### 8.3 Enviar os arquivos

**Pelo Gerenciador de Arquivos:**

1. Dentro de `public_html/app`, clique em **Upload**.
2. Envie o **conteúdo** de `appphp/build/`: `index.html`,
   `manifest.webmanifest`, `robots.txt`, `.htaccess`, `css/`, `js/`, `lang/`
   e `assets/`.
3. Se preferir, compacte o conteúdo de `build/` em um `.zip`, envie e use
   **Extrair**.
4. **Importante:** o `index.html` deve ficar **diretamente** em
   `public_html/app/index.html`. Não envie a pasta `appphp` nem a pasta
   `build` em si; envie o **conteúdo** dela.

**Por FTP/SFTP (FileZilla, por exemplo):**

1. Em **hPanel → Arquivos → Contas FTP** (ou **Acesso SSH**), copie host,
   usuário, senha e porta.
2. Conecte e abra `public_html/app`.
3. Ative **Server → Force showing hidden files** para ver e enviar o
   `.htaccess`.
4. Envie os arquivos e pastas na mesma estrutura acima.

### 8.4 O `.htaccess` é um arquivo oculto

O `.htaccess` começa com ponto e pode não aparecer:

- No Gerenciador de Arquivos da Hostinger, ative **Configurações → Mostrar
  arquivos ocultos**.
- No FileZilla, use **Server → Force showing hidden files**.
- No macOS Finder, use `Cmd+Shift+.`.
- No Windows Explorer, use **Exibir → Itens ocultos**.

Sem o `.htaccess` o app **ainda funciona**, mas perde compressão, cache e os
cabeçalhos de segurança.

### 8.5 Permissões

- Pastas: `755`.
- Arquivos: `644`.
- Não use `777`.

No Gerenciador de Arquivos, clique com o botão direito → **Permissões** para
ajustar. Em geral a Hostinger já aplica os valores corretos no upload.

### 8.6 HTTPS e domínio

1. Em **hPanel → Segurança → SSL**, instale/ative o certificado gratuito para
   o domínio (Let’s Encrypt).
2. Ative **Forçar HTTPS**.
3. Abra `https://seudominio.com/app/` (com barra no final).
4. Se usar `www`, garanta que ele também esteja nos domínios autorizados do
   Firebase e que redirecione para o domínio principal.

### 8.7 Cache da Hostinger

A Hostinger usa LiteSpeed e pode ter cache de página ativado:

1. Em **hPanel → Avançado → Cache Manager** (ou **LiteSpeed Cache**), limpe o
   cache após cada deploy.
2. Se houver Cloudflare, faça **Purge Everything** no painel da Cloudflare.
3. No navegador, use `Ctrl+Shift+R` (Windows) ou `Cmd+Shift+R` (macOS).

Se o cache da hospedagem ignorar os cabeçalhos do `.htaccess`, desative o
cache de página para `/app` ou para o site inteiro.

### 8.8 Teste em produção

1. Abra a URL e confirme que a tela de login aparece.
2. Crie uma conta ou entre com uma conta existente.
3. Cadastre, edite e exclua um item.
4. Recarregue a página em uma rota com hash, por exemplo
   `https://seudominio.com/app/#/settings`.
5. Confira o Console do navegador: não deve haver `auth/unauthorized-domain`,
   `permission-denied` nem 404 de `lang/*.json`.

### 8.9 Atualizar o app

1. Substitua `index.html`, `css/`, `js/`, `lang/` e `assets/` pelos novos.
2. Mantenha o `.htaccess` (a menos que ele tenha mudado).
3. Limpe o cache da Hostinger/Cloudflare.
4. Faça hard refresh e teste o login.

Nunca apague a pasta `app` inteira durante uma atualização; envie por cima ou
renomeie a antiga para `app_backup` antes.

### 8.10 Subdomínio (opcional)

Se preferir `https://app.seudominio.com`:

1. Crie o subdomínio no hPanel apontando o **document root** para
   `public_html/app`.
2. Adicione `app.seudominio.com` aos domínios autorizados do Firebase.
3. Ative SSL para o subdomínio.
4. A URL passa a ser `https://app.seudominio.com/` (sem `/app`).

---

## 9. Solução de problemas

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| Tela “Firebase não está configurado” | `js/firebase-config.js` com valores vazios/placeholder | Preencha `apiKey`, `authDomain`, `projectId` e `appId` |
| Splash infinito | CDN bloqueado, módulo com erro ou sem internet | Abra o Console; confira `js/app.js` e os CDNs; a mensagem de fallback aparece após 15 s |
| `auth/unauthorized-domain` | Domínio não autorizado | Adicione o domínio em Authentication → Domínios autorizados |
| `auth/operation-not-allowed` | E-mail/senha desativado | Ative o método em Authentication → Métodos de login |
| `auth/invalid-credential` | E-mail ou senha incorretos | Verifique os dados; a mensagem é genérica de propósito |
| `permission-denied` / “Missing or insufficient permissions” | Regras não publicadas ou `userId` divergente | Publique `firestore.rules`; confira o UID no documento |
| Lista vazia mesmo com documentos | Documentos antigos em `cars`/`ownerId` | Migre os dados (seção 13) ou cadastre novamente |
| E-mail de redefinição não chega | Spam, domínio/template ou limite do Firebase | Confira spam, remetente e Domínios autorizados; aguarde alguns minutos |
| Imagem não aparece | Base64 truncado ou documento acima de 1 MiB | Recorte novamente; confira o tamanho em caracteres |
| Recorte falha | Formato não suportado (HEIC) ou arquivo muito grande | Use JPEG/PNG/WebP com menos de 20 MB |
| Textos aparecem como chaves (`navHome`) | Dicionário não carregou | Confira 404 em `lang/*.json`, nome exato e caminho relativo |
| Idioma não muda | `localStorage` bloqueado ou JSON inválido | Teste em janela normal; valide o JSON |
| Preferências somem | Navegação privada/limpeza automática | Use uma janela normal; o comportamento é esperado |
| 404 ao recarregar uma rota | URL sem `#` | Use `#/rota`; o app é SPA com hash e não precisa de rewrite |
| Erro 500 no `.htaccess` | `Options`/diretivas não permitidas | Remova a linha `Options -Indexes -MultiViews` e teste; mantenha o restante |
| CSS quebrado em produção | `css/tailwind.css` ausente ou desatualizado | Rode `npm run css` e reenvie `css/`; o `npm run check` avisa quando a folha está mais antiga que o HTML |
| Cache antigo após deploy | LiteSpeed/Cloudflare/navegador | Limpe os três caches e faça hard refresh |
| `does not provide an export named …` após o deploy | O navegador ou a hospedagem manteve um `js/app.js` antigo enquanto o `index.html`/`controller.js` já eram os novos (grafo de módulos misturado) | Hard refresh (`Ctrl+Shift+R`) e purgue o cache da hospedagem. Como o `.htaccess` agora envia `no-cache` para JS, do próximo deploy em diante basta recarregar |
| `quota-exceeded` | Limite diário do Firestore | Aguarde a renovação ou ajuste o plano |
| Login local funciona, produção não | Domínio autorizado ausente | Adicione o domínio de produção no Firebase |

### 9.1 Problemas do CLI

| Sintoma | Solução |
| --- | --- |
| `node` não é reconhecido | Instale Node.js 18+ em <https://nodejs.org/> e reabra o terminal |
| `wheels.cmd` abre e fecha | Execute dentro de `appphp`; confirme com `node --version` |
| `Permission denied` no `wheels.sh` | Rode `chmod +x tools/wheels.sh` uma vez |
| Porta 8080 ocupada | Use `npm run dev -- --port 3000` |
| Live reload não funciona | Acesse por `http://localhost`, não `file://`; proxies/antivírus podem bloquear SSE |
| `configure` recusa a `apiKey` | Copie novamente do Console; a chave tem 39 caracteres e começa com `AIza` |
| `check` acusa tradução | Compare chaves e placeholders com `lang/en-CA.json` |
| `build` recusa o Firebase | Rode `npm run configure`; use `--allow-placeholder` só para testar a tela de setup |
| `build` não encontra arquivos | Execute o comando a partir de `appphp/` |
| Hostinger mostra 403 em `/tools` | Correto: as ferramentas não devem ser publicadas |

As cores do terminal podem ser desativadas com `NO_COLOR=1` (ou
`$env:NO_COLOR=1` no PowerShell).

### 9.2 Onde olhar primeiro

1. Console do navegador (erros em vermelho).
2. Aba Network (status 401/403/404).
3. Firestore → Regras (publicadas?).
4. Authentication → Domínios autorizados.
5. Se o app nem carrega: teste o CDN em outra aba e confira se o
   `index.html` está na raiz de `/app`.

---

## 10. Segurança e limites

- **Nunca** coloque uma chave de service account (Admin SDK) dentro de
  `public_html`. O app usa apenas o SDK client-side.
- A `apiKey` Web é pública; as **Security Rules** são a barreira real.
- O app não usa `innerHTML`/`x-html` com dados do usuário; todo texto é
  renderizado com `x-text`, que escapa HTML.
- As imagens são reencodadas para JPEG pelo Canvas antes de salvar.
- Use **HTTPS** em produção.
- Mantenha o Firebase Auth com proteção contra enumeração de e-mail (padrão
  atual) e monitore o uso no Console.
- Opcional: ative **Firebase App Check** (reCAPTCHA v3) para reduzir abuso.
  Isso exige adicionar o SDK e configurar a chave no Console; não está
  incluído para manter o app leve.
- Limites aplicados no cliente e nas regras:
  - nome ≤ 120;
  - descrição ≤ 2000;
  - imagem Base64 ≤ 900.000 caracteres;
  - arquivo de origem ≤ 20 MB;
  - senha ≥ 6 caracteres.

### Privacidade

O app é privado: `robots.txt` bloqueia indexação e o `index.html` tem
`<meta name="robots" content="noindex, nofollow">`. Não há analytics nem
cookies de terceiros; apenas Firebase e o CDN jsDelivr (Alpine e Tesseract).

---

## 11. Backup e exportação

- **Firestore:** o Console permite exportar para um bucket do Cloud Storage
  (requer plano Blaze). Para uma cópia simples, use um script com o Admin SDK
  (seção 13) ou mantenha os dados no próprio Firestore.
- **Código:** guarde uma cópia de `appphp/` (zip ou repositório Git).
- **Configuração:** `js/firebase-config.js` contém apenas dados públicos.
  Guarde as credenciais de service account (se usar) fora do projeto.
- **Fotos:** estão dentro dos documentos (`imageBase64`). Ao exportar
  documentos, as fotos vão junto.

---

## 12. Limitações conhecidas

- Não há verificação de e-mail, exclusão de conta ou login social (não faziam
  parte do escopo original).
- Não há upload de múltiplas fotos por carrinho; o modelo tem uma imagem.
- O Tailwind é compilado: uma classe nova só aparece depois de `npm run css`
  (seção 7.6).
- Não há service worker; o app não funciona offline.
- O OCR usa Tesseract.js via CDN: a primeira leitura exige internet para baixar
  o core e o modelo de idioma. O reconhecimento é local e a foto não é enviada
  a nenhum serviço de OCR.
- A versão exibida em Configurações é estática (`1.0.0`) e pode ser alterada
  no `index.html`.
- O Firestore tem limite de 1 MiB por documento; por isso a imagem é limitada
  a 500×500 e 900.000 caracteres.

---

## 13. Migrar os dados antigos (opcional)

O app Flutter usava:

```text
cars/{carId}
  ownerId, name, description, imageBase64, createdAt, updatedAt
```

Esta versão usa:

```text
hotwheels_items/{itemId}
  userId, name, description, imageBase64, createdAt, updatedAt
```

Ou seja, é preciso copiar `ownerId → userId` e trocar a coleção. As imagens
antigas já estavam em 500×500 JPEG, então podem ser copiadas como estão.

### Opção 1 — começar do zero (recomendado)

Mantenha os dados antigos apenas como backup e cadastre os carrinhos
novamente. É a opção mais simples e sem risco de misturar contas.

### Opção 2 — script com Firebase Admin SDK

Rode **no seu computador**, nunca no `public_html`:

```bash
mkdir migrate && cd migrate
npm init -y
npm install firebase-admin
```

Crie `migrate.mjs`:

```js
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const serviceAccount = JSON.parse(
  readFileSync('./service-account.json', 'utf8'),
);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const source = await db.collection('cars').get();
let migrated = 0;

for (const doc of source.docs) {
  const data = doc.data();

  await db.collection('hotwheels_items').doc(doc.id).set({
    userId: data.ownerId,
    name: data.name ?? '',
    description: data.description ?? '',
    imageBase64: data.imageBase64 ?? '',
    createdAt: data.createdAt ?? new Date(),
    updatedAt: data.updatedAt ?? new Date(),
  });

  migrated += 1;
  console.log(`Migrado: ${doc.id}`);
}

console.log(`Total: ${migrated}`);
```

Passos:

1. Gere uma chave de service account em **Configurações do projeto → Contas de
   serviço → Gerar nova chave privada**.
2. Salve como `service-account.json` **fora** do projeto web.
3. Execute `node migrate.mjs`.
4. Confira no Console se os documentos apareceram em `hotwheels_items` com o
   `userId` correto.
5. Apague a chave privada do disco depois de migrar.

O Admin SDK ignora as Security Rules, por isso o script consegue escrever em
nome dos usuários. Não exponha essa chave nem esse script na web.

### Opção 3 — exportação/importação do Firestore

O export/import do Firestore mantém os **nomes das coleções**, então não faz o
mapeamento `cars → hotwheels_items` sozinho. Use o script do Admin SDK para
essa transformação. Você pode exportar antes como backup:

```bash
gcloud firestore export gs://SEU_BUCKET/backup-cars
```

---

## 14. Remover o Flutter do projeto (opcional)

O código Flutter foi **mantido** nesta entrega para permitir rollback. O app
novo é independente e pode ser publicado apenas com a pasta `appphp/`.

Quando estiver tudo validado e você não precisar mais do app antigo:

1. **Faça um backup completo** do projeto (zip ou branch/tag Git).
2. Guarde `app_config.env` em local seguro se ainda precisar das credenciais
   (ele é ignorado pelo Git e contém chaves).
3. Remova, na raiz:
   - `lib/`, `test/`, `android/`, `ios/`, `web/`, `tool/`, `build/`,
     `.dart_tool/`;
   - `pubspec.yaml`, `pubspec.lock`, `analysis_options.yaml`, `l10n.yaml`,
     `.metadata`, `.flutter-plugins-dependencies`, `wheelscollection.iml`;
   - `app_config.env`, `.env.example`;
   - `firebase.json`, `firestore.rules`, `firestore.indexes.json` da raiz
     (a versão nova está em `appphp/`);
   - `README.md` antigo (substitua por um que aponte para `appphp/`).
4. Mantenha `appphp/` e, se quiser, `docs/` e `.vscode/`.
5. Confirme que o deploy da Hostinger usa apenas o conteúdo de `appphp/`.

Exemplo de remoção no PowerShell ( **revise antes de executar** e rode a partir
da raiz do projeto):

```powershell
Remove-Item -Recurse -Force lib, test, android, ios, web, tool, build, .dart_tool

$oldFiles = @(
  'pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml', 'l10n.yaml',
  '.metadata', '.flutter-plugins-dependencies', 'wheelscollection.iml',
  'app_config.env', '.env.example', 'firebase.json', 'firestore.rules',
  'firestore.indexes.json'
)
Remove-Item -Force $oldFiles
```

> Não remova `appphp/`. Se estiver em dúvida, mova os arquivos antigos para
> uma pasta `_flutter_backup/` em vez de apagar.

---

## 15. Checklist final de publicação

- [ ] Firebase project criado e app Web registrado.
- [ ] `js/firebase-config.js` com os valores corretos.
- [ ] E-mail/senha ativado no Authentication.
- [ ] Firestore criado na região escolhida.
- [ ] `firestore.rules` publicado.
- [ ] Domínio de produção em **Domínios autorizados**.
- [ ] Testes locais da seção 7.3 aprovados.
- [ ] Arquivos de runtime enviados para `public_html/app`.
- [ ] `index.html` na raiz de `/app` (não dentro de `/app/appphp`).
- [ ] `.htaccess` enviado (arquivo oculto).
- [ ] Permissões 755/644.
- [ ] SSL ativo e HTTPS forçado.
- [ ] Cache da Hostinger/Cloudflare limpo.
- [ ] Login, cadastro, CRUD, busca, crop, tema, paleta e idiomas testados em
      produção.
- [ ] Backup do código e dos dados antigos guardado.

---

## 16. Referências úteis

- Firebase Console: <https://console.firebase.google.com/>
- Documentação do Firebase Auth Web:
  <https://firebase.google.com/docs/auth/web/start>
- Documentação do Firestore Web:
  <https://firebase.google.com/docs/firestore/quickstart>
- Security Rules:
  <https://firebase.google.com/docs/firestore/security/get-started>
- Alpine.js: <https://alpinejs.dev/>
- Tesseract.js: <https://github.com/naptha/tesseract.js/>
- Tailwind CSS: <https://tailwindcss.com/>
- Central de ajuda da Hostinger:
  <https://support.hostinger.com/>

---

**Versão:** 1.0.0 · **Idiomas:** en-CA, fr-CA, pt-BR · **Última atualização:**
novembro de 2026.
