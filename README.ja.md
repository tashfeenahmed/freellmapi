<div align="center">

# FreeLLMAPI

**月間 101 億トークン。87 の無料 LLM プロバイダー。1,313 の無料モデルエンドポイント。OpenAI 互換のエンドポイントはたった 1 つ。**

数十のプロバイダーの無料枠と、カスタムの OpenAI 互換チャット・埋め込み・画像・音声エンドポイントを、単一の `/v1` API の背後にまとめます。キーは暗号化して保存されます。ルーターがリクエストごとに利用可能な最適モデルを選び、レート制限にかかったプロバイダーがあれば次のプロバイダーへフェイルオーバーし、キーごとの使用量を追跡して、すべての無料枠の上限内に収まるようにします。

[![CI](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/tashfeenahmed/freellmapi?style=flat&logo=github&color=yellow)](https://github.com/tashfeenahmed/freellmapi/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#コントリビュート)
[![Docker image](https://img.shields.io/badge/ghcr.io-freellmapi-2496ED?logo=docker&logoColor=white)](https://github.com/tashfeenahmed/freellmapi/pkgs/container/freellmapi)
[![Ask DeepWiki](https://img.shields.io/badge/DeepWiki-Ask-blue)](https://deepwiki.com/tashfeenahmed/freellmapi)

**[freellmapi.co](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=repository&utm_content=readme_top)** · 全カタログを閲覧: 736 のモデルファミリー、1,313 の無料エンドポイント

[English](README.md) · [Türkçe](README.tr.md) · [简体中文](README.zh-cn.md) · [Русский](README.ru.md) · [O'zbekcha](README.uz.md) · **日本語**

<p align="center">
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/macos.svg" height="48" alt="macOS 版をダウンロード"></a>
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/windows.svg" height="48" alt="Windows 版をダウンロード"></a>
  <a href="docs/en/install/01-install.md#docker-compose"><img src="repo-assets/badges/docker.svg" height="48" alt="Docker でセルフホスト"></a>
  <a href="https://play.google.com/store/apps/details?id=co.freellmapi.app"><img src="repo-assets/badges/play-store.svg" height="48" alt="Google Play で手に入れよう"></a>
  <a href="https://apps.apple.com/app/id6804648934"><img src="repo-assets/badges/app-store.svg" height="48" alt="App Store でダウンロード"></a>
</p>

![FreeLLMAPI ダッシュボード — 月間トークン予算を表示するモデルページ](repo-assets/github-hero.png)


ルーターは署名付きフィードから自身のモデルカタログを更新します。新しい無料モデル、クォータの変更、互換性の修正が `git pull` なしで反映されます。無料版には月次スナップショットが配信されるため、モデルはライブフィードに加わってから 30 日後に届きます。プレミアムのルーターには当日中に届きます。
**[freellmapi.co でライブ版を始める](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_top#pricing)**(年額 $19、いつでも解約可能)。

</div>

---

## 目次

- [このプロジェクトの目的](#このプロジェクトの目的)
- [対応プロバイダー](#対応プロバイダー)
- [互換性のある CLI とコーディングエージェント](#互換性のある-cli-とコーディングエージェント)
- [他サービスとの比較](#他サービスとの比較)
- [機能](#機能)
- [クイックスタート](#クイックスタート)
- [デスクトップアプリ](#デスクトップアプリ)
- [OpenAI 互換クライアントでの利用](#openai-互換クライアントでの利用)
- [対応言語](#対応言語)
- [プレミアム (ライブカタログ)](#プレミアム-ライブカタログ)
- [API の使い方](#api-の使い方)
- [スクリーンショット](#スクリーンショット)
- [仕組み](#仕組み)
- [FAQ](#faq)
- [制限事項](#制限事項)
- [コントリビュート](#コントリビュート)
- [免責事項](#免責事項)

**ガイド:** [インストールとデプロイ](docs/en/install/01-install.md) · [API リファレンス](docs/en/api/01-rest-api.md) · [クライアントとコーディングエージェント](docs/en/clients/01-agent-clients.md) · [プロンプト圧縮](docs/en/compression/01-compression-pipeline.md) · [アーキテクチャと内部構造](docs/en/architecture/00-high-level-index.md) · [ドキュメント索引](docs/en/README.md) · [コントリビューターガイド](CONTRIBUTING.md)

## このプロジェクトの目的

今や、真剣に取り組む AI ラボはどこも無料枠を提供しています。月に数百万トークン、1 日に数千リクエストです。単体ではどの無料枠もおもちゃのようなものですが、積み重ねれば、小型で高速なものから十分に高性能なものまで、**736 のモデルファミリー / 1,313 のプロバイダーエンドポイント**にわたり、月間およそ **101 億トークン**もの実用的な推論能力になります。

問題は、これらを手作業で積み重ねるのが大変だということです。87 種類の SDK、87 種類のレート制限、87 か所もの失敗しうる箇所があります。FreeLLMAPI は、それを OpenAI 互換の 1 つのエンドポイントにまとめます。任意の OpenAI クライアントライブラリをローカルサーバーに向ければ、キーを追加したプロバイダーの間でリクエストを透過的にルーティングします。

しかも無料枠の状況は毎週変わります。プロバイダーはモデルを公開し、廃止し、予告なくクォータを変更します。FreeLLMAPI はそのすべてを追跡します。ルーターは [freellmapi.co](https://freellmapi.co) から署名付きのモデルカタログを自動で取得するので、`git pull` をしなくてもインストール環境が最新に保たれます。更新の速さについては [プレミアム (ライブカタログ)](#プレミアム-ライブカタログ) をご覧ください。

![積み重ねられた無料枠 — 87 プロバイダーにまたがる月間約 101 億トークンの無料推論](repo-assets/free-tier.png)

## 対応プロバイダー

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
<td align="center"><a href="https://modelscope.cn"><b>ModelScope</b><br/>Qwen3 · DeepSeek V4 · GLM-5(Aliyun の cn アカウント連携が必要)</a></td>
</tr>
</table>

<i>… ほかにも 75 の無料プロバイダー</i>

</div>

さらに **custom** プロバイダーがあり、チャット、埋め込み、画像、音声のモデルを、任意の OpenAI 互換エンドポイント(llama.cpp、LM Studio、vLLM、ローカルの Ollama、リモートのゲートウェイ)に向けられます。設定は「キー」ページから行います。

常に最新の全リストは **[freellmapi.co/models](https://freellmapi.co/models.html)** にあり、モデルごとのレート制限、コンテキストウィンドウ、無料トークン予算が載っています。

## 互換性のある CLI とコーディングエージェント

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

<i>… ほかに Continue、Goose、Qwen Code、Kilo Code、Crush、Zed、JetBrains AI、DeepSeek Harness、MiMo Code、AtomCode、OpenClaw、Hermes Agent、Pi、Reasonix、ZCode、および OpenAI 互換・Anthropic・Gemini・Ollama のあらゆるクライアント</i>

</div>

ほとんどのエージェントは、1 つのコマンドで自動設定できます。このコマンドは稼働中のカタログを読み取り、既存の設定をバックアップしてからマージします。

```bash
npx freellmapi setup-claude --url http://localhost:3001 --api-key <unified-key>
```

**[対応エージェントの一覧とセットアップコマンド →](docs/en/clients/02-supported-agents.md)** · [ツールごとのレシピ、MCP サーバー、URL トークン →](docs/en/clients/01-agent-clients.md)

## 他サービスとの比較

![OpenRouter、LiteLLM、Portkey との機能比較](repo-assets/comparison.png)

公開ドキュメントに基づく(2026 年 7 月時点)。誤りがあればご指摘ください。

## 機能

![機能の概要](repo-assets/features.png)

- **OpenAI 形式のあらゆるインターフェース** — `/v1/chat/completions`、`/v1/responses`(Codex CLI に必要)、`/v1/completions`(エディターのゴーストテキスト補完)、`/v1/images/generations`、`/v1/videos/generations`、`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/embeddings`、`/v1/models` に対応し、ストリーミング・非ストリーミングのどちらも、公式 SDK や任意の OpenAI 互換クライアントから利用できます。[API リファレンス →](docs/en/api/01-rest-api.md)
- **Anthropic Messages API** — `/v1/messages` は同じルーター上で Anthropic のワイヤーフォーマットを話すため、**Claude Code** や公式の Anthropic SDK が無料プールに対して動作します。[詳細 →](docs/en/api/01-rest-api.md#anthropic--claude-clients)
- **ネイティブの Gemini と Ollama のインターフェース** — Gemini CLI は `/v1beta`(`generateContent`、ストリーミング、トークン数の計算、モデル一覧)を使え、オプトインの Ollama エミュレーションは、Zed、JetBrains などのローカルモデルクライアント向けに、NDJSON のチャット/生成、タグ、メタデータ、埋め込みを提供します。
- **Fusion(複数モデルによる統合)** — 仮想モデル `fusion` をリクエストすると、ルーターがプロンプトを多様な無料モデルのパネルに並列で展開し、審査役のモデルが各下書きから 1 つの回答を統合します。[詳細 →](docs/en/api/01-rest-api.md#fusion-multi-model-synthesis)
- **画像・動画・音声の生成** — `/v1/images/generations`、`/v1/videos/generations`、`/v1/audio/speech` は、メディアモデルを提供するプロバイダー間でルーティングされます。画像と音声は、カスタムの OpenAI 互換メディアエンドポイントも受け付けます。動画ジョブは同期型とキュー型のプロバイダーにわたって正規化され、完成した MP4 が返ります。
- **ツール呼び出しと構造化出力** — OpenAI 形式の `tools` がプロバイダー間でそのまま往復します(プレーンテキストのツール呼び出しは本物の `tool_calls` に救済されます)。さらに `response_format`、`seed`、`logprobs`、ペナルティなどのサンプリングパラメーターも、プロバイダーごとにそのまま渡されます。
- **6 つの戦略によるスマートルーティング** — モデルごとの速度・能力・信頼性のライブスコアでチェーンを順位付けします。429/5xx ではクールダウンとキーのローテーションを伴い、次のモデルへ自動でフェイルオーバーします。[ルーティングの詳細 →](docs/en/architecture/00-high-level-index.md#how-it-works)
- **統合モデルとプロファイル** — 複数のプロバイダーにある同じモデルは、グループ内で厳密にフェイルオーバーする 1 つのエントリにまとまります。名前付きのフォールバックチェーンのプロファイル(コーディング用チェーン、ビジョン用チェーンなど)は、ダッシュボードから、またはリクエストごとに `auto:<profile>` で切り替えられ、カスタムチェーンはチェーンマネージャーでその場で名前を変更できます。
- **キーごとのレート追跡** — `(platform, model, key)` ごとに RPM/RPD/TPM/TPD のカウンターを持ち、プロバイダーが報告する上限値を学習するため、ルーティングは常にすべての上限の内側に収まります。
- **自己更新するモデルカタログ** — ルーターは freellmapi.co から署名付きカタログを 1 日 2 回同期します。新しいモデル、クォータの変更、プロバイダー固有の挙動の修正が自動で反映されます。無料版は月次スナップショットを追従し、各モデルはライブフィードに入ってから 30 日後に加わります。プレミアムのルーターには当日中に届きます。[プレミアム →](#プレミアム-ライブカタログ)
- **スティッキーセッションとコンテキストの引き継ぎ** — 会話は 30 分間、同じモデルにとどまります。会話の途中でモデルが切り替わる場合は、任意の簡潔な引き継ぎメモによってスレッドの一貫性が保たれます。[詳細 →](docs/en/clients/01-agent-clients.md#context-handoff)
- **プロンプト圧縮(オプトイン)** — 共有のフェイルオープンなリクエストパイプラインが、キャッシュ検索とルーティングの前に、プロンプトの重複排除、ツール出力のフィルタリング、繰り返される JSON の圧縮、古いコンテキストの削減を行えます。[詳細 →](docs/en/compression/01-compression-pipeline.md)
- **暗号化されたキーと、外に出すのは 1 つのトークンだけ** — プロバイダーのキーは SQLite 内で AES-256-GCM により暗号化され、リクエストごとにメモリ内でのみ復号されます。アプリから見えるのは、統合された 1 つの `freellmapi-…` Bearer トークンだけです。
- **管理ダッシュボードと分析** — キーの管理、チェーンの並べ替え、プレイグラウンドの実行、24 時間〜90 日の期間での p50/p95/TTFT 分析ができる React UI です。ログイン制で、ダークテーマとライトテーマがあり、[60 言語](#対応言語)に対応しています。
- **ChatGPT 対応の MCP サーバーとインタラクティブなドキュメント** — ChatGPT などの MCP クライアントは、`/mcp` 経由で FreeLLMAPI の推論の呼び出し、利用可能なモデルの一覧、プロバイダーのヘルス・使用量・キャッシュ・ルーティングのメタデータの確認、ルーティング戦略の管理ができます。依存関係のない OpenAPI ビューアーが `/v1/docs` にあります。[ChatGPT とコーディングエージェント →](docs/en/clients/01-agent-clients.md#mcp-server)
- **運用面の便利機能** — オプトインのレスポンスキャッシュ、暗号化された DB バックアップ、定期的なキーのヘルスチェック、キーの一括インポート/エクスポート、宣言的な起動設定。[インストールとデプロイ →](docs/en/install/01-install.md)
- **Node 20+ が動く場所ならどこでも** — Windows、macOS、Linux サーバー、小型の ARM SBC(Raspberry Pi を含む)。PM2 / systemd / お好みのスーパーバイザーの下で、アイドル時のメモリ使用量(RSS)は約 40 MB です。

対象範囲は意図的に絞っています。[まだ対応していないもの](docs/en/architecture/00-high-level-index.md#not-yet-supported)をご覧ください。

## クイックスタート

**ワンライナー**(Docker が必要です。`~/freellmapi` を用意し、暗号化キーを生成し、イメージを pull して、コンテナーを起動します):

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

パイプで bash に渡す前に中身を読みたい方は、[スクリプトはこちら](https://freellmapi.co/install.sh)です。再実行しても安全で、`.env`(と暗号化キー)は保持され、コンテナーは `:latest` に更新されます。

http://localhost:3001 を開き、**キー**ページでプロバイダーのキーを追加し、**Fallback Chain** をお好みに並べ替えて、**キー**ページのヘッダーから統合 API キーを取得します。この統合キーが、OpenAI SDK の向け先になります。

Windows では、デスクトップ版の **[Releases にある `.exe` インストーラー](https://github.com/tashfeenahmed/freellmapi/releases/latest)**(下記)がもっとも簡単です。Android については、実験的な [Termux ガイド](docs/en/install/02-android-termux.md)をご覧ください。

それ以外のすべて(Docker Compose、ローカル開発、宣言的な起動設定、本番ビルド、LAN アクセス、バックアップ)は **[docs/en/install/01-install.md](docs/en/install/01-install.md)** にあります。

## デスクトップアプリ

ネイティブのメニューバーアプリが [`desktop/`](./desktop) にあります。ルーターとダッシュボードの全体がトレイからローカルで動き、リアルタイムのリクエスト統計を表示するガラス調のポップオーバーが付いています。

![FreeLLMAPI デスクトップアプリ](repo-assets/desktop.png)

**[Releases からダウンロード](https://github.com/tashfeenahmed/freellmapi/releases/latest)** — macOS の `.dmg` と Windows の `.exe` インストーラーが、すべてのリリースに添付されています。アカウントもパスワードも設定不要で、必要な認証情報はトレイのポップオーバーにある統合 API キーだけです。ソースからのビルド手順とデータの保存場所は [docs/en/install/01-install.md#desktop-app](docs/en/install/01-install.md#desktop-app) をご覧ください。

macOS 12 Monterey 以降では、**arm64 (Apple Silicon)** か **x64 (Intel)** を選んでください。どちらの Mac 向けビルドにも ZIP のダウンロードがあります。

## OpenAI 互換クライアントでの利用

OpenAI 互換のベース URL を指定できるものなら何でも動きます。ベース URL を `http://localhost:3001/v1` に設定し、ダッシュボードの統合キーを使ってください。どのジェネレーターも `--dry-run` に対応しており、`npx freellmapi launch`(Claude Code)と `launch-codex`(Codex)は、認証情報を設定ファイルにまったく残しません。ルーターは、エージェントがセッションの途中で内部を調べられる MCP サーバーとしても機能します。

**ChatGPT** は、非公開の Secure MCP Tunnel を通じて、同じローカルルーターに接続します。
`ask_freellmapi` MCP ツールは、ChatGPT から依頼されたタスクを `/v1/chat/completions` 経由でルーティングし、
回答を、実際に使われたモデル、フォールバック、キャッシュ、実行、トークンのメタデータとともに返します。ベース
URL と Bearer 認証はトンネルクライアントの設定に置かれ、デフォルトのモデルは
`MCP_INFERENCE_DEFAULT_MODEL` で設定します(未設定の場合は `auto`)。キーを Git や
MCP の URL に含めてはいけません。**[ChatGPT のセットアップ →](docs/en/clients/01-agent-clients.md#chatgpt-private-secure-mcp-tunnel)**

プロバイダーのキーは、ダッシュボードのセッショントークン(`FREELLMAPI_DASHBOARD_TOKEN` または `--token`)を使えばターミナルからも管理できます。`npx freellmapi keys add|list|remove|test <platform>` で、`keys test` は保存済みのキーを再確認します。[cli/README.md](cli/README.md#provider-keys) をご覧ください。

FreeLLMAPI は設計上、ローカルファースト・シングルユーザーです。プロバイダーのキーは SQLite データベース内に暗号化して保存され、リクエストはあなたのマシンから、有効にした上流プロバイダーへ直接送られます。

## 対応言語

ダッシュボードは **60 言語**に対応しています(デスクトップのトレイメニューは 6 言語)。UI は初回読み込み時にブラウザー/システムの言語を
自動検出し、**⋯ → 設定**からいつでも切り替えられます。
選択は記憶されます。右から左に書く言語
(العربية、עברית、فارسی、اردو)ではレイアウト全体が自動で反転し、
読み込まれるのは有効な言語の辞書だけで、残りの言語が帯域を使うことはありません。

<img src="https://flagcdn.com/24x18/us.png" srcset="https://flagcdn.com/48x36/us.png 2x" width="24" height="18" alt="United States" title="United States"> <img src="https://flagcdn.com/24x18/cn.png" srcset="https://flagcdn.com/48x36/cn.png 2x" width="24" height="18" alt="China" title="China"> <img src="https://flagcdn.com/24x18/es.png" srcset="https://flagcdn.com/48x36/es.png 2x" width="24" height="18" alt="Spain" title="Spain"> <img src="https://flagcdn.com/24x18/fr.png" srcset="https://flagcdn.com/48x36/fr.png 2x" width="24" height="18" alt="France" title="France"> <img src="https://flagcdn.com/24x18/br.png" srcset="https://flagcdn.com/48x36/br.png 2x" width="24" height="18" alt="Brazil" title="Brazil"> <img src="https://flagcdn.com/24x18/it.png" srcset="https://flagcdn.com/48x36/it.png 2x" width="24" height="18" alt="Italy" title="Italy"> <img src="https://flagcdn.com/24x18/in.png" srcset="https://flagcdn.com/48x36/in.png 2x" width="24" height="18" alt="India" title="India"> <img src="https://flagcdn.com/24x18/sa.png" srcset="https://flagcdn.com/48x36/sa.png 2x" width="24" height="18" alt="Saudi Arabia" title="Saudi Arabia"> <img src="https://flagcdn.com/24x18/bd.png" srcset="https://flagcdn.com/48x36/bd.png 2x" width="24" height="18" alt="Bangladesh" title="Bangladesh"> <img src="https://flagcdn.com/24x18/ru.png" srcset="https://flagcdn.com/48x36/ru.png 2x" width="24" height="18" alt="Russia" title="Russia"> <img src="https://flagcdn.com/24x18/pk.png" srcset="https://flagcdn.com/48x36/pk.png 2x" width="24" height="18" alt="Pakistan" title="Pakistan"> <img src="https://flagcdn.com/24x18/id.png" srcset="https://flagcdn.com/48x36/id.png 2x" width="24" height="18" alt="Indonesia" title="Indonesia"> <img src="https://flagcdn.com/24x18/de.png" srcset="https://flagcdn.com/48x36/de.png 2x" width="24" height="18" alt="Germany" title="Germany"> <img src="https://flagcdn.com/24x18/jp.png" srcset="https://flagcdn.com/48x36/jp.png 2x" width="24" height="18" alt="Japan" title="Japan"> <img src="https://flagcdn.com/24x18/ke.png" srcset="https://flagcdn.com/48x36/ke.png 2x" width="24" height="18" alt="Kenya" title="Kenya"> <img src="https://flagcdn.com/24x18/tr.png" srcset="https://flagcdn.com/48x36/tr.png 2x" width="24" height="18" alt="Türkiye" title="Türkiye"> <img src="https://flagcdn.com/24x18/vn.png" srcset="https://flagcdn.com/48x36/vn.png 2x" width="24" height="18" alt="Vietnam" title="Vietnam"> <img src="https://flagcdn.com/24x18/kr.png" srcset="https://flagcdn.com/48x36/kr.png 2x" width="24" height="18" alt="South Korea" title="South Korea"> <img src="https://flagcdn.com/24x18/ir.png" srcset="https://flagcdn.com/48x36/ir.png 2x" width="24" height="18" alt="Iran" title="Iran"> <img src="https://flagcdn.com/24x18/th.png" srcset="https://flagcdn.com/48x36/th.png 2x" width="24" height="18" alt="Thailand" title="Thailand"> <img src="https://flagcdn.com/24x18/pl.png" srcset="https://flagcdn.com/48x36/pl.png 2x" width="24" height="18" alt="Poland" title="Poland"> <img src="https://flagcdn.com/24x18/ua.png" srcset="https://flagcdn.com/48x36/ua.png 2x" width="24" height="18" alt="Ukraine" title="Ukraine"> <img src="https://flagcdn.com/24x18/mm.png" srcset="https://flagcdn.com/48x36/mm.png 2x" width="24" height="18" alt="Myanmar" title="Myanmar"> <img src="https://flagcdn.com/24x18/ro.png" srcset="https://flagcdn.com/48x36/ro.png 2x" width="24" height="18" alt="Romania" title="Romania"> <img src="https://flagcdn.com/24x18/nl.png" srcset="https://flagcdn.com/48x36/nl.png 2x" width="24" height="18" alt="Netherlands" title="Netherlands"> <img src="https://flagcdn.com/24x18/my.png" srcset="https://flagcdn.com/48x36/my.png 2x" width="24" height="18" alt="Malaysia" title="Malaysia"> <img src="https://flagcdn.com/24x18/ph.png" srcset="https://flagcdn.com/48x36/ph.png 2x" width="24" height="18" alt="Philippines" title="Philippines"> <img src="https://flagcdn.com/24x18/ng.png" srcset="https://flagcdn.com/48x36/ng.png 2x" width="24" height="18" alt="Nigeria" title="Nigeria"> <img src="https://flagcdn.com/24x18/et.png" srcset="https://flagcdn.com/48x36/et.png 2x" width="24" height="18" alt="Ethiopia" title="Ethiopia"> <img src="https://flagcdn.com/24x18/uz.png" srcset="https://flagcdn.com/48x36/uz.png 2x" width="24" height="18" alt="Uzbekistan" title="Uzbekistan"> <img src="https://flagcdn.com/24x18/az.png" srcset="https://flagcdn.com/48x36/az.png 2x" width="24" height="18" alt="Azerbaijan" title="Azerbaijan"> <img src="https://flagcdn.com/24x18/lk.png" srcset="https://flagcdn.com/48x36/lk.png 2x" width="24" height="18" alt="Sri Lanka" title="Sri Lanka"> <img src="https://flagcdn.com/24x18/np.png" srcset="https://flagcdn.com/48x36/np.png 2x" width="24" height="18" alt="Nepal" title="Nepal"> <img src="https://flagcdn.com/24x18/kh.png" srcset="https://flagcdn.com/48x36/kh.png 2x" width="24" height="18" alt="Cambodia" title="Cambodia"> <img src="https://flagcdn.com/24x18/gr.png" srcset="https://flagcdn.com/48x36/gr.png 2x" width="24" height="18" alt="Greece" title="Greece"> <img src="https://flagcdn.com/24x18/cz.png" srcset="https://flagcdn.com/48x36/cz.png 2x" width="24" height="18" alt="Czechia" title="Czechia"> <img src="https://flagcdn.com/24x18/hu.png" srcset="https://flagcdn.com/48x36/hu.png 2x" width="24" height="18" alt="Hungary" title="Hungary"> <img src="https://flagcdn.com/24x18/se.png" srcset="https://flagcdn.com/48x36/se.png 2x" width="24" height="18" alt="Sweden" title="Sweden"> <img src="https://flagcdn.com/24x18/il.png" srcset="https://flagcdn.com/48x36/il.png 2x" width="24" height="18" alt="Israel" title="Israel"> <img src="https://flagcdn.com/24x18/dk.png" srcset="https://flagcdn.com/48x36/dk.png 2x" width="24" height="18" alt="Denmark" title="Denmark"> <img src="https://flagcdn.com/24x18/fi.png" srcset="https://flagcdn.com/48x36/fi.png 2x" width="24" height="18" alt="Finland" title="Finland"> <img src="https://flagcdn.com/24x18/no.png" srcset="https://flagcdn.com/48x36/no.png 2x" width="24" height="18" alt="Norway" title="Norway"> <img src="https://flagcdn.com/24x18/sk.png" srcset="https://flagcdn.com/48x36/sk.png 2x" width="24" height="18" alt="Slovakia" title="Slovakia"> <img src="https://flagcdn.com/24x18/bg.png" srcset="https://flagcdn.com/48x36/bg.png 2x" width="24" height="18" alt="Bulgaria" title="Bulgaria"> <img src="https://flagcdn.com/24x18/hr.png" srcset="https://flagcdn.com/48x36/hr.png 2x" width="24" height="18" alt="Croatia" title="Croatia"> <img src="https://flagcdn.com/24x18/rs.png" srcset="https://flagcdn.com/48x36/rs.png 2x" width="24" height="18" alt="Serbia" title="Serbia"> <img src="https://flagcdn.com/24x18/lt.png" srcset="https://flagcdn.com/48x36/lt.png 2x" width="24" height="18" alt="Lithuania" title="Lithuania"> <img src="https://flagcdn.com/24x18/tw.png" srcset="https://flagcdn.com/48x36/tw.png 2x" width="24" height="18" alt="Taiwan" title="Taiwan"> <img src="https://flagcdn.com/24x18/pt.png" srcset="https://flagcdn.com/48x36/pt.png 2x" width="24" height="18" alt="Portugal" title="Portugal"> <img src="https://flagcdn.com/24x18/ge.png" srcset="https://flagcdn.com/48x36/ge.png 2x" width="24" height="18" alt="Georgia" title="Georgia">

ロケールの完全な一覧は
[`client/src/i18n/locale-config.ts`](./client/src/i18n/locale-config.ts) にあります。

最初の 6 つのロケールは人手でレビューされています。それ以降のものは機械
翻訳で、ネイティブスピーカーからの修正によって改善されていきます。1 文字列だけの PR でも、
最初のコントリビュートにぴったりです。

翻訳は [`client/src/i18n/locales/`](./client/src/i18n/locales) に、フラットな JSON ファイルとして置かれています。
文字列を直すには、そのロケールの JSON ファイルの値を編集します。
言語を追加するには、`en.json` をコピーして値を翻訳し、`client/src/i18n/locale-config.ts` にロケールを登録します
(トレイの文字列については `desktop/src/i18n.ts` にも登録します)。`npm test` はすべてのロケールについて、
キーとプレースホルダーの整合性をチェックします。
PR をお待ちしています。

## プレミアム (ライブカタログ)

ルーターは、モデルカタログを自動で最新に保ちます。署名付きカタログを
[freellmapi.co](https://freellmapi.co) から 1 日 2 回取得し、新しいモデル、
クォータの変更、プロバイダー固有の挙動の修正をローカル DB に適用します。あなた自身の
有効/無効の選択やカスタムプロバイダーには一切触れません。また、ダウンロードはすべて、適用の前に
固定された Ed25519 鍵で検証されます。

カタログは現在、**87 のプロバイダー**、**736 のモデルファミリー**、**1,313 の
無料プロバイダー/モデルエンドポイント**(チャット 1,137、画像 29、音声 41、埋め込み 68、
文字起こし 19、動画 6、decision 13)を追跡しており、掲載されている無料枠の容量は月間およそ **101 億トークン**です。
全体は
**[freellmapi.co/models](https://freellmapi.co/models.html)** で閲覧できます。

無料版も同じ署名付きカタログを取得しますが、月次スナップショットからです。モデルは
ライブフィードに入ってから 30 日後に加わるため、現在の無料ビルドは
約 303 モデル分遅れています。何かが失効することも、
機能が削られることもなく、届くのが遅れるだけです。

プレミアムは、その署名付きカタログを、あなたが運用するすべてのルーターでライブに保ちます。プロバイダーが
強力な無料モデルを公開したとき、静かにクォータを絞ったとき、ワイヤーフォーマットを壊したとき、
ライブフィードのルーターには、配信した当日に更新が届きます。

**[freellmapi.co でライブ版を始める →](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_bottom#pricing)**

- 年額 $19、または買い切り $49(永久)。Stripe での決済で、いつでもセルフサービスで解約できます。
- 1 つの `fla_` キーで、運用しているすべてのルーターをカバーします(デスクトップ、ホームラボ、Raspberry Pi)。
- ダッシュボードの**プレミアム**で有効化します。解約や請求の管理は
  [freellmapi.co/manage](https://freellmapi.co/manage) でセルフサービスで行えます。
- ルーター本体は引き続き MIT ライセンスで、永久に完全無料です。プレミアムが提供するのは
  ライブフィードだけで、これが、カタログを機能させ続けるための日次のモデルテストと
  カタログのメンテナンスを支える資金になります。

カタログサーバーは、あなたのプロンプト、補完結果、プロバイダーのキーを一切目にしません。どちらの場合でも、ルーターは
完全にセルフホストのままです。

## API の使い方

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

ストリーミング、`auto:*` ルーティング戦略、ツール呼び出し、ビジョン入力、Gemini の Google 検索グラウンディング、埋め込み、Anthropic Messages インターフェースは、それぞれに curl と Python の例を付けて、すべて **[docs/en/api/01-rest-api.md](docs/en/api/01-rest-api.md)** にまとめられています。すべてのレスポンスには `X-Routed-Via: <platform>/<model>` ヘッダーが付くので、実際にどのプロバイダーが処理したかを確認できます。

## スクリーンショット

### モデル

ルーティング戦略を選び、プロバイダー全体にわたって月間トークン予算が埋まっていく様子を確認できます。どのモデルにも、信頼性、速度、知能のライブスコアが表示され、以下の並びが、現在のリクエストのルーティング順です。

![モデルページ](repo-assets/models.png)

### キー

プロバイダーの認証情報を管理し、アプリの接続に使う統合 API キーを取得します。各キーにはステータスのドットと、最後にヘルスチェックした日時が表示されます。

![キーページ](repo-assets/keys.png)

### プレイグラウンド

ルーター経由でチャット補完を送り、どのプロバイダーが処理したかを確認できます。モデル ID とレイテンシーはメッセージ上にそのまま表示されます。ファイルは、ボタン、ドラッグ&ドロップ、貼り付けで添付できます。画像(PNG/JPEG/WebP/GIF)はブラウザー上で縮小され、画像コンテンツパートとしてビジョン対応モデルに送られます。テキストファイル(TXT/MD/CSV/JSON/LOG)は、フェンス付きブロックとしてプロンプトにインライン展開されます。

![プレイグラウンドページ](repo-assets/playground.png)

### 分析

リクエスト数、成功率、入出力トークン、平均レイテンシー、プロバイダーごとの内訳を、24 時間 / 7 日 / 30 日 / 90 日の期間で確認できます。

![分析ページ](repo-assets/analytics.png)

## 仕組み

![1 つのリクエストから最適な無料モデルへ — ライブスコア、クールダウン、クォータ追跡を備えたフォールバックチェーン](repo-assets/router-flow.png)

1 つのリクエストから最適な無料モデルへ。ルーターは、健全なキーがあり、すべてのレート制限の内側にある最優先のモデルを選び、メモリ内でキーを復号してプロバイダーを呼び出します。429/5xx の場合は、そのキーをクールダウンさせ、チェーン内の次のモデルで再試行します。コンポーネントの解説、ルーティングの内部構造、運用の詳細は **[docs/en/architecture/00-high-level-index.md](docs/en/architecture/00-high-level-index.md)** にあります。

## FAQ

**パスワードは必要ですか?** デスクトップアプリでは不要です。ダッシュボードは非表示のローカルアカウントで自動的にサインインするため、設定するものも、忘れるものもありません。トレイアイコン → **Open Dashboard** から、または同じコンピューター上の任意のブラウザー(例: http://127.0.0.1:31415)で開いてください。どちらも自動でサインインします。LAN アクセス経由でアプリに接続する別のデバイスには、引き続きサインインフォームが表示されます。サーバーへのインストール(Docker、ワンライナー、`npm run dev`)には、メールアドレスとパスワードのアカウントがあります。

**サーバーへのインストールでパスワードを忘れました。** ログインページで **パスワードをお忘れですか？** をクリックしてください。リンクを送るメールがないため、ワンタイムコードはサーバーのログに出力されます。`docker compose logs -f freellmapi`(またはサーバーを動かしているターミナル、デスクトップのログファイル)で読み取り、リセットフォームに入力してください。コードの有効期限は 15 分です。

**ログはどこにありますか?** Docker ではコンテナーのログ、ソースからの実行ではターミナル、デスクトップアプリでは `<data dir>/logs/freeapi.log` にあります。トレイメニューの **Open Logs Folder** から開けます。

**アンインストールするには?** アプリを削除し(macOS ではゴミ箱、Windows では *設定 → アプリ*、Docker では `docker compose down -v`)、その後データディレクトリ(`%APPDATA%\FreeLLMAPI\`、`~/Library/Application Support/FreeLLMAPI/`、または `~/.config/FreeLLMAPI/`)を削除してください。アンインストールだけでは、そのフォルダーには手が付けられません。

インストール方法ごとの詳しい回答: **[docs/en/install/01-install.md#faq-passwords-logs-uninstall](docs/en/install/01-install.md#faq-passwords-logs-uninstall)**。

## 制限事項

無料枠を積み重ねることには、現実的なトレードオフがあります。最先端のモデルはなく、レイテンシーは一定せず、SLA もありません。さらに、上位モデルが 1 日の上限に達するにつれて、1 日の後半にはエンドポイントの実効的な知能が低下し、UTC の午前 0 時にリセットされます。本格的なものをこの上に構築する前に、**[docs/en/architecture/00-high-level-index.md#limitations](docs/en/architecture/00-high-level-index.md#limitations)** にある率直な一覧を読んでください。

## コントリビュート

コントリビューターを大歓迎します! 開発のループ、PR に求められること、AI/LLM を使ったコントリビュートの方針(要点: 歓迎、品質の基準は他の PR と同じ)については [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。最初の PR にお勧めのもの:

- **プロバイダーの追加** — `server/src/providers/openai-compat.ts` をテンプレートとしてコピーし、`server/src/providers/index.ts` に組み込み、`server/src/db/index.ts` にそのモデルをシードし、`server/src/__tests__/providers/` にテストを追加します。
- **エンドポイントの追加** — ほかの OpenAI 互換インターフェース(例: `/v1/realtime`)。プロバイダーの基底クラスには新しいメソッドを追加でき、アダプターは自分が対応するものを宣言します。
- **ルーターの改善** — コストを考慮したルーティング(最安・健全・最速のトレードオフ)、レイテンシーで重み付けした優先度の改善、リージョンの固定。
- **ダッシュボードの磨き込み** — 分析ページのグラフ、キーのローテーションの UX、`.env` からのキーの一括インポート。
- **ドキュメント** — 例の追加、Go/Rust などのクライアントライブラリのスニペット、Docker や Fly 向けのデプロイレシピ。

`npm install && npm run dev` で、サーバーが :3001、ダッシュボードが :5173 で起動し、どちらも HMR に対応しています。再現性のあるセットアップには、Bash では `./scripts/dev-bootstrap.sh`、PowerShell では `.\scripts\dev-bootstrap.ps1` を使ってください。どちらも既存の `.env` を保持します。PR にはテストを含め、既存のスイートを通し(`npm test`)、リポジトリにすでにある `.editorconfig` / tsconfig のデフォルトに合わせてください。データベースマイグレーションのワークフローとコントリビューターの全体的な流れは [CONTRIBUTING.md](./CONTRIBUTING.md) にあります。

### コントリビューター

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

## 免責事項

**このプロジェクトは個人的な実験と学習のためのものであり、本番用ではありません。** 無料枠は、開発者がそれを使ってプロトタイプを作れるようにするためのものです。安定した、サポートされた推論基盤ではなく、そのように扱うべきでもありません。FreeLLMAPI の上に本格的なものを構築する場合は、公開前に有料の API に差し替えてください。各上流プロバイダーとの関係は、アカウント作成時に同意した規約に従います。トラフィックがこのプロジェクトを経由してプロキシされる場合でも、それらの規約は引き続き適用され、遵守する責任はあなたにあります。

各プロバイダーの利用規約が個人用・単一ユーザーのプロキシをどう見ているか(2026 年 5 月にプロバイダーごとに確認したもの)は、[docs/en/architecture/00-high-level-index.md#terms-of-service-review](docs/en/architecture/00-high-level-index.md#terms-of-service-review) にあります。

## ライセンス

[MIT](./LICENSE)
