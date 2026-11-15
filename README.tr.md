<div align="center">

# FreeLLMAPI

**Ayda 10,1 milyar token. 87 ücretsiz LLM sağlayıcısı. 1.313 ücretsiz model uç noktası. OpenAI uyumlu tek bir uç nokta.**

Onlarca sağlayıcının ücretsiz kullanım kotalarını ve özel OpenAI uyumlu sohbet, gömme (embedding), görüntü ve ses uç noktalarını tek bir `/v1` API’sinde birleştirin. Anahtarlar şifreli saklanır. Yönlendirici, her istek için kullanılabilir en iyi modeli seçer; bir sağlayıcı hız sınırına ulaştığında sıradakine geçer ve ücretsiz kotaları aşmamak için kullanımı anahtar bazında izler.

[![CI](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/tashfeenahmed/freellmapi?style=flat&logo=github&color=yellow)](https://github.com/tashfeenahmed/freellmapi/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
[![Docker image](https://img.shields.io/badge/ghcr.io-freellmapi-2496ED?logo=docker&logoColor=white)](https://github.com/tashfeenahmed/freellmapi/pkgs/container/freellmapi)
[![Ask DeepWiki](https://img.shields.io/badge/DeepWiki-Ask-blue)](https://deepwiki.com/tashfeenahmed/freellmapi)

**[freellmapi.co](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=repository&utm_content=readme_top)** · tüm kataloğa göz atın: 736 model ailesi, 1.313 ücretsiz uç nokta

[English](README.md) · **Türkçe** · [简体中文](README.zh-cn.md) · [Русский](README.ru.md) · [O'zbekcha](README.uz.md)

<p align="center">
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/macos-tr.svg" height="48" alt="macOS için indir"></a>
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/windows-tr.svg" height="48" alt="Windows için indir"></a>
  <a href="docs/en/install/01-install.md#docker-compose"><img src="repo-assets/badges/docker-tr.svg" height="48" alt="Docker ile kendi ortamınızda çalıştırın"></a>
  <a href="https://play.google.com/store/apps/details?id=co.freellmapi.app"><img src="repo-assets/badges/play-store-tr.svg" height="48" alt="Google Play’den edinin"></a>
  <a href="https://apps.apple.com/app/id6804648934"><img src="repo-assets/badges/app-store-tr.svg" height="48" alt="App Store’dan indirin"></a>
</p>

![FreeLLMAPI paneli — aylık token bütçesiyle Modeller sayfası](repo-assets/github-hero.png)

Yönlendiriciniz model kataloğunu imzalı bir akıştan kendisi günceller: yeni ücretsiz modeller, kota değişiklikleri ve uyumluluk düzeltmeleri `git pull` gerekmeden gelir. Ücretsiz kurulumlar aylık anlık görüntüyü alır; modeller canlı akışa eklendikten 30 gün sonra bu kurulumlara ulaşır. Premium yönlendiriciler ise aynı gün alır.
**[freellmapi.co ile canlı kataloğa geçin](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_top#pricing)** (yılda 19 ABD doları; istediğiniz zaman iptal edin).

</div>

---

## İçindekiler

- [Neden geliştirildi?](#why-this-exists)
- [Desteklenen sağlayıcılar](#supported-providers)
- [Uyumlu CLI’lar ve kodlama ajanları](#compatible-clis--coding-agents)
- [Diğer çözümlerle karşılaştırma](#how-it-compares)
- [Özellikler](#features)
- [Hızlı başlangıç](#quick-start)
- [Masaüstü uygulaması](#desktop-app)
- [OpenAI uyumlu istemcilerle kullanım](#works-with-openai-compatible-clients)
- [Diller](#languages)
- [Premium (canlı katalog)](#premium-live-catalog)
- [API kullanımı](#using-the-api)
- [Ekran görüntüleri](#screenshots)
- [Nasıl çalışır?](#how-it-works)
- [Sık sorulan sorular](#faq)
- [Sınırlamalar](#limitations)
- [Katkıda bulunma](#contributing)
- [Sorumluluk reddi](#disclaimer)

**Rehberler:** [Kurulum ve dağıtım](docs/en/install/01-install.md) · [API başvurusu](docs/en/api/01-rest-api.md) · [İstemciler ve kodlama ajanları](docs/en/clients/01-agent-clients.md) · [İstem sıkıştırma](docs/en/compression/01-compression-pipeline.md) · [Mimari ve iç işleyiş](docs/en/architecture/00-high-level-index.md) · [Belge dizini](docs/en/README.md) · [Katkı rehberi](CONTRIBUTING.md)

<a id="why-this-exists"></a>

## Neden geliştirildi?

Günümüzde önde gelen yapay zekâ laboratuvarları ayda birkaç milyon token, günde birkaç bin istek sunan ücretsiz planlar sağlıyor. Tek başlarına sınırlı olsalar da bir araya geldiklerinde, küçük ve hızlı modellerden oldukça yetenekli modellere kadar **736 model ailesi / 1.313 sağlayıcı uç noktası** üzerinden **ayda yaklaşık 10,1 milyar token** çıkarım kapasitesine ulaşıyorlar.

Bunları elle birleştirmek zahmetli: seksen yedi farklı SDK, seksen yedi farklı hız sınırı ve bir isteğin başarısız olabileceği seksen yedi ayrı yer. FreeLLMAPI hepsini OpenAI uyumlu tek bir uç noktada toplar. Herhangi bir OpenAI istemci kitaplığını yerel sunucunuza yönlendirin; istekler, anahtar eklediğiniz sağlayıcılar arasında istemciye yansımadan yönlendirilir.

Ücretsiz planlar da her hafta değişiyor: sağlayıcılar yeni modeller çıkarıyor, eskilerini kaldırıyor ve kotaları haber vermeden değiştiriyor. FreeLLMAPI bunları sizin için takip eder. Yönlendirici, imzalı model kataloğunu [freellmapi.co](https://freellmapi.co) üzerinden kendisi alır; kurulumunuz `git pull` gerekmeden güncel kalır. Güncellemelerin ne kadar hızlı geldiği için [Premium (canlı katalog)](#premium-live-catalog) bölümüne bakın.

![Ücretsiz planlar bir arada — 87 sağlayıcıdan ayda yaklaşık 10,1 milyar token](repo-assets/i18n/tr/free-tier.png)

<a id="supported-providers"></a>

## Desteklenen sağlayıcılar

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
<td align="center"><a href="https://modelscope.cn"><b>ModelScope</b><br/>Qwen3 · DeepSeek V4 · GLM-5 (Aliyun cn hesabıyla bağlantı gerekir)</a></td>
</tr>
</table>

<i>… ve 75 ücretsiz sağlayıcı daha</i>

</div>

Ayrıca **özel** sağlayıcı desteği vardır: Anahtarlar (Keys) sayfasından sohbet, gömme, görüntü veya ses modellerini herhangi bir OpenAI uyumlu uç noktaya yönlendirin (llama.cpp, LM Studio, vLLM, yerel Ollama veya uzak bir ağ geçidi).

Model bazında hız sınırları, bağlam pencereleri ve ücretsiz token bütçelerini içeren tam ve güncel liste **[freellmapi.co/models](https://freellmapi.co/models.html)** adresindedir.

<a id="compatible-clis--coding-agents"></a>

## Uyumlu CLI’lar ve kodlama ajanları

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

<i>… ayrıca Continue, Goose, Qwen Code, Kilo Code, Crush, Zed, JetBrains AI, DeepSeek Harness, MiMo Code, AtomCode, OpenClaw, Hermes Agent, Pi, Reasonix, ZCode ve OpenAI uyumlu, Anthropic, Gemini veya Ollama istemcileri</i>

</div>

Çoğu ajan, canlı kataloğunuzu okuyup mevcut yapılandırmayı yedekleyen ve yeni ayarları onunla birleştiren tek bir komutla yapılandırılabilir:

```bash
npx freellmapi setup-claude --url http://localhost:3001 --api-key <unified-key>
```

**[Desteklenen tüm ajanlar ve kurulum komutları →](docs/en/clients/02-supported-agents.md)** · [Araçlara özel ayarlar, MCP sunucusu ve URL tokenları →](docs/en/clients/01-agent-clients.md)

<a id="how-it-compares"></a>

## Diğer çözümlerle karşılaştırma

![OpenRouter, LiteLLM ve Portkey ile özellik karşılaştırması](repo-assets/i18n/tr/comparison.png)

Temmuz 2026 tarihli herkese açık belgelere dayanır; düzeltmelerinizi bekliyoruz.

<a id="features"></a>

## Özellikler

![Özelliklere genel bakış](repo-assets/i18n/tr/features.png)

- **OpenAI tarzındaki tüm uç noktalar** — `/v1/chat/completions`, `/v1/responses` (Codex CLI için), `/v1/completions` (editörde satır içi otomatik tamamlama), `/v1/images/generations`, `/v1/videos/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/embeddings` ve `/v1/models`. Resmî SDK’larla veya OpenAI uyumlu istemcilerle akışlı ve akışsız çalışır. [API başvurusu →](docs/en/api/01-rest-api.md)
- **Anthropic Messages API** — `/v1/messages`, aynı yönlendirici üzerinden Anthropic iletişim biçimini kullanır. Böylece **Claude Code** ve resmî Anthropic SDK’ları ücretsiz model havuzunuzla çalışır. [Ayrıntılar →](docs/en/api/01-rest-api.md#anthropic--claude-clients)
- **Yerel Gemini ve Ollama arayüzleri** — Gemini CLI, `/v1beta` üzerinden `generateContent`, akış, token sayımı ve model listesini kullanabilir. İsteğe bağlı Ollama öykünmesi; Zed, JetBrains ve diğer yerel model istemcilerine NDJSON sohbet/üretim, etiket, üst veri ve gömme desteği sunar.
- **Fusion (çok modelli sentez)** — sanal `fusion` modelini istediğinizde yönlendirici, isteminizi farklı ücretsiz modellere paralel gönderir. Ardından bir değerlendirme modeli taslaklardan tek bir yanıt oluşturur. [Ayrıntılar →](docs/en/api/01-rest-api.md#fusion-multi-model-synthesis)
- **Görüntü, video ve konuşma üretimi** — `/v1/images/generations`, `/v1/videos/generations` ve `/v1/audio/speech`, ilgili medya modellerini sunan sağlayıcılara yönlendirilir. Görüntü ve konuşma için özel OpenAI uyumlu medya uç noktaları da kullanılabilir. Eşzamanlı ve kuyruklu sağlayıcıların video işleri ortak bir biçime dönüştürülür ve tamamlanmış MP4 döndürülür.
- **Araç çağırma ve yapılandırılmış çıktılar** — OpenAI tarzı `tools` çağrıları sağlayıcılar arasında aktarılır; düz metin olarak gelen araç çağrıları gerçek `tool_calls` nesnelerine dönüştürülür. `response_format`, `seed`, `logprobs`, cezalar ve diğer örnekleme parametreleri sağlayıcı bazında iletilir.
- **Akıllı yönlendirme, altı strateji** — modellerin canlı hız, yetenek ve güvenilirlik puanları zincirinizi sıralar. Otomatik yedek modele geçiş, 429/5xx hatalarında bekleme süreleri ve anahtar döndürmeyle sıradaki modeli dener. [Yönlendirme ayrıntıları →](docs/en/architecture/00-high-level-index.md#how-it-works)
- **Birleştirilmiş modeller ve profiller** — birden çok sağlayıcıdaki aynı model tek girdide toplanır; hata durumunda geçiş kesin olarak bu grup içinde yapılır. Adlandırılmış yedek zincir profilleri (kodlama veya görsel işleme zinciri gibi) panelden ya da istek başına `auto:<profile>` ile seçilebilir. Özel zincirler zincir yöneticisinden yeniden adlandırılabilir.
- **Anahtar bazında hız sınırı takibi** — her `(platform, model, key)` için RPM/RPD/TPM/TPD sayaçları, sağlayıcının bildirdiği üst sınırları öğrenerek yönlendirmenin kotaları aşmasını önler.
- **Kendini güncelleyen model kataloğu** — yönlendirici, freellmapi.co üzerinden imzalı kataloğu günde iki kez eşitler. Yeni modeller, kota değişiklikleri ve sağlayıcı uyumluluk düzeltmeleri otomatik gelir. Ücretsiz kurulumlar, modellerin canlı akışa katıldıktan 30 gün sonra eklendiği aylık görüntüyü izler; Premium aynı gün alır. [Premium →](#premium-live-catalog)
- **Modele bağlı oturumlar ve bağlam aktarımı** — konuşmalar 30 dakika boyunca aynı modelde kalır. Sohbet sırasında model değişirse isteğe bağlı kısa bir aktarım notu konuşmanın tutarlılığını korur. [Ayrıntılar →](docs/en/clients/01-agent-clients.md#context-handoff)
- **İstem sıkıştırma (isteğe bağlı)** — hata durumunda isteği engellemeden sürdüren ortak işlem hattı; önbellek araması ve yönlendirmeden önce yinelenen istemleri kaldırabilir, araç çıktısını filtreleyebilir, tekrarlanan JSON’u sıkıştırabilir ve eski bağlamı kısaltabilir. [Ayrıntılar →](docs/en/compression/01-compression-pipeline.md)
- **Şifreli anahtarlar, tek erişim tokenı** — sağlayıcı anahtarları SQLite içinde AES-256-GCM ile şifrelenir, her istek için bellekte çözülür. Uygulamalarınız yalnızca tek bir birleşik `freellmapi-…` bearer tokenı görür.
- **Yönetim paneli ve analizler** — anahtar yönetimi, zincir sıralaması, deneme alanı ve 24 saat–90 günlük dönemlerde p50/p95/TTFT analizleri için React arayüzü. Oturum açma koruması, açık/koyu temalar ve [60 dil](#languages).
- **ChatGPT uyumlu MCP sunucusu ve etkileşimli belgeler** — ChatGPT ve diğer MCP istemcileri FreeLLMAPI ile çıkarım yapabilir, kullanılabilir modelleri listeleyebilir, sağlayıcı sağlığı/kullanım/önbellek/yönlendirme üst verilerini inceleyebilir ve `/mcp` üzerinden stratejiyi yönetebilir. Bağımlılık gerektirmeyen OpenAPI görüntüleyicisi `/v1/docs` adresindedir. [ChatGPT ve kodlama ajanları →](docs/en/clients/01-agent-clients.md#mcp-server)
- **İşletimi kolaylaştıran özellikler** — isteğe bağlı yanıt önbelleği, şifreli veritabanı yedekleri, düzenli anahtar sağlık kontrolleri, toplu anahtar içe/dışa aktarımı ve bildirimsel başlangıç yapılandırması. [Kurulum ve dağıtım →](docs/en/install/01-install.md)
- **Node 20+ çalışan her yerde çalışır** — Windows, macOS, Linux sunucuları veya Raspberry Pi dâhil küçük ARM tek kart bilgisayarlar. PM2, systemd ya da tercih ettiğiniz süreç yöneticisiyle boşta yaklaşık 40 MB RSS bellek kullanımı.

Kapsam bilinçli olarak dar tutulmuştur; [henüz desteklenmeyen özelliklere](docs/en/architecture/00-high-level-index.md#not-yet-supported) bakın.

<a id="quick-start"></a>

## Hızlı başlangıç

**Tek satırda kurulum** (Docker gerekir; `~/freellmapi` dizinini hazırlar, şifreleme anahtarı oluşturur, imajı indirir ve konteyneri başlatır):

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

Bash’e aktarmadan önce okumak ister misiniz? [Betik burada](https://freellmapi.co/install.sh). Yeniden çalıştırmak güvenlidir: `.env` dosyanız ve şifreleme anahtarınız korunur, konteyner `:latest` sürümüne güncellenir.

http://localhost:3001 adresini açın, **Anahtarlar (Keys)** sayfasına sağlayıcı anahtarlarınızı ekleyin, **Yedek Model Zinciri (Fallback Chain)** sırasını istediğiniz gibi düzenleyin ve **Anahtarlar** sayfasının üst kısmından birleşik API anahtarınızı alın. OpenAI SDK’nızda bu birleşik anahtarı kullanın.

Windows’ta en kolay yol, aşağıda açıklanan **[Releases bölümündeki `.exe` masaüstü yükleyicisidir](https://github.com/tashfeenahmed/freellmapi/releases/latest)**. Android için deneysel [Termux rehberine](docs/en/install/02-android-termux.md) bakın.

Docker Compose, yerel geliştirme, bildirimsel başlangıç yapılandırması, üretim derlemeleri, yerel ağ erişimi ve yedeklemeler için **[kurulum rehberine](docs/en/install/01-install.md)** bakın.

<a id="desktop-app"></a>

## Masaüstü uygulaması

[`desktop/`](./desktop) dizinindeki yerel menü çubuğu uygulaması, yönlendiriciyi ve yönetim panelini sistem tepsisinden çalıştırır; cam görünümlü açılır panelde canlı istek istatistiklerini gösterir.

![FreeLLMAPI masaüstü uygulaması](repo-assets/desktop.png)

**[Releases bölümünden indirin](https://github.com/tashfeenahmed/freellmapi/releases/latest)** — her sürüme macOS `.dmg` ve Windows `.exe` yükleyicileri eklenir. Hesap veya parola oluşturmanız gerekmez; ihtiyacınız olan tek kimlik bilgisi tepsi panelindeki birleşik API anahtarıdır. Kaynaktan derleme adımları ve veri konumları: [masaüstü uygulaması rehberi](docs/en/install/01-install.md#desktop-app).

macOS 12 Monterey ve sonrası için **arm64 (Apple Silicon)** veya **x64 (Intel)** sürümünü seçin. Her iki Mac derlemesinin ZIP paketi de sunulur.

<a id="works-with-openai-compatible-clients"></a>

## OpenAI uyumlu istemcilerle kullanım

OpenAI uyumlu bir temel URL’ye bağlanabilen tüm istemciler çalışır: adresi `http://localhost:3001/v1` olarak ayarlayın ve paneldeki birleşik anahtarı kullanın. Tüm yapılandırma üreticileri `--dry-run` seçeneğini destekler. `npx freellmapi launch` (Claude Code) ve `launch-codex` (Codex), kimlik bilgilerini yapılandırma dosyalarına hiç yazmaz. Yönlendirici, ajanlarınızın oturum sırasında inceleyebileceği bir MCP sunucusu olarak da çalışır.

**ChatGPT**, özel bir Secure MCP Tunnel üzerinden aynı yerel yönlendiriciye bağlanır. `ask_freellmapi` MCP aracı, ChatGPT’nin istediği görevi `/v1/chat/completions` üzerinden yönlendirir; yanıtı kullanılan model, yedek modele geçiş, önbellek, yürütme ve token üst verileriyle döndürür. Temel URL ve bearer kimlik doğrulaması tünel istemcisinin yapılandırmasında tutulur. Varsayılan model `MCP_INFERENCE_DEFAULT_MODEL` ile ayarlanır (belirtilmezse `auto`). Anahtarları Git’e veya MCP URL’sine eklemeyin. **[ChatGPT kurulumu →](docs/en/clients/01-agent-clients.md#chatgpt-private-secure-mcp-tunnel)**

Sağlayıcı anahtarlarını panel oturum tokenıyla (`FREELLMAPI_DASHBOARD_TOKEN` veya `--token`) terminalden de yönetebilirsiniz: `npx freellmapi keys add|list|remove|test <platform>`. Buradaki `keys test`, kayıtlı anahtarları yeniden sınar. Bkz. [CLI rehberi](cli/README.md#provider-keys).

FreeLLMAPI, yerelde çalışmayı esas alan ve tek kullanıcı için tasarlanmış bir uygulamadır. Sağlayıcı anahtarlarınız SQLite veritabanınızda şifreli saklanır; istekler makinenizden etkinleştirdiğiniz sağlayıcılara gider.

<a id="languages"></a>

## Diller

Yönetim paneli **60 dilde**, masaüstü tepsi menüsü ise 6 dilde sunulur. Arayüz ilk açılışta tarayıcı/sistem dilinizi otomatik algılar. Dili istediğiniz zaman **⋯ → Ayarlar (Settings)** üzerinden değiştirebilirsiniz; seçiminiz hatırlanır. Sağdan sola yazılan dillerde (العربية, עברית, فارسی, اردو) tüm yerleşim otomatik olarak tersine döner. Yalnızca etkin dilin sözlüğü yüklenir; diğerleri bant genişliğinizi kullanmaz.

<img src="https://flagcdn.com/24x18/us.png" srcset="https://flagcdn.com/48x36/us.png 2x" width="24" height="18" alt="United States" title="United States"> <img src="https://flagcdn.com/24x18/cn.png" srcset="https://flagcdn.com/48x36/cn.png 2x" width="24" height="18" alt="China" title="China"> <img src="https://flagcdn.com/24x18/es.png" srcset="https://flagcdn.com/48x36/es.png 2x" width="24" height="18" alt="Spain" title="Spain"> <img src="https://flagcdn.com/24x18/fr.png" srcset="https://flagcdn.com/48x36/fr.png 2x" width="24" height="18" alt="France" title="France"> <img src="https://flagcdn.com/24x18/br.png" srcset="https://flagcdn.com/48x36/br.png 2x" width="24" height="18" alt="Brazil" title="Brazil"> <img src="https://flagcdn.com/24x18/it.png" srcset="https://flagcdn.com/48x36/it.png 2x" width="24" height="18" alt="Italy" title="Italy"> <img src="https://flagcdn.com/24x18/in.png" srcset="https://flagcdn.com/48x36/in.png 2x" width="24" height="18" alt="India" title="India"> <img src="https://flagcdn.com/24x18/sa.png" srcset="https://flagcdn.com/48x36/sa.png 2x" width="24" height="18" alt="Saudi Arabia" title="Saudi Arabia"> <img src="https://flagcdn.com/24x18/bd.png" srcset="https://flagcdn.com/48x36/bd.png 2x" width="24" height="18" alt="Bangladesh" title="Bangladesh"> <img src="https://flagcdn.com/24x18/ru.png" srcset="https://flagcdn.com/48x36/ru.png 2x" width="24" height="18" alt="Russia" title="Russia"> <img src="https://flagcdn.com/24x18/pk.png" srcset="https://flagcdn.com/48x36/pk.png 2x" width="24" height="18" alt="Pakistan" title="Pakistan"> <img src="https://flagcdn.com/24x18/id.png" srcset="https://flagcdn.com/48x36/id.png 2x" width="24" height="18" alt="Indonesia" title="Indonesia"> <img src="https://flagcdn.com/24x18/de.png" srcset="https://flagcdn.com/48x36/de.png 2x" width="24" height="18" alt="Germany" title="Germany"> <img src="https://flagcdn.com/24x18/jp.png" srcset="https://flagcdn.com/48x36/jp.png 2x" width="24" height="18" alt="Japan" title="Japan"> <img src="https://flagcdn.com/24x18/ke.png" srcset="https://flagcdn.com/48x36/ke.png 2x" width="24" height="18" alt="Kenya" title="Kenya"> <img src="https://flagcdn.com/24x18/tr.png" srcset="https://flagcdn.com/48x36/tr.png 2x" width="24" height="18" alt="Türkiye" title="Türkiye"> <img src="https://flagcdn.com/24x18/vn.png" srcset="https://flagcdn.com/48x36/vn.png 2x" width="24" height="18" alt="Vietnam" title="Vietnam"> <img src="https://flagcdn.com/24x18/kr.png" srcset="https://flagcdn.com/48x36/kr.png 2x" width="24" height="18" alt="South Korea" title="South Korea"> <img src="https://flagcdn.com/24x18/ir.png" srcset="https://flagcdn.com/48x36/ir.png 2x" width="24" height="18" alt="Iran" title="Iran"> <img src="https://flagcdn.com/24x18/th.png" srcset="https://flagcdn.com/48x36/th.png 2x" width="24" height="18" alt="Thailand" title="Thailand"> <img src="https://flagcdn.com/24x18/pl.png" srcset="https://flagcdn.com/48x36/pl.png 2x" width="24" height="18" alt="Poland" title="Poland"> <img src="https://flagcdn.com/24x18/ua.png" srcset="https://flagcdn.com/48x36/ua.png 2x" width="24" height="18" alt="Ukraine" title="Ukraine"> <img src="https://flagcdn.com/24x18/mm.png" srcset="https://flagcdn.com/48x36/mm.png 2x" width="24" height="18" alt="Myanmar" title="Myanmar"> <img src="https://flagcdn.com/24x18/ro.png" srcset="https://flagcdn.com/48x36/ro.png 2x" width="24" height="18" alt="Romania" title="Romania"> <img src="https://flagcdn.com/24x18/nl.png" srcset="https://flagcdn.com/48x36/nl.png 2x" width="24" height="18" alt="Netherlands" title="Netherlands"> <img src="https://flagcdn.com/24x18/my.png" srcset="https://flagcdn.com/48x36/my.png 2x" width="24" height="18" alt="Malaysia" title="Malaysia"> <img src="https://flagcdn.com/24x18/ph.png" srcset="https://flagcdn.com/48x36/ph.png 2x" width="24" height="18" alt="Philippines" title="Philippines"> <img src="https://flagcdn.com/24x18/ng.png" srcset="https://flagcdn.com/48x36/ng.png 2x" width="24" height="18" alt="Nigeria" title="Nigeria"> <img src="https://flagcdn.com/24x18/et.png" srcset="https://flagcdn.com/48x36/et.png 2x" width="24" height="18" alt="Ethiopia" title="Ethiopia"> <img src="https://flagcdn.com/24x18/uz.png" srcset="https://flagcdn.com/48x36/uz.png 2x" width="24" height="18" alt="Uzbekistan" title="Uzbekistan"> <img src="https://flagcdn.com/24x18/az.png" srcset="https://flagcdn.com/48x36/az.png 2x" width="24" height="18" alt="Azerbaijan" title="Azerbaijan"> <img src="https://flagcdn.com/24x18/lk.png" srcset="https://flagcdn.com/48x36/lk.png 2x" width="24" height="18" alt="Sri Lanka" title="Sri Lanka"> <img src="https://flagcdn.com/24x18/np.png" srcset="https://flagcdn.com/48x36/np.png 2x" width="24" height="18" alt="Nepal" title="Nepal"> <img src="https://flagcdn.com/24x18/kh.png" srcset="https://flagcdn.com/48x36/kh.png 2x" width="24" height="18" alt="Cambodia" title="Cambodia"> <img src="https://flagcdn.com/24x18/gr.png" srcset="https://flagcdn.com/48x36/gr.png 2x" width="24" height="18" alt="Greece" title="Greece"> <img src="https://flagcdn.com/24x18/cz.png" srcset="https://flagcdn.com/48x36/cz.png 2x" width="24" height="18" alt="Czechia" title="Czechia"> <img src="https://flagcdn.com/24x18/hu.png" srcset="https://flagcdn.com/48x36/hu.png 2x" width="24" height="18" alt="Hungary" title="Hungary"> <img src="https://flagcdn.com/24x18/se.png" srcset="https://flagcdn.com/48x36/se.png 2x" width="24" height="18" alt="Sweden" title="Sweden"> <img src="https://flagcdn.com/24x18/il.png" srcset="https://flagcdn.com/48x36/il.png 2x" width="24" height="18" alt="Israel" title="Israel"> <img src="https://flagcdn.com/24x18/dk.png" srcset="https://flagcdn.com/48x36/dk.png 2x" width="24" height="18" alt="Denmark" title="Denmark"> <img src="https://flagcdn.com/24x18/fi.png" srcset="https://flagcdn.com/48x36/fi.png 2x" width="24" height="18" alt="Finland" title="Finland"> <img src="https://flagcdn.com/24x18/no.png" srcset="https://flagcdn.com/48x36/no.png 2x" width="24" height="18" alt="Norway" title="Norway"> <img src="https://flagcdn.com/24x18/sk.png" srcset="https://flagcdn.com/48x36/sk.png 2x" width="24" height="18" alt="Slovakia" title="Slovakia"> <img src="https://flagcdn.com/24x18/bg.png" srcset="https://flagcdn.com/48x36/bg.png 2x" width="24" height="18" alt="Bulgaria" title="Bulgaria"> <img src="https://flagcdn.com/24x18/hr.png" srcset="https://flagcdn.com/48x36/hr.png 2x" width="24" height="18" alt="Croatia" title="Croatia"> <img src="https://flagcdn.com/24x18/rs.png" srcset="https://flagcdn.com/48x36/rs.png 2x" width="24" height="18" alt="Serbia" title="Serbia"> <img src="https://flagcdn.com/24x18/lt.png" srcset="https://flagcdn.com/48x36/lt.png 2x" width="24" height="18" alt="Lithuania" title="Lithuania"> <img src="https://flagcdn.com/24x18/tw.png" srcset="https://flagcdn.com/48x36/tw.png 2x" width="24" height="18" alt="Taiwan" title="Taiwan"> <img src="https://flagcdn.com/24x18/pt.png" srcset="https://flagcdn.com/48x36/pt.png 2x" width="24" height="18" alt="Portugal" title="Portugal"> <img src="https://flagcdn.com/24x18/ge.png" srcset="https://flagcdn.com/48x36/ge.png 2x" width="24" height="18" alt="Georgia" title="Georgia">

Tam dil listesi [`client/src/i18n/locale-config.ts`](./client/src/i18n/locale-config.ts) dosyasındadır.

İlk altı dil insan denetiminden geçmiştir. Daha sonra eklenen diller makine çevirisidir ve ana dili konuşanların düzeltmeleriyle iyileşir. Tek bir metni düzelten PR bile iyi bir ilk katkıdır.

Çeviriler [`client/src/i18n/locales/`](./client/src/i18n/locales) dizininde düz JSON dosyaları olarak tutulur. Bir metni düzeltmek için ilgili dilin JSON dosyasındaki değeri düzenleyin. Yeni dil eklemek için `en.json` dosyasını kopyalayıp değerleri çevirin, dili `client/src/i18n/locale-config.ts` dosyasına kaydedin; tepsi metinleri için `desktop/src/i18n.ts` dosyasını da güncelleyin. `npm test`, her dilin anahtar ve yer tutucularının kaynakla eşleştiğini kontrol eder. PR’larınızı bekliyoruz.

<a id="premium-live-catalog"></a>

## Premium (canlı katalog)

Yönlendirici model kataloğunu kendisi güncel tutar: günde iki kez [freellmapi.co](https://freellmapi.co) üzerinden imzalı kataloğu alır, yeni modelleri, kota değişikliklerini ve sağlayıcılara özgü uyumluluk düzeltmelerini yerel veritabanınıza uygular. Etkinleştirme/devre dışı bırakma seçimleriniz ve özel sağlayıcılarınız değişmez. Her indirme uygulanmadan önce sabitlenmiş Ed25519 anahtarıyla doğrulanır.

Katalog şu anda **87 sağlayıcı**, **736 model ailesi**, **1.313 ücretsiz sağlayıcı/model uç noktası** (1.137 sohbet, 29 görsel, 41 ses, 68 gömme, 19 ses dökümü, 6 video, 13 karar) ve listelenen ücretsiz planlarda **ayda yaklaşık 10,1 milyar token** kapasitesini izler. Tam liste: **[freellmapi.co/models](https://freellmapi.co/models.html)**.

Ücretsiz kurulumlar aynı imzalı kataloğun aylık anlık görüntüsünü alır. Bir model, canlı akışa eklendikten 30 gün sonra bu görüntüye katılır; bu nedenle ücretsiz sürüm şu anda yaklaşık 303 model geridedir. Hiçbir şeyin süresi dolmaz ve hiçbir özellik kısıtlanmaz; modeller yalnızca daha geç gelir.

Premium, çalıştırdığınız tüm yönlendiricilerde imzalı kataloğu canlı tutar. Bir sağlayıcı güçlü bir ücretsiz model yayımladığında, kotasını sessizce daralttığında veya iletişim biçimini bozduğunda, canlı akışı kullanan yönlendiriciler düzeltmeyi yayımladığımız gün alır.

**[freellmapi.co ile canlı kataloğa geçin →](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_bottom#pricing)**

- Yılda 19 ABD doları veya tek seferlik 49 ABD dolarıyla ömür boyu kullanım. Stripe üzerinden ödeme; istediğiniz zaman kendiniz iptal edebilirsiniz.
- Tek bir `fla_` anahtarı çalıştırdığınız tüm yönlendiricileri kapsar: masaüstü, ev sunucusu, Raspberry Pi.
- Panelde **Premium** bölümünden etkinleştirin; iptal ve faturalandırma işlemlerini [freellmapi.co/manage](https://freellmapi.co/manage) üzerinden kendiniz yönetin.
- Yönlendirici her zaman MIT lisanslı ve tamamen ücretsiz kalır. Premium yalnızca canlı katalog akışını kapsar; kataloğun çalışır kalmasını sağlayan günlük model testlerini ve bakımını finanse eder.

Katalog sunucusu istemlerinizi, model yanıtlarınızı veya sağlayıcı anahtarlarınızı hiçbir zaman görmez. Her iki durumda da yönlendirici tamamen sizin ortamınızda çalışır.

<a id="using-the-api"></a>

## API kullanımı

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # let the router pick; or "auto:fast", "auto:smart", a profile, or a model id
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(resp.choices[0].message.content)
print("Routed via:", resp.headers.get("x-routed-via"))
```

Akışlı yanıtlar, `auto:*` yönlendirme stratejileri, araç çağırma, görsel girdiler, Gemini Google Search ile kaynaklandırma, gömmeler ve Anthropic Messages API’si için curl ve Python örnekleri **[API başvurusundadır](docs/en/api/01-rest-api.md)**. Her yanıt `X-Routed-Via: <platform>/<model>` başlığı taşır; böylece isteği hangi sağlayıcının karşıladığını görebilirsiniz.

<a id="screenshots"></a>

## Ekran görüntüleri

### Modeller

Bir yönlendirme stratejisi seçin ve tüm sağlayıcıların aylık token bütçesini izleyin. Her model için canlı güvenilirlik, hız ve yetenek puanları gösterilir. Aşağıdaki sıralama, isteklerin o anda izlediği yönlendirme sırasıdır.

![Modeller sayfası](repo-assets/models.png)

### Anahtarlar

Sağlayıcı kimlik bilgilerini yönetin ve uygulamalarınızın bağlanırken kullanacağı birleşik API anahtarını alın. Her anahtarın durum göstergesi ve son sağlık kontrolünün zamanı gösterilir.

![Anahtarlar sayfası](repo-assets/keys.png)

### Deneme alanı

Yönlendirici üzerinden bir sohbet isteği gönderin; isteği hangi sağlayıcının karşıladığını, model kimliğini ve gecikmeyi doğrudan mesaj üzerinde görün. Düğme, sürükleyip bırakma veya yapıştırmayla dosya ekleyin. Görseller (PNG/JPEG/WebP/GIF) tarayıcıda küçültülüp görsel işleyebilen bir modele görüntü içeriği olarak gönderilir. Metin dosyaları (TXT/MD/CSV/JSON/LOG) ise isteme kod blokları içinde eklenir.

![Deneme alanı sayfası](repo-assets/playground.png)

### Analiz

24 saat / 7 gün / 30 gün / 90 günlük dönemlerde istek hacmi, başarı oranı, giriş ve çıkış tokenları, ortalama gecikme ve sağlayıcı bazındaki dağılımlar.

![Analiz sayfası](repo-assets/analytics.png)

<a id="how-it-works"></a>

## Nasıl çalışır?

![Tek istek, en iyi ücretsiz model — canlı puanlar, bekleme süreleri ve kota takibiyle yedek model zinciri](repo-assets/i18n/tr/router-flow.png)

Tek istek, en iyi ücretsiz model: yönlendirici, geçerli bir anahtarı olan ve tüm hız sınırlarının altında kalan en yüksek öncelikli modeli seçer, anahtarın şifresini bellekte çözer ve sağlayıcıyı çağırır. 429/5xx hatasında bu anahtarı beklemeye alıp zincirdeki sıradaki modeli dener. Bileşenlerin açıklamaları, yönlendirmenin iç işleyişi ve işletim ayrıntıları **[mimari rehberindedir](docs/en/architecture/00-high-level-index.md)**.

<a id="faq"></a>

## Sık sorulan sorular

**Parola gerekiyor mu?** Masaüstü uygulamasında gerekmez. Panel gizli bir yerel hesapla otomatik oturum açar; oluşturmanız veya hatırlamanız gereken bir parola yoktur. Tepsi simgesi → **Paneli Aç (Open Dashboard)** yolunu kullanın ya da aynı bilgisayarda herhangi bir tarayıcıdan açın (örneğin http://127.0.0.1:31415); ikisi de otomatik giriş yapar. Yerel ağ üzerinden başka bir cihazla bağlanıldığında giriş formu gösterilir. Sunucu kurulumlarında (Docker, tek satırlık kurulum, `npm run dev`) e-posta ve parola kullanan bir hesap vardır.

**Sunucu kurulumundaki parolamı unuttum.** Giriş sayfasında **Parolamı unuttum (Forgot password?)** seçeneğine tıklayın. Bağlantı göndermek için e-posta hizmeti bulunmadığından tek kullanımlık kod sunucu günlüğüne yazılır. Kodu `docker compose logs -f freellmapi` ile, sunucunun çalıştığı terminalden veya masaüstü günlük dosyasından okuyup sıfırlama formuna girin. Kod 15 dakika geçerlidir.

**Günlükler nerede?** Docker kurulumunda konteyner günlüklerinde, kaynaktan çalıştırmada terminalde, masaüstünde ise `<data dir>/logs/freeapi.log` dosyasındadır. Masaüstünde tepsi menüsündeki **Günlük Klasörünü Aç (Open Logs Folder)** seçeneğiyle ulaşabilirsiniz.

**Nasıl kaldırırım?** Uygulamayı kaldırın (macOS’ta Çöp Sepeti, Windows’ta *Ayarlar → Uygulamalar*, Docker’da `docker compose down -v`), ardından veri dizinini silin: `%APPDATA%\FreeLLMAPI\`, `~/Library/Application Support/FreeLLMAPI/` veya `~/.config/FreeLLMAPI/`. Kaldırma işlemi bu klasörü kendiliğinden silmez.

Kurulum yöntemine göre ayrıntılı yanıtlar: **[parolalar, günlükler ve kaldırma](docs/en/install/01-install.md#faq-passwords-logs-uninstall)**.

<a id="limitations"></a>

## Sınırlamalar

Ücretsiz planları birleştirmenin bedelleri vardır: en ileri düzey modeller yoktur, gecikmeler değişkendir ve hizmet düzeyi garantisi (SLA) sunulmaz. En iyi modeller günlük kotalarına ulaştıkça uç noktanın yanıt kalitesi günün ilerleyen saatlerinde düşebilir; kotalar UTC gece yarısında sıfırlanır. Buna dayalı gerçek bir ürün geliştirmeden önce **[sınırlamalar listesini](docs/en/architecture/00-high-level-index.md#limitations)** okuyun.

<a id="contributing"></a>

## Katkıda bulunma

Katkılarınızı bekliyoruz! Geliştirme süreci, PR beklentileri ve AI/LLM destekli katkı politikası için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın. Kısaca: bu katkılar kabul edilir ve diğer PR’larla aynı kalite ölçütlerine tabidir. İlk katkı önerileri:

- **Sağlayıcı ekleyin** — `server/src/providers/openai-compat.ts` dosyasını şablon olarak kopyalayın, `server/src/providers/index.ts` içine bağlayın, modellerini `server/src/db/index.ts` içinde tanımlayın ve `server/src/__tests__/providers/` dizinine test ekleyin.
- **Uç nokta ekleyin** — diğer OpenAI uyumlu arayüzler (örneğin `/v1/realtime`). Sağlayıcı temel sınıfına yeni yöntemler eklenebilir; bağdaştırıcılar hangilerini desteklediklerini bildirir.
- **Yönlendiriciyi iyileştirin** — maliyeti gözeten yönlendirme (ucuzluk, sağlık ve hız dengesi), gecikmeye göre daha iyi önceliklendirme, belirli bir bölgeye sabitleme.
- **Paneli iyileştirin** — Analiz sayfasına grafikler, anahtar döndürme deneyimi, `.env` üzerinden toplu anahtar aktarımı.
- **Belgelere katkıda bulunun** — daha fazla örnek, Go/Rust gibi diller için istemci kodları, Docker veya Fly için dağıtım tarifleri.

`npm install && npm run dev`, sunucuyu :3001 ve paneli :5173 üzerinde HMR desteğiyle başlatır. Tekrarlanabilir kurulum için Bash’te `./scripts/dev-bootstrap.sh`, PowerShell’de `.\scripts\dev-bootstrap.ps1` kullanın; ikisi de mevcut `.env` dosyasını korur. PR’lar test içermeli, mevcut testlerin geçmesini sağlamalı (`npm test`) ve depodaki `.editorconfig` / tsconfig varsayılanlarına uymalıdır. Veritabanı geçiş iş akışı ve tüm katkı süreci [CONTRIBUTING.md](./CONTRIBUTING.md) dosyasındadır.

### Katkıda bulunanlar

<a href="https://github.com/moaaz12-web"><img src="https://images.weserv.nl/?url=github.com/moaaz12-web.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@moaaz12-web" /></a>
<a href="https://github.com/AdityaxDeore"><img src="https://images.weserv.nl/?url=github.com/AdityaxDeore.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@AdityaxDeore" /></a>
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
<a href="https://github.com/v0rtex1223"><img src="https://images.weserv.nl/?url=github.com/v0rtex1223.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@v0rtex1223" /></a>
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
<a href="https://github.com/nk-batman21"><img src="https://images.weserv.nl/?url=github.com/nk-batman21.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@nk-batman21" /></a>
<a href="https://github.com/PowerTokens"><img src="https://images.weserv.nl/?url=github.com/PowerTokens.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@PowerTokens" /></a>
<a href="https://github.com/navzo"><img src="https://images.weserv.nl/?url=github.com/navzo.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@navzo" /></a>
<a href="https://github.com/motasimfuad"><img src="https://images.weserv.nl/?url=github.com/motasimfuad.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@motasimfuad" /></a>
<a href="https://github.com/thedevil11255"><img src="https://images.weserv.nl/?url=github.com/thedevil11255.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@thedevil11255" /></a>
<a href="https://github.com/kvianAR"><img src="https://images.weserv.nl/?url=github.com/kvianAR.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@kvianAR" /></a>
<a href="https://github.com/TanmayShah29"><img src="https://images.weserv.nl/?url=github.com/TanmayShah29.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@TanmayShah29" /></a>
<a href="https://github.com/heydryft"><img src="https://images.weserv.nl/?url=github.com/heydryft.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@heydryft" /></a>
<a href="https://github.com/leucds2018-hub"><img src="https://images.weserv.nl/?url=github.com/leucds2018-hub.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@leucds2018-hub" /></a>
<a href="https://github.com/zhangkom"><img src="https://images.weserv.nl/?url=github.com/zhangkom.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@zhangkom" /></a>
<a href="https://github.com/noahkhomer18"><img src="https://images.weserv.nl/?url=github.com/noahkhomer18.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@noahkhomer18" /></a>
<a href="https://github.com/mentallyunstable-lab"><img src="https://images.weserv.nl/?url=github.com/mentallyunstable-lab.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@mentallyunstable-lab" /></a>

<a id="disclaimer"></a>

## Sorumluluk reddi

**Bu proje kişisel deneme ve öğrenme içindir; üretim ortamları için değildir.** Ücretsiz planlar geliştiricilerin prototip oluşturması için sunulur; kararlı ve destek garantisi olan bir çıkarım altyapısı değildir. FreeLLMAPI üzerine gerçek bir ürün geliştiriyorsanız yayımlamadan önce ücretli bir API’ye geçin. Sağlayıcılarla ilişkiniz, hesap oluştururken kabul ettiğiniz koşullara tabidir. Trafiği bu proje üzerinden yönlendirdiğinizde de bu koşullar geçerlidir ve bunlara uymak sizin sorumluluğunuzdadır.

Sağlayıcıların hizmet koşullarında kişisel, tek kullanıcılı bir vekil sunucunun nasıl değerlendirildiğine ilişkin Mayıs 2026 tarihli inceleme için [hizmet koşulları değerlendirmesine](docs/en/architecture/00-high-level-index.md#terms-of-service-review) bakın.

## Lisans

[MIT](./LICENSE)
