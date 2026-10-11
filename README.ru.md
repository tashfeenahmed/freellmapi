<div align="center">

# FreeLLMAPI

**7,4 миллиарда токенов в месяц. 34 бесплатных LLM-провайдера. 635 бесплатных модельных эндпоинтов. Один OpenAI-совместимый API.**

Объединяйте бесплатные тарифы десятков провайдеров, а также собственные OpenAI-совместимые эндпоинты для чата, эмбеддингов, генерации изображений и работы с аудио через единый API `/v1`. Ключи хранятся в зашифрованном виде. Маршрутизатор выбирает наиболее подходящую доступную модель, при ограничении запросов переключается на другого провайдера и учитывает расход по каждому ключу, помогая соблюдать бесплатные квоты.

[![CI](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/tashfeenahmed/freellmapi?style=flat&logo=github&color=yellow)](https://github.com/tashfeenahmed/freellmapi/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
[![Docker image](https://img.shields.io/badge/ghcr.io-freellmapi-2496ED?logo=docker&logoColor=white)](https://github.com/tashfeenahmed/freellmapi/pkgs/container/freellmapi)
[![Ask DeepWiki](https://img.shields.io/badge/DeepWiki-Ask-blue)](https://deepwiki.com/tashfeenahmed/freellmapi)

**[freellmapi.co](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=repository&utm_content=readme_top)** · полный каталог: 474 семейства моделей и 635 бесплатных эндпоинтов

[English](README.md) · [简体中文](README.zh-cn.md) · **Русский**

Русский перевод может обновляться с задержкой. Самую актуальную информацию смотрите в английском [README](README.md).

<p align="center">
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/macos.svg" height="48" alt="Download for macOS"></a>
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/windows.svg" height="48" alt="Download for Windows"></a>
  <a href="docs/en/install/01-install.md#docker-compose"><img src="repo-assets/badges/docker.svg" height="48" alt="Self-host with Docker"></a>
  <a href="https://play.google.com/store/apps/details?id=co.freellmapi.app"><img src="repo-assets/badges/play-store.svg" height="48" alt="Get it on Google Play"></a>
  <a href="https://apps.apple.com/app/id6804648934"><img src="repo-assets/badges/app-store.svg" height="48" alt="Download on the App Store"></a>
</p>

![Панель FreeLLMAPI: страница моделей и месячный бюджет токенов](repo-assets/github-hero.png)


Маршрутизатор самостоятельно обновляет каталог моделей из подписанного источника. Новые бесплатные модели, изменения квот и исправления совместимости поступают без `git pull`. В бесплатной версии доступен ежемесячный снимок каталога: модель появляется в нём спустя 30 дней после публикации в оперативном каталоге. Пользователи Premium получают обновления в тот же день.
**[Подключить оперативный каталог на freellmapi.co](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_top#pricing)** ($19 в год, подписку можно отменить).

</div>

---

## Содержание

- [Зачем нужен FreeLLMAPI](#зачем-нужен-freellmapi)
- [Поддерживаемые провайдеры](#поддерживаемые-провайдеры)
- [Совместимые CLI и программирующие агенты](#совместимые-cli-и-программирующие-агенты)
- [Сравнение с альтернативами](#сравнение-с-альтернативами)
- [Возможности](#возможности)
- [Быстрый запуск](#быстрый-запуск)
- [Приложение для компьютера](#приложение-для-компьютера)
- [OpenAI-совместимые клиенты](#openai-совместимые-клиенты)
- [Языки интерфейса](#языки-интерфейса)
- [Premium и оперативный каталог](#premium-и-оперативный-каталог)
- [Использование API](#использование-api)
- [Скриншоты](#скриншоты)
- [Принцип работы](#принцип-работы)
- [Частые вопросы](#частые-вопросы)
- [Ограничения](#ограничения)
- [Как помочь проекту](#как-помочь-проекту)
- [Отказ от гарантий](#отказ-от-гарантий)

**Руководства:** [Установка и развёртывание](docs/en/install/01-install.md) · [Справочник API](docs/en/api/01-rest-api.md) · [Клиенты и агенты](docs/en/clients/01-agent-clients.md) · [Сжатие промптов](docs/en/compression/01-compression-pipeline.md) · [Архитектура](docs/en/architecture/00-high-level-index.md) · [Указатель документации](docs/en/README.md) · [Руководство для участников](CONTRIBUTING.md)

## Зачем нужен FreeLLMAPI

Крупные разработчики ИИ предлагают бесплатные тарифы: иногда это миллионы токенов в месяц и тысячи запросов в день. У каждого отдельно квота невелика, но в совокупности получается около **7,4 миллиарда токенов в месяц** для **474 семейств моделей и 635 эндпоинтов провайдеров**, от небольших быстрых моделей до более мощных.

Управлять таким количеством сервисов вручную неудобно: 34 SDK, 34 набора ограничений и столько же потенциальных точек отказа. FreeLLMAPI объединяет всё в одном OpenAI-совместимом API. Достаточно направить клиентскую библиотеку OpenAI на локальный сервер, и запросы будут распределяться между провайдерами, для которых вы добавили ключи.

Бесплатные тарифы постоянно меняются: модели появляются и исчезают, ограничения корректируются. FreeLLMAPI автоматически загружает подписанный каталог с [freellmapi.co](https://freellmapi.co), поэтому данные обновляются без `git pull`. О различиях в скорости обновления рассказывается в разделе [Premium и оперативный каталог](#premium-и-оперативный-каталог).

![Объединение бесплатных тарифов: около 7,4 млрд токенов в месяц от 34 провайдеров](repo-assets/free-tier.png)

## Поддерживаемые провайдеры

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
<td align="center"><a href="https://modelscope.cn"><b>ModelScope</b><br/>Qwen3 · DeepSeek V4 · GLM-5 (требуется привязка Aliyun CN)</a></td>
</tr>
</table>

<i>… и ещё 22 бесплатных провайдера</i>

</div>

Дополнительно можно подключить **собственного провайдера**: указать на странице **Keys** любой OpenAI-совместимый эндпоинт для чата, эмбеддингов, изображений или аудио, включая llama.cpp, LM Studio, vLLM, локальный Ollama или внешний шлюз.

Полный актуальный список моделей с ограничениями скорости, размерами контекста и бюджетами бесплатных токенов находится на **[freellmapi.co/models](https://freellmapi.co/models.html)**.

## Совместимые CLI и программирующие агенты

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

<i>… а также Continue, Goose, Qwen Code, Kilo Code, Crush, Zed, JetBrains AI, DeepSeek Harness, MiMo Code, AtomCode, OpenClaw, Hermes Agent, Pi, Reasonix и любые OpenAI-, Anthropic-, Gemini- или Ollama-совместимые клиенты</i>

</div>

Большинство агентов можно настроить одной командой. Она читает актуальный каталог, сохраняет резервную копию текущих настроек и объединяет их с новыми:

```bash
npx freellmapi setup-claude --url http://localhost:3001 --api-key <unified-key>
```

**[Все поддерживаемые агенты и команды настройки →](docs/en/clients/02-supported-agents.md)** · [Инструкции для инструментов, MCP-сервер и URL-токены →](docs/en/clients/01-agent-clients.md)

## Сравнение с альтернативами

![Сравнение возможностей с OpenRouter, LiteLLM и Portkey](repo-assets/comparison.png)

Сравнение основано на открытой документации по состоянию на июль 2026 года. Исправления приветствуются.

## Возможности

![Обзор возможностей](repo-assets/features.png)

- **Все основные эндпоинты OpenAI**: `/v1/chat/completions`, `/v1/responses` (используется Codex CLI), `/v1/completions` (автодополнение кода), `/v1/images/generations`, `/v1/videos/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/embeddings` и `/v1/models`. Поддерживаются потоковый и обычный режимы, официальные SDK и OpenAI-совместимые клиенты. [Справочник API →](docs/en/api/01-rest-api.md)
- **Anthropic Messages API**: `/v1/messages` принимает формат Anthropic и передаёт запросы тому же маршрутизатору, поэтому **Claude Code** и официальные Anthropic SDK могут работать с объединённым набором бесплатных провайдеров. [Подробности →](docs/en/api/01-rest-api.md#anthropic--claude-clients)
- **Нативные интерфейсы Gemini и Ollama**: Gemini CLI может обращаться к `/v1beta` (`generateContent`, потоковая передача, подсчёт токенов, модели). Дополнительно можно включить эмуляцию Ollama с NDJSON для чата и генерации, списком моделей, метаданными и эмбеддингами для Zed, JetBrains и других клиентов.
- **Fusion, синтез ответов нескольких моделей**: запрос к виртуальной модели `fusion` параллельно отправляется нескольким бесплатным моделям; затем модель-арбитр объединяет черновики в единый ответ. [Подробности →](docs/en/api/01-rest-api.md#fusion-multi-model-synthesis)
- **Генерация изображений, видео и речи**: соответствующие `/v1/images/generations`, `/v1/videos/generations` и `/v1/audio/speech` маршрутизируются между провайдерами с медиа-моделями. Для изображений и речи доступны и пользовательские OpenAI-совместимые эндпоинты. Задачи генерации видео приводятся к общему формату, независимо от синхронного или отложенного выполнения, с возвратом готового MP4.
- **Вызовы инструментов и структурированные ответы**: поддерживаются OpenAI-совместимые `tools`, преобразование текстовых вызовов в `tool_calls`, а также `response_format`, `seed`, `logprobs`, штрафы и другие параметры генерации с учётом возможностей провайдера.
- **Умная маршрутизация, шесть стратегий**: выбор модели на основании актуальных оценок скорости, возможностей и надёжности. При ответах 429/5xx выполняются переход к следующей модели, временная блокировка проблемного ключа и ротация ключей. [Как работает маршрутизация →](docs/en/architecture/00-high-level-index.md#how-it-works)
- **Единые модели и профили**: одинаковая модель у разных провайдеров отображается одной записью со строгим переключением внутри группы. Именованные профили цепочек (например, для кода или изображений) выбираются на панели или в запросе через `auto:<profile>`. Пользовательские цепочки можно переименовывать в менеджере.
- **Учёт ограничений каждого ключа**: счётчики RPM/RPD/TPM/TPD для сочетаний `(platform, model, key)` учитывают опубликованные провайдером лимиты, чтобы маршрутизация соблюдала квоты.
- **Автообновляемый каталог моделей**: маршрутизатор дважды в день синхронизирует подписанный каталог freellmapi.co с новыми моделями, изменениями квот и исправлениями совместимости. Бесплатные установки используют ежемесячный снимок с задержкой 30 дней, Premium получает изменения в день публикации. [Premium →](#premium-и-оперативный-каталог)
- **Закрепление сессии и передача контекста**: диалог остаётся на одной модели в течение 30 минут. При переключении в ходе разговора можно передавать краткую сводку для сохранения контекста. [Подробности →](docs/en/clients/01-agent-clients.md#context-handoff)
- **Необязательное сжатие промптов**: общий отказоустойчивый конвейер может удалять повторы, фильтровать вывод инструментов, уплотнять повторяющийся JSON и обрезать устаревший контекст до проверки кеша и маршрутизации. [Подробности →](docs/en/compression/01-compression-pipeline.md)
- **Шифрование ключей и один токен для клиента**: ключи провайдеров хранятся в SQLite с шифрованием AES-256-GCM и расшифровываются в памяти во время запроса. Приложению передаётся только единый Bearer-токен `freellmapi-…`.
- **Панель управления и аналитика**: интерфейс React позволяет управлять ключами, менять порядок резервной цепочки, тестировать модели в Playground, смотреть статистику p50/p95/TTFT за периоды от 24 часов до 90 дней; есть авторизация, светлая и тёмная темы и [60 языков](#языки-интерфейса).
- **MCP-сервер для ChatGPT и интерактивная документация**: ChatGPT и другие MCP-клиенты могут отправлять запросы к FreeLLMAPI, получать список моделей, сведения о состоянии провайдеров, использовании, кеше и маршрутизации, а также управлять стратегией через `/mcp`. Просмотрщик OpenAPI доступен по `/v1/docs`. [ChatGPT и программирующие агенты →](docs/en/clients/01-agent-clients.md#mcp-server)
- **Дополнительные средства эксплуатации**: необязательный кеш ответов, зашифрованные резервные копии БД, регулярная проверка ключей, массовый импорт/экспорт, конфигурация запуска. [Установка и развёртывание →](docs/en/install/01-install.md)
- **Работает везде, где доступен Node.js 20+**: Windows, macOS, Linux-серверы и одноплатные ARM-компьютеры, включая Raspberry Pi. Потребление оперативной памяти в простое около 40 МБ RSS при использовании PM2, systemd или другого менеджера процессов.

Функциональность проекта намеренно ограничена определёнными задачами. См. [список того, что пока не поддерживается](docs/en/architecture/00-high-level-index.md#not-yet-supported).

## Быстрый запуск

**Установка одной командой** (требуется Docker): создаёт `~/freellmapi`, генерирует ключ шифрования, загружает образ и запускает контейнер.

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

Не хотите выполнять удалённый скрипт без предварительного просмотра? [Посмотрите его исходный код](https://freellmapi.co/install.sh). Повторный запуск безопасен: существующие `.env` и ключ шифрования сохраняются, а контейнер обновляется до `:latest`.

Откройте http://localhost:3001, добавьте ключи провайдеров на странице **Keys**, настройте порядок **Fallback Chain** и скопируйте единый API-ключ из заголовка страницы **Keys**. Именно его следует указывать в OpenAI SDK.

Для Windows проще всего скачать **[установщик `.exe` из Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest)**. Для Android существует экспериментальное [руководство по Termux](docs/en/install/02-android-termux.md).

Другие варианты, включая Docker Compose, локальную разработку, конфигурацию запуска, production-сборки, сетевой доступ и резервное копирование, описаны в **[руководстве по установке](docs/en/install/01-install.md)**.

## Приложение для компьютера

Нативное приложение расположено в [`desktop/`](./desktop): маршрутизатор и панель управления запускаются локально, а в системном трее доступно всплывающее окно со статистикой запросов.

![Настольное приложение FreeLLMAPI](repo-assets/desktop.png)

**[Скачать из Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest)**. К каждому выпуску прикладываются `.dmg` для macOS и `.exe` для Windows. Регистрация и отдельный пароль не требуются: необходим только единый API-ключ, доступный во всплывающем окне трея. Сборка из исходников и пути хранения данных: [docs/en/install/01-install.md#desktop-app](docs/en/install/01-install.md#desktop-app).

Для macOS 12 Monterey и новее выберите **arm64 (Apple Silicon)** или **x64 (Intel)**. Обе версии для Mac также доступны в ZIP.

## OpenAI-совместимые клиенты

Поддерживается любой клиент, которому можно задать OpenAI-совместимый базовый URL: укажите `http://localhost:3001/v1` и единый ключ с панели управления. Все генераторы конфигураций поддерживают `--dry-run`. Команды `npx freellmapi launch` (Claude Code) и `launch-codex` (Codex) позволяют не сохранять учётные данные в конфигурационных файлах. Маршрутизатор также работает как MCP-сервер, который агенты могут опрашивать во время сессии.

**ChatGPT** подключается к тому же локальному маршрутизатору через приватный Secure MCP Tunnel. MCP-инструмент `ask_freellmapi` отправляет задачу ChatGPT через `/v1/chat/completions` и возвращает ответ с метаданными обслужившей модели, резервной маршрутизации, кеша, выполнения и токенов. Базовый URL и Bearer-аутентификация задаются в настройках клиента туннеля. Модель по умолчанию настраивается через `MCP_INFERENCE_DEFAULT_MODEL` (при отсутствии значения используется `auto`). Нельзя размещать ключ в Git или URL MCP. **[Настройка ChatGPT →](docs/en/clients/01-agent-clients.md#chatgpt-private-secure-mcp-tunnel)**

Ключами провайдеров можно управлять и из терминала с токеном сессии панели (`FREELLMAPI_DASHBOARD_TOKEN` или `--token`): `npx freellmapi keys add|list|remove|test <platform>`. Команда `keys test` повторно проверяет сохранённые ключи. См. [cli/README.md](cli/README.md#provider-keys).

FreeLLMAPI рассчитан прежде всего на локальное использование одним пользователем. Ключи провайдеров остаются в вашей SQLite-базе, зашифрованы на диске, а запросы отправляются с вашего компьютера непосредственно выбранным внешним сервисам.

## Языки интерфейса

Панель управления поддерживает **60 языков**, меню приложения в трее доступно на шести. При первом запуске язык определяется по настройкам системы или браузера, затем его можно изменить в **⋯ → Settings**. Выбор сохраняется. Для языков с письмом справа налево (العربية, עברית, فارسی, اردو) интерфейс автоматически меняет направление. Загружается только словарь активного языка, остальные не расходуют трафик.

Полный список языков находится в [`client/src/i18n/locale-config.ts`](./client/src/i18n/locale-config.ts).

Первые шесть переводов прошли проверку людьми. Новые локализации были созданы машинным переводом и постепенно улучшаются благодаря исправлениям носителей языка. Даже PR с исправлением одной строки будет полезен.

Файлы переводов находятся в [`client/src/i18n/locales/`](./client/src/i18n/locales) и имеют плоскую структуру JSON. Для исправления строки измените значение соответствующего ключа в JSON своего языка. Для добавления языка скопируйте `en.json`, переведите значения и зарегистрируйте язык в `client/src/i18n/locale-config.ts` (а для строк меню трея также в `desktop/src/i18n.ts`). Команда `npm test` проверяет совпадение ключей и плейсхолдеров. PR приветствуются.

## Premium и оперативный каталог

Маршрутизатор поддерживает каталог моделей в актуальном состоянии: дважды в день скачивает подписанный каталог с [freellmapi.co](https://freellmapi.co) и обновляет локальную БД новыми моделями, изменениями квот и исправлениями особенностей провайдеров. Ваши настройки включения/отключения моделей и пользовательские провайдеры остаются нетронутыми. Каждая загрузка перед применением проверяется закреплённым ключом Ed25519.

В каталоге представлены **34 провайдера**, **474 семейства моделей**, **635 бесплатных сочетаний провайдер/модель** (584 для чата, 41 для эмбеддингов, 7 для транскрибации и 3 для видео), а заявленная общая бесплатная ёмкость составляет примерно **7,4 миллиарда токенов в месяц**. Полный список: **[freellmapi.co/models](https://freellmapi.co/models.html)**.

Бесплатные установки получают тот же подписанный каталог, но из ежемесячного снимка. Новая модель появляется там спустя 30 дней после оперативного каталога, поэтому бесплатная версия сейчас отстаёт примерно на 303 модели. Ничего не отключается и не истекает: обновления просто приходят позже.

Premium поддерживает оперативный каталог на всех ваших маршрутизаторах. Когда провайдер запускает бесплатную мощную модель, незаметно снижает квоту или меняет формат API, пользователи оперативного каталога получают соответствующее обновление в тот же день, когда оно выпущено.

**[Подключить оперативный каталог на freellmapi.co →](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_bottom#pricing)**

- $19 в год либо однократный платёж $49 за бессрочный доступ. Оплата через Stripe; подписку можно самостоятельно отменить в любой момент.
- Один ключ `fla_` действует для всех ваших экземпляров маршрутизатора: на компьютере, домашнем сервере или Raspberry Pi.
- Активация выполняется на панели управления в разделе **Premium**. Управление оплатой и подпиской: [freellmapi.co/manage](https://freellmapi.co/manage).
- Сам маршрутизатор распространяется под лицензией MIT и остаётся бесплатным. Premium оплачивает только доступ к оперативному каталогу, финансируя ежедневные проверки моделей и сопровождение каталога.

Сервер каталога не получает ваши промпты, ответы моделей или ключи провайдеров. Маршрутизатор в любом случае остаётся размещённым на вашем оборудовании.

## Использование API

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

Потоковая передача, стратегии `auto:*`, вызовы инструментов, входные изображения (Vision), подтверждение ответов Google Search в Gemini, эмбеддинги и Anthropic Messages API с примерами curl и Python описаны в **[справочнике API](docs/en/api/01-rest-api.md)**. Каждый ответ содержит заголовок `X-Routed-Via: <platform>/<model>`, показывающий, какой провайдер фактически обработал запрос.

## Скриншоты

### Модели

Выберите стратегию маршрутизации и наблюдайте, как используется общий месячный бюджет токенов у всех провайдеров. Для каждой модели показаны актуальные показатели надёжности, скорости и качества. Порядок моделей соответствует текущему порядку обработки запросов.

![Страница моделей](repo-assets/models.png)

### Ключи

Управляйте учётными данными провайдеров и получайте единый API-ключ для своих приложений. Для каждого ключа отображаются состояние и время последней проверки.

![Страница ключей](repo-assets/keys.png)

### Playground

Отправьте запрос через маршрутизатор и посмотрите, какой провайдер ответил: в сообщении отображаются идентификатор модели и задержка. Файлы можно прикреплять кнопкой, перетаскиванием или вставкой. Изображения PNG/JPEG/WebP/GIF при необходимости уменьшаются в браузере и отправляются как части сообщения модели с поддержкой Vision. Текстовые файлы TXT/MD/CSV/JSON/LOG включаются в промпт как блоки кода.

![Страница Playground](repo-assets/playground.png)

### Аналитика

Количество запросов, доля успешных ответов, входные и выходные токены, средняя задержка и детализация по провайдерам за 24 часа, 7, 30 или 90 дней.

![Страница аналитики](repo-assets/analytics.png)

## Принцип работы

![От запроса к лучшей бесплатной модели: цепочка переключения с актуальными оценками, тайм-аутами и учётом квот](repo-assets/router-flow.png)

Один запрос поступает на вход, подходящая бесплатная модель отвечает: маршрутизатор выбирает модель с наивысшим приоритетом, действующим ключом и доступной квотой, расшифровывает ключ в памяти и вызывает API провайдера. При ошибках 429/5xx ключ временно исключается и запрос повторяется на следующей модели цепочки. Компоненты, алгоритмы маршрутизации и эксплуатационные сведения описаны в **[документации по архитектуре](docs/en/architecture/00-high-level-index.md)**.

## Частые вопросы

**Нужен ли пароль?** Для настольного приложения нет: вход в панель выполняется автоматически через скрытую локальную учётную запись. Откройте панель через значок в трее → **Open Dashboard**. В серверных установках (Docker, установка одной командой, `npm run dev`) используется учётная запись с адресом электронной почты и паролем.

**Забыли пароль от серверной установки?** Нажмите **Forgot password?** на странице входа. Поскольку рассылка писем не настроена, одноразовый код печатается в журнале сервера. Его можно прочитать через `docker compose logs -f freellmapi`, в терминале работающего сервера или в журнале настольного приложения и ввести в форму сброса. Код действителен 15 минут.

**Где находятся логи?** Для Docker в журнале контейнера, при запуске из исходников в терминале, для настольной версии в `<data dir>/logs/freeapi.log`. Открыть каталог логов также можно через **Open Logs Folder** в меню трея.

**Как удалить программу?** Удалите приложение (Корзина в macOS, *Параметры → Приложения* в Windows или `docker compose down -v` для Docker), затем при необходимости удалите каталог данных: `%APPDATA%\FreeLLMAPI\`, `~/Library/Application Support/FreeLLMAPI/` либо `~/.config/FreeLLMAPI/`. Само удаление приложения не очищает эти каталоги.

Более подробные ответы для каждого способа установки: **[docs/en/install/01-install.md#faq-passwords-logs-uninstall](docs/en/install/01-install.md#faq-passwords-logs-uninstall)**.

## Ограничения

Объединение бесплатных тарифов имеет недостатки: нет гарантированного доступа к передовым моделям, задержки нестабильны, отсутствует SLA. К концу суток качество доступного набора моделей может снижаться, когда наиболее мощные варианты исчерпывают дневные лимиты; квоты восстанавливаются в полночь по UTC. Перед использованием в серьёзном проекте прочитайте [подробное описание ограничений](docs/en/architecture/00-high-level-index.md#limitations).

## Как помочь проекту

Новые участники приветствуются! В [CONTRIBUTING.md](CONTRIBUTING.md) описаны порядок разработки, требования к PR и правила для изменений с помощью ИИ/LLM. Кратко: такие изменения допускаются, но должны соответствовать тем же требованиям качества. Идеи для первого PR:

- **Добавить провайдера**: использовать `server/src/providers/openai-compat.ts` как шаблон, зарегистрировать адаптер в `server/src/providers/index.ts`, добавить модели в `server/src/db/index.ts` и тест в `server/src/__tests__/providers/`.
- **Добавить эндпоинт**: реализовать дополнительные OpenAI-совместимые интерфейсы, например `/v1/realtime`. Базовый класс провайдера может получить новые методы, адаптеры указывают поддерживаемые возможности.
- **Улучшить маршрутизатор**: учитывать цену, работоспособность и скорость моделей, совершенствовать приоритет по задержке и привязку к региону.
- **Улучшить панель управления**: графики аналитики, интерфейс ротации ключей, массовый импорт из `.env`.
- **Улучшить документацию**: примеры, фрагменты кода для Go/Rust и других языков, инструкции для Docker или Fly.

Команда `npm install && npm run dev` запускает сервер на порту :3001 и панель на :5173 с горячей перезагрузкой. Для воспроизводимой настройки используйте `./scripts/dev-bootstrap.sh` в Bash или `.\scripts\dev-bootstrap.ps1` в PowerShell. Оба скрипта сохраняют существующий `.env`. Для PR нужны тесты, успешный запуск имеющегося набора (`npm test`) и соблюдение существующих `.editorconfig` / tsconfig. Работа с миграциями БД и полный процесс участия описаны в [CONTRIBUTING.md](./CONTRIBUTING.md).

### Участники

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

## Отказ от гарантий

**Проект предназначен для личных экспериментов и обучения, а не для production-систем.** Бесплатные тарифы позволяют разработчикам экспериментировать с API, но не гарантируют стабильную работу сервиса и поддержку. Если вы создаёте на основе FreeLLMAPI продукт для реальных пользователей, перед выпуском перейдите на платный API. Использование каждого внешнего провайдера регулируется условиями, принятыми вами при регистрации: проксирование через FreeLLMAPI не отменяет эти правила, и вы несёте ответственность за их соблюдение.

Вопросы соответствия личного однопользовательского прокси условиям отдельных провайдеров, рассмотренные в мае 2026 года, описаны в [проверке условий использования](docs/en/architecture/00-high-level-index.md#terms-of-service-review).

## Лицензия

[MIT](./LICENSE)
