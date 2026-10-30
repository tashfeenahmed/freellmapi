<div align="center">

# FreeLLMAPI

**Oyiga 7,4 milliard token. 34 ta bepul LLM provayderi. 635 ta bepul model endpointi. OpenAI bilan mos bitta endpoint.**

O'nlab provayderlarning bepul tariflarini, shuningdek, OpenAI bilan mos keladigan istalgan chat, embedding, rasm va audio endpointlaringizni bitta `/v1` API orqasida birlashtiring. Kalitlar shifrlangan holda saqlanadi. Router har bir so'rov uchun eng yaxshi mavjud modelni tanlaydi, provayder limitga yetganda keyingisiga o'tadi va har bir kalitning sarfini kuzatib boradi, shunda siz hech bir bepul tarif limitidan oshib ketmaysiz.

[![CI](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/tashfeenahmed/freellmapi?style=flat&logo=github&color=yellow)](https://github.com/tashfeenahmed/freellmapi/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#hissa-qoshish)
[![Docker image](https://img.shields.io/badge/ghcr.io-freellmapi-2496ED?logo=docker&logoColor=white)](https://github.com/tashfeenahmed/freellmapi/pkgs/container/freellmapi)
[![Ask DeepWiki](https://img.shields.io/badge/DeepWiki-Ask-blue)](https://deepwiki.com/tashfeenahmed/freellmapi)

**[freellmapi.co](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=repository&utm_content=readme_top)** · to'liq katalogni ko'ring: 474 ta model oilasi, 635 ta bepul endpoint

[English](README.md) · [简体中文](README.zh-cn.md) · [Русский](README.ru.md) · **O'zbekcha**

Bu tarjima ortda qolishi mumkin. Eng so'nggi ma'lumot uchun inglizcha README'ga qarang.

<p align="center">
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/macos.svg" height="48" alt="Download for macOS"></a>
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/windows.svg" height="48" alt="Download for Windows"></a>
  <a href="docs/en/install/01-install.md#docker-compose"><img src="repo-assets/badges/docker.svg" height="48" alt="Self-host with Docker"></a>
  <a href="https://play.google.com/store/apps/details?id=co.freellmapi.app"><img src="repo-assets/badges/play-store.svg" height="48" alt="Get it on Google Play"></a>
  <a href="https://apps.apple.com/app/id6804648934"><img src="repo-assets/badges/app-store.svg" height="48" alt="Download on the App Store"></a>
</p>

![FreeLLMAPI dashboard: oylik token hajmi ko'rsatilgan Modellar sahifasi](repo-assets/github-hero.png)

Routeringiz model katalogini imzolangan manbadan o'zi yangilaydi: yangi bepul modellar, limit o'zgarishlari va moslik tuzatishlari `git pull` qilmasdan yetib keladi. Bepul o'rnatmalar oylik snapshotni oladi, ya'ni model jonli manbaga qo'shilganidan 30 kun o'tib ularga yetib boradi; premium routerlar uni o'sha kuniyoq oladi.
**[freellmapi.co'da jonli manbaga ulaning](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_top#pricing)** (yiliga $19, istalgan vaqtda bekor qilish mumkin).

</div>

---

## Mundarija

- [Bu loyiha nega kerak](#bu-loyiha-nega-kerak)
- [Qo'llab-quvvatlanadigan provayderlar](#qollab-quvvatlanadigan-provayderlar)
- [Mos CLI'lar va kodlash agentlari](#mos-clilar-va-kodlash-agentlari)
- [Boshqalar bilan taqqoslash](#boshqalar-bilan-taqqoslash)
- [Imkoniyatlar](#imkoniyatlar)
- [Tez boshlash](#tez-boshlash)
- [Desktop ilova](#desktop-ilova)
- [OpenAI bilan mos klientlar](#openai-bilan-mos-klientlar)
- [Tillar](#tillar)
- [Premium (jonli katalog)](#premium-jonli-katalog)
- [API'dan foydalanish](#apidan-foydalanish)
- [Skrinshotlar](#skrinshotlar)
- [Qanday ishlaydi](#qanday-ishlaydi)
- [Ko'p beriladigan savollar](#kop-beriladigan-savollar)
- [Cheklovlar](#cheklovlar)
- [Hissa qo'shish](#hissa-qoshish)
- [Ogohlantirish](#ogohlantirish)

**Qo'llanmalar (ingliz tilida):** [O'rnatish va deploy](docs/en/install/01-install.md) · [API ma'lumotnomasi](docs/en/api/01-rest-api.md) · [Klientlar va kodlash agentlari](docs/en/clients/01-agent-clients.md) · [Promptni siqish](docs/en/compression/01-compression-pipeline.md) · [Arxitektura va ichki tuzilish](docs/en/architecture/00-high-level-index.md) · [Hujjatlar ro'yxati](docs/en/README.md) · [Hissa qo'shuvchilar uchun qo'llanma](CONTRIBUTING.md)

## Bu loyiha nega kerak

Bugun har bir jiddiy AI laboratoriyasi bepul tarif taklif qiladi: oyiga bir necha million token, kuniga bir necha ming so'rov. Alohida olinganda har bir tarif o'yinchoqdek gap. Lekin ularni birlashtirsangiz, oyiga taxminan **7,4 milliard token** ishchi inference quvvati hosil bo'ladi. Bu kichik va tezkor modellardan tortib ancha qobiliyatlilarigacha bo'lgan **474 ta model oilasi / 635 ta provayder endpointi**ni qamrab oladi.

Muammo shundaki, ularni qo'lda birlashtirish juda og'ir: o'ttiz to'rtta turli SDK, o'ttiz to'rtta turli limit, so'rov xato berishi mumkin bo'lgan o'ttiz to'rtta joy. FreeLLMAPI bularning hammasini OpenAI bilan mos bitta endpointga jamlaydi. Istalgan OpenAI klient kutubxonasini lokal serveringizga yo'naltiring, u esa so'rovlarni siz kalit qo'shgan provayderlar bo'ylab sezdirmasdan taqsimlaydi.

Bundan tashqari, bepul tariflar manzarasi har hafta o'zgaradi: provayderlar ogohlantirmasdan model chiqaradi, eskilarini o'chiradi va limitlarni o'zgartiradi. FreeLLMAPI bularning barchasini siz uchun kuzatib boradi. Router imzolangan model katalogini [freellmapi.co](https://freellmapi.co) dan o'zi tortib oladi, shuning uchun o'rnatmangiz `git pull` qilmasdan ham dolzarb bo'lib turadi. Qanchalik tez yangilanishi haqida [Premium (jonli katalog)](#premium-jonli-katalog) bo'limida o'qing.

![Bepul tariflar birlashtirilganda: 34 ta provayder bo'ylab oyiga ~7,4 mlrd token bepul inference](repo-assets/free-tier.png)

## Qo'llab-quvvatlanadigan provayderlar

<div align="center">
<table>
<tr>
<td align="center" width="150"><img src="repo-assets/providers/google.png" width="44" alt="Google"><br/><b>Google</b></td>
<td align="center" width="150"><picture><source media="(prefers-color-scheme: dark)" srcset="repo-assets/providers/groq-dark.png"><img src="repo-assets/providers/groq.png" width="44" alt="Groq"></picture><br/><b>Groq</b></td>
<td align="center" width="150"><img src="repo-assets/providers/cerebras.png" width="44" alt="Cerebras"><br/><b>Cerebras</b></td>
<td align="center" width="150"><picture><source media="(prefers-color-scheme: dark)" srcset="repo-assets/providers/opencode-dark.png"><img src="repo-assets/providers/opencode.png" width="44" alt="OpenCode Zen"></picture><br/><b>OpenCode Zen</b></td>
</tr>
<tr>
<td align="center"><img src="repo-assets/providers/mistral.png" width="44" alt="Mistral"><br/><b>Mistral</b></td>
<td align="center"><img src="repo-assets/providers/openrouter.png" width="44" alt="OpenRouter"><br/><b>OpenRouter</b></td>
<td align="center"><img src="repo-assets/providers/cloudflare.png" width="44" alt="Cloudflare"><br/><b>Cloudflare</b></td>
<td align="center"><img src="repo-assets/providers/cohere.png" width="44" alt="Cohere"><br/><b>Cohere</b></td>
</tr>
<tr>
<td align="center"><img src="repo-assets/providers/zhipu.png" width="44" alt="Z.ai (Zhipu)"><br/><b>Z.ai (Zhipu)</b></td>
<td align="center"><img src="repo-assets/providers/nvidia.png" width="44" alt="NVIDIA"><br/><b>NVIDIA</b></td>
<td align="center"><img src="repo-assets/providers/huggingface.png" width="44" alt="HuggingFace"><br/><b>HuggingFace</b></td>
</tr>
<tr>
<td align="center"><a href="https://modelscope.cn"><b>ModelScope</b><br/>Qwen3 · DeepSeek V4 · GLM-5 (needs Aliyun cn binding)</a></td>
</tr>
</table>

<i>… va yana 22 ta bepul provayder</i>

</div>

Bundan tashqari **custom** provayder ham bor: **Kalitlar** (Keys) sahifasida chat, embedding, rasm yoki audio modellarni OpenAI bilan mos istalgan endpointga (llama.cpp, LM Studio, vLLM, lokal Ollama yoki masofaviy gateway) yo'naltirishingiz mumkin.

To'liq va doim dolzarb ro'yxat **[freellmapi.co/models](https://freellmapi.co/models.html)** sahifasida: har bir model uchun limitlar, kontekst oynasi va bepul token hajmi bilan.

## Mos CLI'lar va kodlash agentlari

<div align="center">
<table>
<tr>
<td align="center" width="150"><img src="repo-assets/agents/claude-code.png" width="44" alt="Claude Code"><br/><b>Claude Code</b></td>
<td align="center" width="150"><img src="repo-assets/agents/codex.png" width="44" alt="Codex CLI"><br/><b>Codex CLI</b></td>
<td align="center" width="150"><img src="repo-assets/agents/gemini-cli.png" width="44" alt="Gemini CLI"><br/><b>Gemini CLI</b></td>
<td align="center" width="150"><img src="repo-assets/agents/cursor.png" width="44" alt="Cursor"><br/><b>Cursor</b></td>
</tr>
<tr>
<td align="center"><img src="repo-assets/agents/cline.png" width="44" alt="Cline"><br/><b>Cline</b></td>
<td align="center"><img src="repo-assets/agents/roo-code.png" width="44" alt="Roo Code"><br/><b>Roo Code</b></td>
<td align="center"><img src="repo-assets/agents/opencode.png" width="44" alt="OpenCode"><br/><b>OpenCode</b></td>
<td align="center"><img src="repo-assets/agents/aider.png" width="44" alt="Aider"><br/><b>Aider</b></td>
</tr>
</table>

<i>… shuningdek Continue, Goose, Qwen Code, Kilo Code, Crush, Zed, JetBrains AI, DeepSeek Harness, MiMo Code, AtomCode, OpenClaw, Hermes Agent, Pi, Reasonix, ZCode va OpenAI, Anthropic, Gemini yoki Ollama bilan mos istalgan klient</i>

</div>

Ko'pchilik agentlar bitta buyruq bilan sozlanadi: u jonli katalogingizni o'qiydi, mavjud konfiguratsiyaning zaxira nusxasini oladi va o'zgarishlarni unga qo'shadi:

```bash
npx freellmapi setup-claude --url http://localhost:3001 --api-key <unified-key>
```

**[Barcha qo'llab-quvvatlanadigan agentlar va ularni sozlash buyruqlari →](docs/en/clients/02-supported-agents.md)** · [Har bir vosita uchun retseptlar, MCP server va URL tokenlar →](docs/en/clients/01-agent-clients.md)

## Boshqalar bilan taqqoslash

![OpenRouter, LiteLLM va Portkey bilan imkoniyatlar taqqoslanishi](repo-assets/comparison.png)

Ochiq hujjatlar asosida, 2026-yil iyul. Tuzatishlar mamnuniyat bilan qabul qilinadi.

## Imkoniyatlar

![Imkoniyatlar sharhi](repo-assets/features.png)

- **OpenAI uslubidagi barcha endpointlar**: `/v1/chat/completions`, `/v1/responses` (Codex CLI uchun kerak), `/v1/completions` (muharrirdagi ghost-text avtoto'ldirish), `/v1/images/generations`, `/v1/videos/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/embeddings` va `/v1/models`. Streaming va oddiy rejimda, rasmiy SDK'lardan yoki OpenAI bilan mos istalgan klientdan ishlaydi. [API ma'lumotnomasi →](docs/en/api/01-rest-api.md)
- **Anthropic Messages API**: `/v1/messages` xuddi shu router ustida Anthropic formatida ishlaydi, shuning uchun **Claude Code** va rasmiy Anthropic SDK'lari bepul pulingizda ishlay oladi. [Batafsil →](docs/en/api/01-rest-api.md#anthropic--claude-clients)
- **Gemini va Ollama'ning o'z endpointlari**: Gemini CLI `/v1beta` dan foydalana oladi (`generateContent`, streaming, token sanash, modellar). Ixtiyoriy yoqiladigan Ollama emulyatsiyasi esa Zed, JetBrains va boshqa lokal model klientlari uchun NDJSON chat/generate, tags, metama'lumot va embeddinglarni taqdim etadi.
- **Fusion (bir nechta modeldan sintez)**: virtual `fusion` modelini so'rasangiz, router promptingizni turli bepul modellardan iborat guruhga parallel yuboradi, so'ng hakam model qoralamalardan bitta javob tuzib beradi. [Batafsil →](docs/en/api/01-rest-api.md#fusion-multi-model-synthesis)
- **Rasm, video va nutq generatsiyasi**: `/v1/images/generations`, `/v1/videos/generations` va `/v1/audio/speech` so'rovlarni media modellar taqdim etadigan provayderlarga yo'naltiradi. Rasm va nutq uchun OpenAI bilan mos o'z media endpointlaringizni ham ulash mumkin. Video vazifalari sinxron va navbatli provayderlar o'rtasida bir xil ko'rinishga keltiriladi va tayyor MP4 qaytaradi.
- **Tool calling va strukturali javoblar**: OpenAI uslubidagi `tools` provayderlar bo'ylab to'liq ishlaydi (oddiy matn ko'rinishidagi tool chaqiruvlari haqiqiy `tool_calls` ga aylantiriladi). Shuningdek `response_format`, `seed`, `logprobs`, penaltilar va boshqa sampling parametrlari har bir provayderga uzatiladi.
- **Aqlli routing, oltita strategiya**: har bir modelning jonli tezlik, qobiliyat va ishonchlilik ballari zanjiringizni tartiblaydi. 429/5xx xatolarida avtomatik ravishda keyingi model sinab ko'riladi, kalit "sovitiladi" va kalitlar almashtiriladi. [Routing batafsil →](docs/en/architecture/00-high-level-index.md#how-it-works)
- **Birlashtirilgan modellar va profillar**: bir nechta provayderdagi bir xil model bitta yozuvga birlashadi va guruh ichida qat'iy failover ishlaydi. Nomlangan fallback-zanjir profillari (masalan, kodlash zanjiri, vision zanjiri) dashboard'dan yoki har bir so'rovda `auto:<profile>` orqali almashtiriladi. O'z zanjirlaringizni zanjir menejerida joyida qayta nomlash mumkin.
- **Har bir kalit bo'yicha limitlarni kuzatish**: har bir `(platform, model, key)` uchun RPM/RPD/TPM/TPD hisoblagichlari provayderlar xabar bergan chegaralarni o'rganib boradi, shuning uchun routing doim barcha limitlardan past turadi.
- **O'zi yangilanadigan model katalogi**: router kuniga ikki marta freellmapi.co'dan imzolangan katalogni sinxronlaydi. Yangi modellar, limit o'zgarishlari va provayderlarga oid tuzatishlar avtomatik qo'llanadi. Bepul o'rnatmalar oylik snapshotni kuzatadi: model unga jonli manbada paydo bo'lganidan 30 kun o'tib qo'shiladi. Premium routerlar uni o'sha kuniyoq oladi. [Premium →](#premium-jonli-katalog)
- **Sticky sessiyalar va kontekstni uzatish**: suhbatlar 30 daqiqa davomida bitta modelda qoladi. Suhbat o'rtasida model almashsa, ixtiyoriy qisqa uzatish eslatmasi suhbat izchilligini saqlaydi. [Batafsil →](docs/en/clients/01-agent-clients.md#context-handoff)
- **Promptni siqish (ixtiyoriy)**: umumiy, xatoda so'rovni to'xtatmaydigan (fail-open) pipeline kesh tekshiruvi va routingdan oldin promptlardagi takrorlarni olib tashlashi, tool natijalarini filtrlashi, takrorlanuvchi JSON'ni ixchamlashi va eskirgan kontekstni qisqartirishi mumkin. [Batafsil →](docs/en/compression/01-compression-pipeline.md)
- **Shifrlangan kalitlar, tashqariga bitta token**: provayder kalitlari SQLite'da AES-256-GCM bilan shifrlangan va har bir so'rovda faqat xotirada ochiladi. Ilovalaringiz faqat bitta birlashtirilgan `freellmapi-…` bearer tokenni ko'radi.
- **Admin dashboard va analitika**: kalitlarni boshqarish, zanjirni qayta tartiblash, playground'da sinash va 24 soatdan 90 kungacha bo'lgan oraliqlarda p50/p95/TTFT analitikasini ko'rish uchun React interfeysi. Login bilan himoyalangan, qorong'i va yorug' mavzular, [60 ta til](#tillar).
- **ChatGPT'ga tayyor MCP server va interaktiv hujjatlar**: ChatGPT va boshqa MCP klientlari `/mcp` orqali FreeLLMAPI inference'ini chaqirishi, foydalanish mumkin bo'lgan modellar ro'yxatini olishi, provayder holati, sarf, kesh va routing metama'lumotlarini ko'rishi hamda routing strategiyasini boshqarishi mumkin. Tashqi bog'liqliklarsiz OpenAPI ko'ruvchisi `/v1/docs` manzilida. [ChatGPT va kodlash agentlari →](docs/en/clients/01-agent-clients.md#mcp-server)
- **Operatsion qulayliklar**: ixtiyoriy javob keshi, shifrlangan ma'lumotlar bazasi zaxiralari, kalitlarning muntazam holat tekshiruvi, kalitlarni ommaviy import/eksport qilish, deklarativ ishga tushirish konfiguratsiyasi. [O'rnatish va deploy →](docs/en/install/01-install.md)
- **Node 20+ ishlaydigan har qanday joyda ishlaydi**: Windows, macOS, Linux serverlar yoki kichik ARM bir platali kompyuter (Raspberry Pi ham). PM2, systemd yoki o'zingiz yoqtirgan supervisor ostida bo'sh turganda ~40 MB RSS egallaydi.

Loyiha ataylab tor doirada. [Hali qo'llab-quvvatlanmaydigan narsalar](docs/en/architecture/00-high-level-index.md#not-yet-supported) ro'yxatiga qarang.

## Tez boshlash

**Bitta buyruq** (Docker kerak; `~/freellmapi` papkasini tayyorlaydi, shifrlash kalitini yaratadi, image'ni yuklab oladi va konteynerni ishga tushiradi):

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

bash'ga yuborishdan oldin o'qib chiqmoqchimisiz? [Skript shu yerda](https://freellmapi.co/install.sh). Uni qayta ishga tushirish xavfsiz: `.env` faylingiz (va shifrlash kaliti) saqlanib qoladi, konteyner esa `:latest` ga yangilanadi.

http://localhost:3001 ni oching, **Kalitlar** (Keys) sahifasida provayder kalitlaringizni qo'shing, **Fallback Chain** tartibini xohishingizga ko'ra o'zgartiring va **Kalitlar** sahifasining yuqori qismidan birlashtirilgan API kalitingizni oling. OpenAI SDK'ingizga aynan shu birlashtirilgan kalitni berasiz.

Windows'da eng oson yo'l: quyida tasvirlangan desktop ilovaning **[Releases'dagi `.exe` o'rnatuvchisi](https://github.com/tashfeenahmed/freellmapi/releases/latest)**. Android uchun tajriba bosqichidagi [Termux qo'llanmasiga](docs/en/install/02-android-termux.md) qarang.

Qolgan hamma narsa (Docker Compose, lokal ishlab chiqish, deklarativ ishga tushirish konfiguratsiyasi, production build'lar, LAN orqali kirish va zaxira nusxalar) **[docs/en/install/01-install.md](docs/en/install/01-install.md)** da.

## Desktop ilova

[`desktop/`](./desktop) papkasida menyu panelida ishlaydigan nativ ilova bor: butun router va dashboard trey'dan turib lokal ishlaydi, shishasimon popover esa so'rovlar statistikasini jonli ko'rsatadi.

![FreeLLMAPI desktop ilovasi](repo-assets/desktop.png)

**[Releases'dan yuklab oling](https://github.com/tashfeenahmed/freellmapi/releases/latest)**: har bir relizga macOS `.dmg` va Windows `.exe` o'rnatuvchisi biriktirilgan. Akkaunt yoki parol sozlash shart emas: sizga kerak bo'ladigan yagona maxfiy ma'lumot trey popoveridagi birlashtirilgan API kaliti. Manba koddan build qilish bosqichlari va ma'lumotlaringiz qayerda saqlanishi: [docs/en/install/01-install.md#desktop-app](docs/en/install/01-install.md#desktop-app).

macOS 12 Monterey yoki undan yangi versiyalar uchun **arm64 (Apple Silicon)** yoki **x64 (Intel)** ni tanlang. Ikkala Mac build'i ZIP ko'rinishida ham yuklab olinadi.

## OpenAI bilan mos klientlar

OpenAI bilan mos base URL'ga ulana oladigan har qanday dastur ishlaydi: uni dashboard'dagi birlashtirilgan kalit bilan `http://localhost:3001/v1` ga sozlang. Har bir generator `--dry-run` ni qo'llab-quvvatlaydi. `npx freellmapi launch` (Claude Code) va `launch-codex` (Codex) maxfiy ma'lumotlarni konfiguratsiya fayllariga umuman yozmaydi. Router bir vaqtning o'zida MCP server ham bo'lib xizmat qiladi, agentlaringiz sessiya davomida u orqali ma'lumot olishi mumkin.

**ChatGPT** xuddi shu lokal routerga xususiy Secure MCP Tunnel orqali ulanadi. `ask_freellmapi`
MCP vositasi ChatGPT so'ragan vazifani `/v1/chat/completions` orqali yo'naltiradi va javobni
xizmat ko'rsatgan model, fallback, kesh, bajarilish va token metama'lumotlari bilan qaytaradi.
Base URL va bearer autentifikatsiyasi tunnel-klient konfiguratsiyasida saqlanadi; standart model
`MCP_INFERENCE_DEFAULT_MODEL` orqali belgilanadi (berilmasa `auto`). Hech qanday kalit Git'da
yoki MCP URL'da bo'lmasligi kerak. **[ChatGPT'ni sozlash →](docs/en/clients/01-agent-clients.md#chatgpt-private-secure-mcp-tunnel)**

Provayder kalitlarini terminaldan ham boshqarish mumkin, buning uchun dashboard sessiya tokeni kerak (`FREELLMAPI_DASHBOARD_TOKEN` yoki `--token`): `npx freellmapi keys add|list|remove|test <platform>`, bunda `keys test` saqlangan kalitlarni qayta tekshiradi. [cli/README.md](cli/README.md#provider-keys) ga qarang.

FreeLLMAPI ataylab lokal va bir foydalanuvchili qilib yaratilgan. Provayder kalitlaringiz SQLite bazangizda shifrlangan holda qoladi, so'rovlar esa sizning kompyuteringizdan to'g'ridan-to'g'ri siz yoqqan provayderlarga boradi.

## Tillar

Dashboard **60 ta tilda** mavjud (desktop trey menyusi 6 ta tilda). Interfeys birinchi
ochilganda brauzer yoki tizim tilini o'zi aniqlaydi, uni istalgan vaqtda **⋯ → Sozlamalar**
(Settings) orqali almashtirishingiz mumkin; tanlovingiz eslab qolinadi. O'ngdan chapga
yoziladigan tillarda (العربية, עברית, فارسی, اردو) butun sahifa avtomatik ravishda teskari
joylashadi. Faqat faol tilning lug'ati yuklanadi, qolganlari trafigingizni sarflamaydi.

<img src="https://flagcdn.com/24x18/us.png" srcset="https://flagcdn.com/48x36/us.png 2x" width="24" height="18" alt="United States" title="United States"> <img src="https://flagcdn.com/24x18/cn.png" srcset="https://flagcdn.com/48x36/cn.png 2x" width="24" height="18" alt="China" title="China"> <img src="https://flagcdn.com/24x18/es.png" srcset="https://flagcdn.com/48x36/es.png 2x" width="24" height="18" alt="Spain" title="Spain"> <img src="https://flagcdn.com/24x18/fr.png" srcset="https://flagcdn.com/48x36/fr.png 2x" width="24" height="18" alt="France" title="France"> <img src="https://flagcdn.com/24x18/br.png" srcset="https://flagcdn.com/48x36/br.png 2x" width="24" height="18" alt="Brazil" title="Brazil"> <img src="https://flagcdn.com/24x18/it.png" srcset="https://flagcdn.com/48x36/it.png 2x" width="24" height="18" alt="Italy" title="Italy"> <img src="https://flagcdn.com/24x18/in.png" srcset="https://flagcdn.com/48x36/in.png 2x" width="24" height="18" alt="India" title="India"> <img src="https://flagcdn.com/24x18/sa.png" srcset="https://flagcdn.com/48x36/sa.png 2x" width="24" height="18" alt="Saudi Arabia" title="Saudi Arabia"> <img src="https://flagcdn.com/24x18/bd.png" srcset="https://flagcdn.com/48x36/bd.png 2x" width="24" height="18" alt="Bangladesh" title="Bangladesh"> <img src="https://flagcdn.com/24x18/ru.png" srcset="https://flagcdn.com/48x36/ru.png 2x" width="24" height="18" alt="Russia" title="Russia"> <img src="https://flagcdn.com/24x18/pk.png" srcset="https://flagcdn.com/48x36/pk.png 2x" width="24" height="18" alt="Pakistan" title="Pakistan"> <img src="https://flagcdn.com/24x18/id.png" srcset="https://flagcdn.com/48x36/id.png 2x" width="24" height="18" alt="Indonesia" title="Indonesia"> <img src="https://flagcdn.com/24x18/de.png" srcset="https://flagcdn.com/48x36/de.png 2x" width="24" height="18" alt="Germany" title="Germany"> <img src="https://flagcdn.com/24x18/jp.png" srcset="https://flagcdn.com/48x36/jp.png 2x" width="24" height="18" alt="Japan" title="Japan"> <img src="https://flagcdn.com/24x18/ke.png" srcset="https://flagcdn.com/48x36/ke.png 2x" width="24" height="18" alt="Kenya" title="Kenya"> <img src="https://flagcdn.com/24x18/tr.png" srcset="https://flagcdn.com/48x36/tr.png 2x" width="24" height="18" alt="Türkiye" title="Türkiye"> <img src="https://flagcdn.com/24x18/vn.png" srcset="https://flagcdn.com/48x36/vn.png 2x" width="24" height="18" alt="Vietnam" title="Vietnam"> <img src="https://flagcdn.com/24x18/kr.png" srcset="https://flagcdn.com/48x36/kr.png 2x" width="24" height="18" alt="South Korea" title="South Korea"> <img src="https://flagcdn.com/24x18/ir.png" srcset="https://flagcdn.com/48x36/ir.png 2x" width="24" height="18" alt="Iran" title="Iran"> <img src="https://flagcdn.com/24x18/th.png" srcset="https://flagcdn.com/48x36/th.png 2x" width="24" height="18" alt="Thailand" title="Thailand"> <img src="https://flagcdn.com/24x18/pl.png" srcset="https://flagcdn.com/48x36/pl.png 2x" width="24" height="18" alt="Poland" title="Poland"> <img src="https://flagcdn.com/24x18/ua.png" srcset="https://flagcdn.com/48x36/ua.png 2x" width="24" height="18" alt="Ukraine" title="Ukraine"> <img src="https://flagcdn.com/24x18/mm.png" srcset="https://flagcdn.com/48x36/mm.png 2x" width="24" height="18" alt="Myanmar" title="Myanmar"> <img src="https://flagcdn.com/24x18/ro.png" srcset="https://flagcdn.com/48x36/ro.png 2x" width="24" height="18" alt="Romania" title="Romania"> <img src="https://flagcdn.com/24x18/nl.png" srcset="https://flagcdn.com/48x36/nl.png 2x" width="24" height="18" alt="Netherlands" title="Netherlands"> <img src="https://flagcdn.com/24x18/my.png" srcset="https://flagcdn.com/48x36/my.png 2x" width="24" height="18" alt="Malaysia" title="Malaysia"> <img src="https://flagcdn.com/24x18/ph.png" srcset="https://flagcdn.com/48x36/ph.png 2x" width="24" height="18" alt="Philippines" title="Philippines"> <img src="https://flagcdn.com/24x18/ng.png" srcset="https://flagcdn.com/48x36/ng.png 2x" width="24" height="18" alt="Nigeria" title="Nigeria"> <img src="https://flagcdn.com/24x18/et.png" srcset="https://flagcdn.com/48x36/et.png 2x" width="24" height="18" alt="Ethiopia" title="Ethiopia"> <img src="https://flagcdn.com/24x18/uz.png" srcset="https://flagcdn.com/48x36/uz.png 2x" width="24" height="18" alt="Uzbekistan" title="Uzbekistan"> <img src="https://flagcdn.com/24x18/az.png" srcset="https://flagcdn.com/48x36/az.png 2x" width="24" height="18" alt="Azerbaijan" title="Azerbaijan"> <img src="https://flagcdn.com/24x18/lk.png" srcset="https://flagcdn.com/48x36/lk.png 2x" width="24" height="18" alt="Sri Lanka" title="Sri Lanka"> <img src="https://flagcdn.com/24x18/np.png" srcset="https://flagcdn.com/48x36/np.png 2x" width="24" height="18" alt="Nepal" title="Nepal"> <img src="https://flagcdn.com/24x18/kh.png" srcset="https://flagcdn.com/48x36/kh.png 2x" width="24" height="18" alt="Cambodia" title="Cambodia"> <img src="https://flagcdn.com/24x18/gr.png" srcset="https://flagcdn.com/48x36/gr.png 2x" width="24" height="18" alt="Greece" title="Greece"> <img src="https://flagcdn.com/24x18/cz.png" srcset="https://flagcdn.com/48x36/cz.png 2x" width="24" height="18" alt="Czechia" title="Czechia"> <img src="https://flagcdn.com/24x18/hu.png" srcset="https://flagcdn.com/48x36/hu.png 2x" width="24" height="18" alt="Hungary" title="Hungary"> <img src="https://flagcdn.com/24x18/se.png" srcset="https://flagcdn.com/48x36/se.png 2x" width="24" height="18" alt="Sweden" title="Sweden"> <img src="https://flagcdn.com/24x18/il.png" srcset="https://flagcdn.com/48x36/il.png 2x" width="24" height="18" alt="Israel" title="Israel"> <img src="https://flagcdn.com/24x18/dk.png" srcset="https://flagcdn.com/48x36/dk.png 2x" width="24" height="18" alt="Denmark" title="Denmark"> <img src="https://flagcdn.com/24x18/fi.png" srcset="https://flagcdn.com/48x36/fi.png 2x" width="24" height="18" alt="Finland" title="Finland"> <img src="https://flagcdn.com/24x18/no.png" srcset="https://flagcdn.com/48x36/no.png 2x" width="24" height="18" alt="Norway" title="Norway"> <img src="https://flagcdn.com/24x18/sk.png" srcset="https://flagcdn.com/48x36/sk.png 2x" width="24" height="18" alt="Slovakia" title="Slovakia"> <img src="https://flagcdn.com/24x18/bg.png" srcset="https://flagcdn.com/48x36/bg.png 2x" width="24" height="18" alt="Bulgaria" title="Bulgaria"> <img src="https://flagcdn.com/24x18/hr.png" srcset="https://flagcdn.com/48x36/hr.png 2x" width="24" height="18" alt="Croatia" title="Croatia"> <img src="https://flagcdn.com/24x18/rs.png" srcset="https://flagcdn.com/48x36/rs.png 2x" width="24" height="18" alt="Serbia" title="Serbia"> <img src="https://flagcdn.com/24x18/lt.png" srcset="https://flagcdn.com/48x36/lt.png 2x" width="24" height="18" alt="Lithuania" title="Lithuania"> <img src="https://flagcdn.com/24x18/tw.png" srcset="https://flagcdn.com/48x36/tw.png 2x" width="24" height="18" alt="Taiwan" title="Taiwan"> <img src="https://flagcdn.com/24x18/pt.png" srcset="https://flagcdn.com/48x36/pt.png 2x" width="24" height="18" alt="Portugal" title="Portugal"> <img src="https://flagcdn.com/24x18/ge.png" srcset="https://flagcdn.com/48x36/ge.png 2x" width="24" height="18" alt="Georgia" title="Georgia">

Lokallarning to'liq ro'yxati
[`client/src/i18n/locale-config.ts`](./client/src/i18n/locale-config.ts) faylida.

Dastlabki oltita lokal odamlar tomonidan tekshirilgan; yangilari mashina tarjimasi bo'lib, ona
tilida so'zlashuvchilar tuzatish yuborgan sari yaxshilanib boradi. Bitta satrni tuzatuvchi PR
birinchi hissa uchun ajoyib tanlov.

Tarjimalar [`client/src/i18n/locales/`](./client/src/i18n/locales) papkasida tekis JSON
fayllar ko'rinishida saqlanadi. Biror satrni tuzatish uchun tegishli lokalning JSON faylidagi
qiymatni o'zgartiring. Yangi til qo'shish uchun `en.json` dan nusxa oling, qiymatlarni tarjima
qiling va lokalni `client/src/i18n/locale-config.ts` da (trey satrlari uchun `desktop/src/i18n.ts`
da ham) ro'yxatdan o'tkazing. `npm test` har bir lokalda kalitlar va placeholderlar mosligini
tekshiradi. PR'lar mamnuniyat bilan qabul qilinadi.

## Premium (jonli katalog)

Router model katalogini o'zi yangilab turadi: kuniga ikki marta
[freellmapi.co](https://freellmapi.co) dan imzolangan katalogni tortib oladi va yangi
modellar, limit o'zgarishlari hamda provayderlarga oid tuzatishlarni lokal bazangizga
qo'llaydi. Siz o'zingiz yoqqan yoki o'chirgan modellarga va o'z provayderlaringizga hech
qachon tegilmaydi. Har bir yuklab olingan fayl qo'llanishidan oldin qat'iy belgilangan
Ed25519 kaliti bilan tekshiriladi.

Hozir katalog **34 ta provayder**, **474 ta model oilasi**, **635 ta bepul provayder/model
endpointi** (584 ta chat, 41 ta embedding, 7 ta transkripsiya, 3 ta video) va ro'yxatga
olingan bepul tariflardagi oyiga taxminan **7,4 milliard token** quvvatni kuzatadi. To'liq
ro'yxatni **[freellmapi.co/models](https://freellmapi.co/models.html)** da ko'ring.

Bepul o'rnatmalar ham xuddi shu imzolangan katalogni oladi, lekin oylik snapshotdan: model
unga jonli manbada paydo bo'lganidan 30 kun o'tib qo'shiladi, shuning uchun bepul versiya
hozir taxminan 303 ta modelga ortda turadi. Hech narsa muddati tugamaydi va hech narsa
cheklanmaydi, shunchaki kechroq yetib keladi.

Premium esa siz ishlatadigan har bir routerda bu imzolangan katalogni jonli holda saqlaydi.
Provayder kuchli bepul model chiqarsa, limitni sezdirmasdan qisqartirsa yoki API formatini
buzsa, jonli manbaga ulangan routerlar yangilanishni biz uni chiqargan kuniyoq oladi.

**[freellmapi.co'da jonli manbaga ulaning →](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_bottom#pricing)**

- Yiliga $19 yoki bir martalik $49 (umrbod). To'lov Stripe orqali; istalgan vaqtda o'zingiz bekor qila olasiz.
- Bitta `fla_` kalit siz ishlatadigan barcha routerlarni qamrab oladi: desktop, uy serveri, Raspberry Pi.
- Dashboard'dagi **Premium** bo'limida faollashtiring; obunani bekor qilish yoki to'lovlarni
  boshqarishni [freellmapi.co/manage](https://freellmapi.co/manage) da o'zingiz qilasiz.
- Routerning o'zi MIT litsenziyasi ostida qoladi va abadiy to'liq bepul. Premium faqat jonli
  manbadir va aynan u katalogni ishchi holatda ushlab turadigan kundalik model sinovlari va
  katalogga xizmat ko'rsatishni moliyalashtiradi.

Katalog serveri sizning promptlaringiz, javoblaringiz yoki provayder kalitlaringizni hech
qachon ko'rmaydi. Ikkala holatda ham router to'liq o'zingizning serveringizda ishlaydi.

## API'dan foydalanish

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # router o'zi tanlaydi; yoki "auto:fast", "auto:smart", profil yoki model id
    messages=[{"role": "user", "content": "Rim imperiyasining qulashini bir gapda tushuntirib ber."}],
)
print(resp.choices[0].message.content)
print("Routed via:", resp.headers.get("x-routed-via"))
```

Streaming, `auto:*` routing strategiyalari, tool calling, rasm kiritish (vision), Gemini'ning Google Search grounding'i, embeddinglar va Anthropic Messages endpointi haqida, har biri uchun curl va Python misollari bilan, **[docs/en/api/01-rest-api.md](docs/en/api/01-rest-api.md)** da yozilgan. Har bir javobda `X-Routed-Via: <platform>/<model>` sarlavhasi bo'ladi, shuning uchun so'rovga aslida qaysi provayder xizmat ko'rsatganini ko'rishingiz mumkin.

## Skrinshotlar

### Modellar

Routing strategiyasini tanlang va butun provayderlar to'plami bo'ylab oylik token hajmi qanday to'layotganini kuzating. Har bir model jonli ishonchlilik, tezlik va intellekt ballarini ko'rsatadi. Quyidagi tartib so'rovlar ayni damda qanday yo'naltirilayotganini bildiradi.

![Modellar sahifasi](repo-assets/models.png)

### Kalitlar

Provayder kalitlarini boshqaring va ilovalaringiz ulanadigan birlashtirilgan API kalitini oling. Har bir kalit yonida holat nuqtasi va oxirgi marta qachon tekshirilgani ko'rsatiladi.

![Kalitlar sahifasi](repo-assets/keys.png)

### Playground

Router orqali chat so'rovi yuboring va unga qaysi provayder xizmat ko'rsatganini ko'ring: model ID va kechikish vaqti xabarning o'zida ko'rsatiladi. Fayllarni tugma, sudrab tashlash yoki joylashtirish orqali biriktirishingiz mumkin: rasmlar (PNG/JPEG/WebP/GIF) brauzerda kichraytiriladi va vision qobiliyatli modelga rasm sifatida yuboriladi, matnli fayllar (TXT/MD/CSV/JSON/LOG) esa promptga kod bloklari ko'rinishida qo'shiladi.

![Playground sahifasi](repo-assets/playground.png)

### Analitika

So'rovlar soni, muvaffaqiyat darajasi, kirish va chiqish tokenlari, o'rtacha kechikish va provayderlar bo'yicha taqsimot, 24 soat / 7 kun / 30 kun / 90 kunlik oraliqlarda.

![Analitika sahifasi](repo-assets/analytics.png)

## Qanday ishlaydi

![Bitta so'rov kiradi, eng yaxshi bepul model javob beradi: jonli ballar, sovitish va limit kuzatuvi bilan fallback zanjiri](repo-assets/router-flow.png)

Bitta so'rov kiradi, eng yaxshi bepul model javob beradi: router barcha limitlardan past turgan, sog'lom kalitga ega eng yuqori ustuvorlikdagi modelni tanlaydi, kalitni xotirada ochadi va provayderni chaqiradi. 429/5xx xatosi kelsa, o'sha kalitni vaqtincha "sovitadi" va zanjirdagi keyingi modelni sinab ko'radi. Komponentlar sharhi, routingning ichki ishlashi va operatsion tafsilotlar **[docs/en/architecture/00-high-level-index.md](docs/en/architecture/00-high-level-index.md)** da.

## Ko'p beriladigan savollar

**Parol kerakmi?** Desktop ilova uchun kerak emas: dashboard yashirin lokal akkaunt bilan o'zi tizimga kiradi, shuning uchun sozlash ham, eslab qolish ham kerak emas. Uni trey belgisi → **Open Dashboard** orqali yoki o'sha kompyuterdagi istalgan brauzerda oching (masalan, http://127.0.0.1:31415); ikkala holatda ham o'zi tizimga kiradi. LAN orqali ulangan boshqa qurilmada esa kirish formasi ko'rinadi. Server o'rnatmalarida (Docker, bitta buyruqli o'rnatish, `npm run dev`) email va parolli akkaunt bo'ladi.

**Server o'rnatmasida parolni unutdim.** Kirish sahifasida **Parolni unutdingizmi?** tugmasini bosing. Havola yuboradigan email yo'q, shuning uchun bir martalik kod server logiga chiqariladi. Uni `docker compose logs -f freellmapi` bilan (yoki serverni ishga tushirgan terminalda, yoki desktop log faylida) o'qing va tiklash formasiga kiriting. Kod 15 daqiqa amal qiladi.

**Loglar qayerda?** Docker'da konteyner logida, manba koddan ishga tushirilganda terminalda, desktop ilovada esa `<data dir>/logs/freeapi.log` faylida. Unga trey menyusidagi **Open Logs Folder** orqali kirish mumkin.

**Qanday o'chiraman?** Ilovani o'chiring (macOS'da Trash'ga tashlang, Windows'da *Settings → Apps*, Docker uchun `docker compose down -v`), so'ng ma'lumotlar papkasini o'chiring: `%APPDATA%\FreeLLMAPI\`, `~/Library/Application Support/FreeLLMAPI/` yoki `~/.config/FreeLLMAPI/`. Ilovani o'chirish bu papkaga o'zi hech qachon tegmaydi.

Har bir o'rnatish usuli bo'yicha batafsil javoblar: **[docs/en/install/01-install.md#faq-passwords-logs-uninstall](docs/en/install/01-install.md#faq-passwords-logs-uninstall)**.

## Cheklovlar

Bepul tariflarni birlashtirishning o'z kamchiliklari bor: eng ilg'or (frontier) modellar yo'q, kechikish o'zgaruvchan, SLA yo'q. Bundan tashqari, kun oxiriga borib eng yaxshi modellar kunlik limitiga yetgani sari endpointning amaldagi "aqli" pasayadi, keyin UTC yarim tunida qayta tiklanadi. Jiddiy biror narsa qurishdan oldin **[docs/en/architecture/00-high-level-index.md#limitations](docs/en/architecture/00-high-level-index.md#limitations)** dagi ochiq ro'yxatni o'qing.

## Hissa qo'shish

Hissa qo'shuvchilarni juda mamnuniyat bilan kutamiz! Ishlab chiqish jarayoni, PR'larga qo'yiladigan talablar va AI/LLM yordamida yozilgan hissalar bo'yicha siyosat uchun [CONTRIBUTING.md](CONTRIBUTING.md) ga qarang (qisqasi: marhamat, lekin sifat talabi boshqa har qanday PR bilan bir xil). Birinchi PR uchun yaxshi g'oyalar:

- **Provayder qo'shish**: `server/src/providers/openai-compat.ts` ni shablon sifatida nusxalang, uni `server/src/providers/index.ts` ga ulang, modellarini `server/src/db/index.ts` da seed qiling va `server/src/__tests__/providers/` ga test qo'shing.
- **Endpoint qo'shish**: OpenAI bilan mos boshqa endpointlar (masalan, `/v1/realtime`). Provayder bazaviy klassiga yangi metodlar qo'shish mumkin; adapterlar qaysilarini qo'llab-quvvatlashini e'lon qiladi.
- **Routerni yaxshilash**: narxni hisobga oluvchi routing (eng arzon, sog'lom va tez variantlar o'rtasidagi muvozanat), kechikishni yaxshiroq hisobga oluvchi ustuvorlik, mintaqaga bog'lash.
- **Dashboard'ni sayqallash**: Analitika sahifasidagi grafiklar, kalitlarni almashtirish UX'i, `.env` dan kalitlarni ommaviy import qilish.
- **Hujjatlar**: ko'proq misollar, Go/Rust va boshqa tillar uchun klient kutubxonasi parchalari, Docker yoki Fly uchun deploy retsepti.

`npm install && npm run dev` serverni :3001 portida va dashboard'ni :5173 portida ishga tushiradi, ikkalasi ham HMR bilan. Takrorlanadigan sozlash uchun Bash'da `./scripts/dev-bootstrap.sh` yoki PowerShell'da `.\scripts\dev-bootstrap.ps1` dan foydalaning; ikkalasi ham mavjud `.env` ni saqlab qoladi. PR'larda test bo'lishi, mavjud testlar to'liq o'tishi (`npm test`) va repodagi `.editorconfig` / tsconfig sozlamalariga mos kelishi kerak. Ma'lumotlar bazasi migratsiyalari va hissa qo'shishning to'liq jarayoni [CONTRIBUTING.md](./CONTRIBUTING.md) da.

### Hissa qo'shganlar

<a href="https://github.com/moaaz12-web"><img src="https://images.weserv.nl/?url=github.com/moaaz12-web.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@moaaz12-web" /></a>
<a href="https://github.com/lukasulc"><img src="https://images.weserv.nl/?url=github.com/lukasulc.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@lukasulc" /></a>
<a href="https://github.com/VinhPhamAI"><img src="https://images.weserv.nl/?url=github.com/VinhPhamAI.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@VinhPhamAI" /></a>
<a href="https://github.com/deadc"><img src="https://images.weserv.nl/?url=github.com/deadc.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@deadc" /></a>
<a href="https://github.com/zhangyu1324"><img src="https://images.weserv.nl/?url=github.com/zhangyu1324.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@zhangyu1324" /></a>
<a href="https://github.com/kentpan"><img src="https://images.weserv.nl/?url=github.com/kentpan.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@kentpan" /></a>
<a href="https://github.com/stephenzwj"><img src="https://images.weserv.nl/?url=github.com/stephenzwj.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@stephenzwj" /></a>
<a href="https://github.com/chongjiazhen"><img src="https://images.weserv.nl/?url=github.com/chongjiazhen.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@chongjiazhen" /></a>
<a href="https://github.com/vjsai"><img src="https://images.weserv.nl/?url=github.com/vjsai.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@vjsai" /></a>
<a href="https://github.com/long2ice"><img src="https://images.weserv.nl/?url=github.com/long2ice.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@long2ice" /></a>
<a href="https://github.com/sadesguy"><img src="https://images.weserv.nl/?url=github.com/sadesguy.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@sadesguy" /></a>
<a href="https://github.com/hodlmybeer69-bit"><img src="https://images.weserv.nl/?url=github.com/hodlmybeer69-bit.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@hodlmybeer69-bit" /></a>
<a href="https://github.com/phoenixikkifullstack"><img src="https://images.weserv.nl/?url=github.com/phoenixikkifullstack.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@phoenixikkifullstack" /></a>
<a href="https://github.com/jtbrennan-git"><img src="https://images.weserv.nl/?url=github.com/jtbrennan-git.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@jtbrennan-git" /></a>
<a href="https://github.com/praveenkumarpranjal"><img src="https://images.weserv.nl/?url=github.com/praveenkumarpranjal.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@praveenkumarpranjal" /></a>
<a href="https://github.com/nordbyte"><img src="https://images.weserv.nl/?url=github.com/nordbyte.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@nordbyte" /></a>
<a href="https://github.com/mybropro"><img src="https://images.weserv.nl/?url=github.com/mybropro.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@mybropro" /></a>
<a href="https://github.com/danscMax"><img src="https://images.weserv.nl/?url=github.com/danscMax.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@danscMax" /></a>
<a href="https://github.com/jhash"><img src="https://images.weserv.nl/?url=github.com/jhash.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@jhash" /></a>
<a href="https://github.com/JammyJames1234"><img src="https://images.weserv.nl/?url=github.com/JammyJames1234.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@JammyJames1234" /></a>
<a href="https://github.com/coffcoe"><img src="https://images.weserv.nl/?url=github.com/coffcoe.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@coffcoe" /></a>
<a href="https://github.com/Sumit4codes"><img src="https://images.weserv.nl/?url=github.com/Sumit4codes.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Sumit4codes" /></a>
<a href="https://github.com/meliani"><img src="https://images.weserv.nl/?url=github.com/meliani.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@meliani" /></a>
<a href="https://github.com/thedavidweng"><img src="https://images.weserv.nl/?url=github.com/thedavidweng.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@thedavidweng" /></a>
<a href="https://github.com/bharvey42"><img src="https://images.weserv.nl/?url=github.com/bharvey42.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@bharvey42" /></a>
<a href="https://github.com/yuvrxj-afk"><img src="https://images.weserv.nl/?url=github.com/yuvrxj-afk.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@yuvrxj-afk" /></a>
<a href="https://github.com/Tushar49"><img src="https://images.weserv.nl/?url=github.com/Tushar49.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Tushar49" /></a>
<a href="https://github.com/nicyoong"><img src="https://images.weserv.nl/?url=github.com/nicyoong.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@nicyoong" /></a>
<a href="https://github.com/Aldo-f"><img src="https://images.weserv.nl/?url=github.com/Aldo-f.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Aldo-f" /></a>
<a href="https://github.com/Tazrif-Raim"><img src="https://images.weserv.nl/?url=github.com/Tazrif-Raim.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Tazrif-Raim" /></a>
<a href="https://github.com/m1nuzz"><img src="https://images.weserv.nl/?url=github.com/m1nuzz.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@m1nuzz" /></a>
<a href="https://github.com/suantea"><img src="https://images.weserv.nl/?url=github.com/suantea.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@suantea" /></a>
<a href="https://github.com/OhOkThisIsFine"><img src="https://images.weserv.nl/?url=github.com/OhOkThisIsFine.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@OhOkThisIsFine" /></a>
<a href="https://github.com/LoneRifle"><img src="https://images.weserv.nl/?url=github.com/LoneRifle.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@LoneRifle" /></a>
<a href="https://github.com/ita333"><img src="https://images.weserv.nl/?url=github.com/ita333.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ita333" /></a>
<a href="https://github.com/barbotkonv"><img src="https://images.weserv.nl/?url=github.com/barbotkonv.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@barbotkonv" /></a>
<a href="https://github.com/Naster17"><img src="https://images.weserv.nl/?url=github.com/Naster17.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Naster17" /></a>
<a href="https://github.com/StealthTensor"><img src="https://images.weserv.nl/?url=github.com/StealthTensor.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@StealthTensor" /></a>
<a href="https://github.com/EmranAhmed"><img src="https://images.weserv.nl/?url=github.com/EmranAhmed.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@EmranAhmed" /></a>
<a href="https://github.com/itsfuad"><img src="https://images.weserv.nl/?url=github.com/itsfuad.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@itsfuad" /></a>
<a href="https://github.com/RobinHoodO"><img src="https://images.weserv.nl/?url=github.com/RobinHoodO.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@RobinHoodO" /></a>
<a href="https://github.com/hmm183"><img src="https://images.weserv.nl/?url=github.com/hmm183.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@hmm183" /></a>
<a href="https://github.com/duemilionidieuro-bot"><img src="https://images.weserv.nl/?url=github.com/duemilionidieuro-bot.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@duemilionidieuro-bot" /></a>
<a href="https://github.com/cagedbird043"><img src="https://images.weserv.nl/?url=github.com/cagedbird043.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@cagedbird043" /></a>
<a href="https://github.com/jasnoorgill"><img src="https://images.weserv.nl/?url=github.com/jasnoorgill.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@jasnoorgill" /></a>
<a href="https://github.com/Joey9024"><img src="https://images.weserv.nl/?url=github.com/Joey9024.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Joey9024" /></a>
<a href="https://github.com/AskingConical"><img src="https://images.weserv.nl/?url=github.com/AskingConical.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@AskingConical" /></a>
<a href="https://github.com/ProAlit"><img src="https://images.weserv.nl/?url=github.com/ProAlit.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ProAlit" /></a>
<a href="https://github.com/hjhhoni"><img src="https://images.weserv.nl/?url=github.com/hjhhoni.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@hjhhoni" /></a>
<a href="https://github.com/immanuelsavio"><img src="https://images.weserv.nl/?url=github.com/immanuelsavio.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@immanuelsavio" /></a>
<a href="https://github.com/Slyker"><img src="https://images.weserv.nl/?url=github.com/Slyker.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Slyker" /></a>
<a href="https://github.com/wells1013"><img src="https://images.weserv.nl/?url=github.com/wells1013.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@wells1013" /></a>
<a href="https://github.com/evgkrsk"><img src="https://images.weserv.nl/?url=github.com/evgkrsk.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@evgkrsk" /></a>
<a href="https://github.com/aaronjmars"><img src="https://images.weserv.nl/?url=github.com/aaronjmars.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@aaronjmars" /></a>
<a href="https://github.com/Robs87"><img src="https://images.weserv.nl/?url=github.com/Robs87.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Robs87" /></a>
<a href="https://github.com/dashitongzhi"><img src="https://images.weserv.nl/?url=github.com/dashitongzhi.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@dashitongzhi" /></a>
<a href="https://github.com/QingJ01"><img src="https://images.weserv.nl/?url=github.com/QingJ01.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@QingJ01" /></a>
<a href="https://github.com/3215"><img src="https://images.weserv.nl/?url=github.com/3215.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@3215" /></a>
<a href="https://github.com/saifulaiub123"><img src="https://images.weserv.nl/?url=github.com/saifulaiub123.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@saifulaiub123" /></a>
<a href="https://github.com/PietFourie"><img src="https://images.weserv.nl/?url=github.com/PietFourie.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@PietFourie" /></a>
<a href="https://github.com/mhmdkrmabd"><img src="https://images.weserv.nl/?url=github.com/mhmdkrmabd.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@mhmdkrmabd" /></a>
<a href="https://github.com/DemeulemeesterxMaxime"><img src="https://images.weserv.nl/?url=github.com/DemeulemeesterxMaxime.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@DemeulemeesterxMaxime" /></a>
<a href="https://github.com/HoodBlah"><img src="https://images.weserv.nl/?url=github.com/HoodBlah.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@HoodBlah" /></a>
<a href="https://github.com/SeanPedersen"><img src="https://images.weserv.nl/?url=github.com/SeanPedersen.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@SeanPedersen" /></a>
<a href="https://github.com/andersmmg"><img src="https://images.weserv.nl/?url=github.com/andersmmg.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@andersmmg" /></a>
<a href="https://github.com/chirag127"><img src="https://images.weserv.nl/?url=github.com/chirag127.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@chirag127" /></a>
<a href="https://github.com/allababbot"><img src="https://images.weserv.nl/?url=github.com/allababbot.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@allababbot" /></a>
<a href="https://github.com/johan-droid"><img src="https://images.weserv.nl/?url=github.com/johan-droid.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@johan-droid" /></a>
<a href="https://github.com/redenfire"><img src="https://images.weserv.nl/?url=github.com/redenfire.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@redenfire" /></a>
<a href="https://github.com/itzpingcat"><img src="https://images.weserv.nl/?url=github.com/itzpingcat.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@itzpingcat" /></a>
<a href="https://github.com/kairwang01"><img src="https://images.weserv.nl/?url=github.com/kairwang01.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@kairwang01" /></a>
<a href="https://github.com/gongjurenzhangwei"><img src="https://images.weserv.nl/?url=github.com/gongjurenzhangwei.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@gongjurenzhangwei" /></a>
<a href="https://github.com/jsonring"><img src="https://images.weserv.nl/?url=github.com/jsonring.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@jsonring" /></a>
<a href="https://github.com/1029734570"><img src="https://images.weserv.nl/?url=github.com/1029734570.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@1029734570" /></a>
<a href="https://github.com/86TheCactus"><img src="https://images.weserv.nl/?url=github.com/86TheCactus.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@86TheCactus" /></a>
<a href="https://github.com/AmiroKD"><img src="https://images.weserv.nl/?url=github.com/AmiroKD.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@AmiroKD" /></a>
<a href="https://github.com/ecryptomillionaire-dev"><img src="https://images.weserv.nl/?url=github.com/ecryptomillionaire-dev.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ecryptomillionaire-dev" /></a>
<a href="https://github.com/4riful"><img src="https://images.weserv.nl/?url=github.com/4riful.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@4riful" /></a>
<a href="https://github.com/fix2015"><img src="https://images.weserv.nl/?url=github.com/fix2015.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@fix2015" /></a>
<a href="https://github.com/iisyw"><img src="https://images.weserv.nl/?url=github.com/iisyw.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@iisyw" /></a>
<a href="https://github.com/xsfhacg"><img src="https://images.weserv.nl/?url=github.com/xsfhacg.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@xsfhacg" /></a>
<a href="https://github.com/noobix"><img src="https://images.weserv.nl/?url=github.com/noobix.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@noobix" /></a>
<a href="https://github.com/nandukmelath"><img src="https://images.weserv.nl/?url=github.com/nandukmelath.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@nandukmelath" /></a>
<a href="https://github.com/NirvanaCh7"><img src="https://images.weserv.nl/?url=github.com/NirvanaCh7.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@NirvanaCh7" /></a>
<a href="https://github.com/Mohamed3nan"><img src="https://images.weserv.nl/?url=github.com/Mohamed3nan.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Mohamed3nan" /></a>
<a href="https://github.com/Arman-Espiar"><img src="https://images.weserv.nl/?url=github.com/Arman-Espiar.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Arman-Espiar" /></a>
<a href="https://github.com/MetaMysteries8"><img src="https://images.weserv.nl/?url=github.com/MetaMysteries8.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@MetaMysteries8" /></a>
<a href="https://github.com/lujun880726"><img src="https://images.weserv.nl/?url=github.com/lujun880726.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@lujun880726" /></a>
<a href="https://github.com/qq97693453"><img src="https://images.weserv.nl/?url=github.com/qq97693453.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@qq97693453" /></a>
<a href="https://github.com/emv33"><img src="https://images.weserv.nl/?url=github.com/emv33.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@emv33" /></a>
<a href="https://github.com/ousamabenyounes"><img src="https://images.weserv.nl/?url=github.com/ousamabenyounes.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ousamabenyounes" /></a>
<a href="https://github.com/yfdyh000"><img src="https://images.weserv.nl/?url=github.com/yfdyh000.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@yfdyh000" /></a>
<a href="https://github.com/s-uryansh"><img src="https://images.weserv.nl/?url=github.com/s-uryansh.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@s-uryansh" /></a>
<a href="https://github.com/arsalanyavari"><img src="https://images.weserv.nl/?url=github.com/arsalanyavari.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@arsalanyavari" /></a>
<a href="https://github.com/RoboMWM"><img src="https://images.weserv.nl/?url=github.com/RoboMWM.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@RoboMWM" /></a>
<a href="https://github.com/gaurang-py"><img src="https://images.weserv.nl/?url=github.com/gaurang-py.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@gaurang-py" /></a>
<a href="https://github.com/ddy4633"><img src="https://images.weserv.nl/?url=github.com/ddy4633.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ddy4633" /></a>
<a href="https://github.com/UrbsKali"><img src="https://images.weserv.nl/?url=github.com/UrbsKali.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@UrbsKali" /></a>
<a href="https://github.com/hb-0"><img src="https://images.weserv.nl/?url=github.com/hb-0.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@hb-0" /></a>
<a href="https://github.com/xyblue135"><img src="https://images.weserv.nl/?url=github.com/xyblue135.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@xyblue135" /></a>
<a href="https://github.com/Icesenator"><img src="https://images.weserv.nl/?url=github.com/Icesenator.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Icesenator" /></a>
<a href="https://github.com/ZER0-auto"><img src="https://images.weserv.nl/?url=github.com/ZER0-auto.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ZER0-auto" /></a>
<a href="https://github.com/tashdroid"><img src="https://images.weserv.nl/?url=github.com/tashdroid.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@tashdroid" /></a>
<a href="https://github.com/Patrickleondev"><img src="https://images.weserv.nl/?url=github.com/Patrickleondev.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Patrickleondev" /></a>
<a href="https://github.com/hiiamwaffledev"><img src="https://images.weserv.nl/?url=github.com/hiiamwaffledev.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@hiiamwaffledev" /></a>
<a href="https://github.com/w0fv1"><img src="https://images.weserv.nl/?url=github.com/w0fv1.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@w0fv1" /></a>
<a href="https://github.com/oppih"><img src="https://images.weserv.nl/?url=github.com/oppih.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@oppih" /></a>
<a href="https://github.com/n3dhir"><img src="https://images.weserv.nl/?url=github.com/n3dhir.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@n3dhir" /></a>
<a href="https://github.com/ksp2000"><img src="https://images.weserv.nl/?url=github.com/ksp2000.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ksp2000" /></a>
<a href="https://github.com/quabynahdavis"><img src="https://images.weserv.nl/?url=github.com/quabynahdavis.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@quabynahdavis" /></a>
<a href="https://github.com/qinghuanandejiangshi"><img src="https://images.weserv.nl/?url=github.com/qinghuanandejiangshi.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@qinghuanandejiangshi" /></a>
<a href="https://github.com/qatcod"><img src="https://images.weserv.nl/?url=github.com/qatcod.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@qatcod" /></a>
<a href="https://github.com/CooperSheroy"><img src="https://images.weserv.nl/?url=github.com/CooperSheroy.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@CooperSheroy" /></a>
<a href="https://github.com/shahidbeig-a11y"><img src="https://images.weserv.nl/?url=github.com/shahidbeig-a11y.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@shahidbeig-a11y" /></a>
<a href="https://github.com/Kaban15"><img src="https://images.weserv.nl/?url=github.com/Kaban15.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Kaban15" /></a>
<a href="https://github.com/efcunha"><img src="https://images.weserv.nl/?url=github.com/efcunha.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@efcunha" /></a>
<a href="https://github.com/sukaimi"><img src="https://images.weserv.nl/?url=github.com/sukaimi.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@sukaimi" /></a>
<a href="https://github.com/rome-xi"><img src="https://images.weserv.nl/?url=github.com/rome-xi.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@rome-xi" /></a>
<a href="https://github.com/bsi-bcp"><img src="https://images.weserv.nl/?url=github.com/bsi-bcp.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@bsi-bcp" /></a>
<a href="https://github.com/rodion-gudz"><img src="https://images.weserv.nl/?url=github.com/rodion-gudz.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@rodion-gudz" /></a>
<a href="https://github.com/bjornmage"><img src="https://images.weserv.nl/?url=github.com/bjornmage.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@bjornmage" /></a>
<a href="https://github.com/kenanlabs"><img src="https://images.weserv.nl/?url=github.com/kenanlabs.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@kenanlabs" /></a>
<a href="https://github.com/xzyj50609"><img src="https://images.weserv.nl/?url=github.com/xzyj50609.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@xzyj50609" /></a>
<a href="https://github.com/Ahmedtahoon2"><img src="https://images.weserv.nl/?url=github.com/Ahmedtahoon2.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Ahmedtahoon2" /></a>
<a href="https://github.com/Inference1"><img src="https://images.weserv.nl/?url=github.com/Inference1.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Inference1" /></a>
<a href="https://github.com/yzhkali"><img src="https://images.weserv.nl/?url=github.com/yzhkali.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@yzhkali" /></a>
<a href="https://github.com/levonk"><img src="https://images.weserv.nl/?url=github.com/levonk.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@levonk" /></a>
<a href="https://github.com/tripstar6000"><img src="https://images.weserv.nl/?url=github.com/tripstar6000.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@tripstar6000" /></a>
<a href="https://github.com/alkank"><img src="https://images.weserv.nl/?url=github.com/alkank.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@alkank" /></a>
<a href="https://github.com/Yi-111-a"><img src="https://images.weserv.nl/?url=github.com/Yi-111-a.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Yi-111-a" /></a>
<a href="https://github.com/The88788"><img src="https://images.weserv.nl/?url=github.com/The88788.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@The88788" /></a>
<a href="https://github.com/ac1982"><img src="https://images.weserv.nl/?url=github.com/ac1982.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ac1982" /></a>
<a href="https://github.com/agammann"><img src="https://images.weserv.nl/?url=github.com/agammann.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@agammann" /></a>
<a href="https://github.com/Claven07"><img src="https://images.weserv.nl/?url=github.com/Claven07.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Claven07" /></a>
<a href="https://github.com/AymenJeddou"><img src="https://images.weserv.nl/?url=github.com/AymenJeddou.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@AymenJeddou" /></a>
<a href="https://github.com/Thibaultjaigu"><img src="https://images.weserv.nl/?url=github.com/Thibaultjaigu.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Thibaultjaigu" /></a>
<a href="https://github.com/silvertakana"><img src="https://images.weserv.nl/?url=github.com/silvertakana.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@silvertakana" /></a>
<a href="https://github.com/sidhunt"><img src="https://images.weserv.nl/?url=github.com/sidhunt.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@sidhunt" /></a>
<a href="https://github.com/rubicon"><img src="https://images.weserv.nl/?url=github.com/rubicon.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@rubicon" /></a>
<a href="https://github.com/JoAdo07"><img src="https://images.weserv.nl/?url=github.com/JoAdo07.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@JoAdo07" /></a>
<a href="https://github.com/igormutton"><img src="https://images.weserv.nl/?url=github.com/igormutton.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@igormutton" /></a>
<a href="https://github.com/georgeatparallel"><img src="https://images.weserv.nl/?url=github.com/georgeatparallel.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@georgeatparallel" /></a>
<a href="https://github.com/BNTiyan"><img src="https://images.weserv.nl/?url=github.com/BNTiyan.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@BNTiyan" /></a>
<a href="https://github.com/ChaosCom"><img src="https://images.weserv.nl/?url=github.com/ChaosCom.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ChaosCom" /></a>
<a href="https://github.com/Alexis12119"><img src="https://images.weserv.nl/?url=github.com/Alexis12119.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Alexis12119" /></a>
<a href="https://github.com/kevin9327"><img src="https://images.weserv.nl/?url=github.com/kevin9327.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@kevin9327" /></a>
<a href="https://github.com/ilya-bogin-keenable"><img src="https://images.weserv.nl/?url=github.com/ilya-bogin-keenable.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ilya-bogin-keenable" /></a>
<a href="https://github.com/harsHdokyc"><img src="https://images.weserv.nl/?url=github.com/harsHdokyc.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@harsHdokyc" /></a>
<a href="https://github.com/ALANDVO"><img src="https://images.weserv.nl/?url=github.com/ALANDVO.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ALANDVO" /></a>
<a href="https://github.com/HyperionBurn"><img src="https://images.weserv.nl/?url=github.com/HyperionBurn.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@HyperionBurn" /></a>
<a href="https://github.com/emirhantasli"><img src="https://images.weserv.nl/?url=github.com/emirhantasli.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@emirhantasli" /></a>
<a href="https://github.com/jayhemnani9910"><img src="https://images.weserv.nl/?url=github.com/jayhemnani9910.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@jayhemnani9910" /></a>
<a href="https://github.com/ignamiranda"><img src="https://images.weserv.nl/?url=github.com/ignamiranda.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@ignamiranda" /></a>
<a href="https://github.com/MoriDanWork"><img src="https://images.weserv.nl/?url=github.com/MoriDanWork.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@MoriDanWork" /></a>
<a href="https://github.com/suvshox-oss"><img src="https://images.weserv.nl/?url=github.com/suvshox-oss.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@suvshox-oss" /></a>
<a href="https://github.com/Swidan0"><img src="https://images.weserv.nl/?url=github.com/Swidan0.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@Swidan0" /></a>
<a href="https://github.com/w21180239"><img src="https://images.weserv.nl/?url=github.com/w21180239.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@w21180239" /></a>
<a href="https://github.com/kjgggggg"><img src="https://images.weserv.nl/?url=github.com/kjgggggg.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@kjgggggg" /></a>
<a href="https://github.com/TheoCui-Saulcy"><img src="https://images.weserv.nl/?url=github.com/TheoCui-Saulcy.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@TheoCui-Saulcy" /></a>
<a href="https://github.com/MatthewRobertDunn"><img src="https://images.weserv.nl/?url=github.com/MatthewRobertDunn.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@MatthewRobertDunn" /></a>

## Ogohlantirish

**Bu loyiha production uchun emas, shaxsiy tajriba va o'rganish uchun.** Bepul tariflar dasturchilar ular ustida prototip yasashi uchun mavjud; ular barqaror, qo'llab-quvvatlanadigan inference asosi emas va shunday deb qaralmasligi kerak. Agar FreeLLMAPI ustida jiddiy biror narsa qursangiz, uni ishga tushirishdan oldin pullik API'ga o'ting. Har bir provayder bilan munosabatlaringiz akkaunt ochganingizda qabul qilgan shartlar bilan belgilanadi. Trafik ushbu loyiha orqali proksi qilinganda ham bu shartlar amal qiladi va ularga rioya qilish sizning zimmangizda.

Har bir provayderning foydalanish shartlari shaxsiy, bir foydalanuvchili proksiga qanday qarashi 2026-yil may oyida provayderma-provayder ko'rib chiqilgan, natijalari [docs/en/architecture/00-high-level-index.md#terms-of-service-review](docs/en/architecture/00-high-level-index.md#terms-of-service-review) da.

## Litsenziya

[MIT](./LICENSE)
