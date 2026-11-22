<div align="center">

# FreeLLMAPI

**10,1 tỷ token mỗi tháng. 87 nhà cung cấp LLM miễn phí. 1.313 endpoint mô hình miễn phí. Một endpoint duy nhất tương thích OpenAI.**

Gộp các gói miễn phí từ hàng chục nhà cung cấp, cùng các endpoint chat, embedding, hình ảnh và âm thanh tương thích OpenAI do bạn tự cấu hình, phía sau một API `/v1` duy nhất. Khóa được lưu trữ mã hóa. Bộ định tuyến chọn mô hình khả dụng tốt nhất cho mỗi yêu cầu, tự chuyển sang nhà cung cấp tiếp theo khi một nhà cung cấp bị giới hạn tốc độ, và theo dõi mức sử dụng theo từng khóa để bạn luôn nằm dưới mọi giới hạn của gói miễn phí.

[![CI](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/tashfeenahmed/freellmapi?style=flat&logo=github&color=yellow)](https://github.com/tashfeenahmed/freellmapi/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#đóng-góp)
[![Docker image](https://img.shields.io/badge/ghcr.io-freellmapi-2496ED?logo=docker&logoColor=white)](https://github.com/tashfeenahmed/freellmapi/pkgs/container/freellmapi)
[![Ask DeepWiki](https://img.shields.io/badge/DeepWiki-Ask-blue)](https://deepwiki.com/tashfeenahmed/freellmapi)

**[freellmapi.co](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=repository&utm_content=readme_top)** · duyệt toàn bộ catalog: 736 họ mô hình, 1.313 endpoint miễn phí

[English](README.md) · [Türkçe](README.tr.md) · [简体中文](README.zh-cn.md) · [Русский](README.ru.md) · [O'zbekcha](README.uz.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **Tiếng Việt**

<p align="center">
  <a href="https://github.com/tashfeenahmed/freellmapi/releases/latest"><img src="repo-assets/badges/macos.svg" height="48" alt="Download for macOS"></a>
  <a href="https://apps.microsoft.com/detail/9PBN6G8K2B7F"><img src="repo-assets/badges/microsoft-store.svg" height="48" alt="Get it from Microsoft Store"></a>
  <a href="docs/en/install/01-install.md#docker-compose"><img src="repo-assets/badges/docker.svg" height="48" alt="Self-host with Docker"></a>
  <a href="https://play.google.com/store/apps/details?id=co.freellmapi.app"><img src="repo-assets/badges/play-store.svg" height="48" alt="Get it on Google Play"></a>
  <a href="https://apps.apple.com/app/id6804648934"><img src="repo-assets/badges/app-store.svg" height="48" alt="Download on the App Store"></a>
</p>

![Bảng điều khiển FreeLLMAPI — trang Models với ngân sách token hằng tháng](repo-assets/github-hero.png)


Bộ định tuyến của bạn tự cập nhật catalog mô hình từ một nguồn cấp đã ký: mô hình miễn phí mới, thay đổi hạn mức và các bản sửa tương thích đều đến nơi mà không cần `git pull`. Bản cài đặt miễn phí nhận bản chụp hằng tháng, nên một mô hình sẽ đến tay chúng 30 ngày sau khi gia nhập nguồn cấp trực tiếp; bộ định tuyến premium nhận được ngay trong ngày.
**[Dùng bản trực tiếp tại freellmapi.co](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_top#pricing)** ($19/năm, hủy bất cứ lúc nào).

</div>

---

## Mục lục

- [Vì sao dự án này tồn tại](#vì-sao-dự-án-này-tồn-tại)
- [Các nhà cung cấp được hỗ trợ](#các-nhà-cung-cấp-được-hỗ-trợ)
- [CLI và agent lập trình tương thích](#cli-và-agent-lập-trình-tương-thích)
- [So sánh với các giải pháp khác](#so-sánh-với-các-giải-pháp-khác)
- [Tính năng](#tính-năng)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [Ứng dụng desktop](#ứng-dụng-desktop)
- [Dùng với các client tương thích OpenAI](#dùng-với-các-client-tương-thích-openai)
- [Ngôn ngữ](#ngôn-ngữ)
- [Premium (catalog trực tiếp)](#premium-catalog-trực-tiếp)
- [Sử dụng API](#sử-dụng-api)
- [Ảnh chụp màn hình](#ảnh-chụp-màn-hình)
- [Cách hoạt động](#cách-hoạt-động)
- [Câu hỏi thường gặp](#câu-hỏi-thường-gặp)
- [Hạn chế](#hạn-chế)
- [Đóng góp](#đóng-góp)
- [Tuyên bố miễn trừ trách nhiệm](#tuyên-bố-miễn-trừ-trách-nhiệm)

**Hướng dẫn:** [Cài đặt & triển khai](docs/en/install/01-install.md) · [Tài liệu API](docs/en/api/01-rest-api.md) · [Client & agent lập trình](docs/en/clients/01-agent-clients.md) · [Nén prompt](docs/en/compression/01-compression-pipeline.md) · [Kiến trúc & cơ chế bên trong](docs/en/architecture/00-high-level-index.md) · [Mục lục tài liệu](docs/en/README.md) · [Hướng dẫn đóng góp](CONTRIBUTING.md)

## Vì sao dự án này tồn tại

Mọi phòng lab AI nghiêm túc hiện nay đều có một gói miễn phí: vài triệu token mỗi tháng, vài nghìn yêu cầu mỗi ngày. Đứng riêng lẻ, mỗi gói chỉ như món đồ chơi. Nhưng gộp tất cả lại, chúng cộng dồn thành khoảng **10,1 tỷ token mỗi tháng** năng lực suy luận thực sự dùng được, trải trên **736 họ mô hình / 1.313 endpoint nhà cung cấp**, từ nhỏ-và-nhanh đến khá mạnh.

Vấn đề là gộp chúng bằng tay rất cực: tám mươi bảy SDK khác nhau, tám mươi bảy giới hạn tốc độ khác nhau, tám mươi bảy nơi một yêu cầu có thể hỏng. FreeLLMAPI nén tất cả thành một endpoint tương thích OpenAI duy nhất. Chỉ cần trỏ bất kỳ thư viện client OpenAI nào vào máy chủ local của bạn, và nó sẽ định tuyến trong suốt qua mọi nhà cung cấp bạn đã thêm khóa.

Và bức tranh gói miễn phí thay đổi hằng tuần: nhà cung cấp ra mắt mô hình, khai tử chúng và thay đổi hạn mức mà không báo trước. FreeLLMAPI theo dõi tất cả thay bạn. Bộ định tuyến tự kéo một catalog mô hình đã ký từ [freellmapi.co](https://freellmapi.co), nên bản cài đặt của bạn luôn cập nhật mà không cần `git pull`. Xem [Premium (catalog trực tiếp)](#premium-catalog-trực-tiếp) để biết nó theo kịp nhanh đến đâu.

![Gói miễn phí khi được gộp lại — ~10,1 tỷ token suy luận miễn phí mỗi tháng trên 87 nhà cung cấp](repo-assets/free-tier.png)

## Các nhà cung cấp được hỗ trợ

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

<i>… và 75 nhà cung cấp miễn phí nữa</i>

</div>

Cộng thêm một nhà cung cấp **tùy chỉnh** — trỏ các mô hình chat, embedding, hình ảnh hoặc âm thanh vào bất kỳ endpoint tương thích OpenAI nào (llama.cpp, LM Studio, vLLM, một Ollama local, hoặc một gateway từ xa) ngay từ trang Keys.

Danh sách đầy đủ, luôn cập nhật, nằm tại **[freellmapi.co/models](https://freellmapi.co/models.html)** kèm giới hạn tốc độ, cửa sổ ngữ cảnh và ngân sách token miễn phí cho từng mô hình.

## CLI và agent lập trình tương thích

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

<i>… cùng Continue, Goose, Qwen Code, Kilo Code, Crush, Zed, JetBrains AI, DeepSeek Harness, MiMo Code, AtomCode, OpenClaw, Hermes Agent, Pi, Reasonix, ZCode và mọi client tương thích OpenAI, Anthropic, Gemini hoặc Ollama</i>

</div>

Hầu hết các agent tự cấu hình chỉ bằng một lệnh duy nhất: lệnh này đọc catalog trực tiếp của bạn, sao lưu cấu hình hiện có và gộp vào đó:

```bash
npx freellmapi setup-claude --url http://localhost:3001 --api-key <unified-key>
```

**[Tất cả agent được hỗ trợ và lệnh thiết lập của chúng →](docs/en/clients/02-supported-agents.md)** · [Công thức theo từng công cụ, máy chủ MCP và token URL →](docs/en/clients/01-agent-clients.md)

## So sánh với các giải pháp khác

![Bảng so sánh tính năng với OpenRouter, LiteLLM và Portkey](repo-assets/comparison.png)

Dựa trên tài liệu công khai, tháng 7/2026 — hoan nghênh mọi góp ý sửa sai.

## Tính năng

![Tổng quan tính năng](repo-assets/features.png)

- **Mọi bề mặt kiểu OpenAI** — `/v1/chat/completions`, `/v1/responses` (thứ Codex CLI cần), `/v1/completions` (tự hoàn thành ghost-text trong editor), `/v1/images/generations`, `/v1/videos/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/embeddings` và `/v1/models` — cả streaming lẫn non-streaming, từ SDK chính thức hoặc bất kỳ client tương thích OpenAI nào. [Tài liệu API →](docs/en/api/01-rest-api.md)
- **Anthropic Messages API** — `/v1/messages` nói đúng định dạng wire của Anthropic trên cùng một bộ định tuyến, nên **Claude Code** và các SDK Anthropic chính thức chạy được trên kho miễn phí của bạn. [Chi tiết →](docs/en/api/01-rest-api.md#anthropic--claude-clients)
- **Bề mặt Gemini + Ollama nguyên bản** — Gemini CLI dùng được `/v1beta` (`generateContent`, streaming, đếm token, models), trong khi giả lập Ollama (bật tùy chọn) phục vụ chat/generate dạng NDJSON, tags, metadata và embeddings cho Zed, JetBrains và các client mô hình local khác.
- **Fusion (tổng hợp đa mô hình)** — yêu cầu mô hình ảo `fusion` và bộ định tuyến sẽ tỏa prompt của bạn song song tới một hội đồng các mô hình miễn phí đa dạng, rồi một mô hình giám khảo tổng hợp thành một đáp án duy nhất từ các bản nháp. [Chi tiết →](docs/en/api/01-rest-api.md#fusion-multi-model-synthesis)
- **Tạo hình ảnh, video & giọng nói** — `/v1/images/generations`, `/v1/videos/generations` và `/v1/audio/speech` định tuyến qua các nhà cung cấp phục vụ mô hình media; hình ảnh và giọng nói còn chấp nhận endpoint media tương thích OpenAI tùy chỉnh. Các job video được chuẩn hóa giữa nhà cung cấp đồng bộ và nhà cung cấp xếp hàng, và trả về một file MP4 hoàn chỉnh.
- **Gọi công cụ & đầu ra có cấu trúc** — `tools` kiểu OpenAI đi vòng qua các nhà cung cấp (các lời gọi công cụ dạng văn bản thuần được cứu thành `tool_calls` thật), cộng thêm `response_format`, `seed`, `logprobs`, các mức phạt và phần còn lại của tham số sampling được chuyển tiếp theo từng nhà cung cấp.
- **Định tuyến thông minh, sáu chiến lược** — điểm tốc độ/năng lực/độ tin cậy trực tiếp của từng mô hình xếp hạng chuỗi của bạn; cơ chế fallover tự động thử lại mô hình tiếp theo khi gặp 429/5xx, kèm thời gian chờ nguội và luân chuyển khóa. [Định tuyến chi tiết →](docs/en/architecture/00-high-level-index.md#how-it-works)
- **Mô hình & hồ sơ hợp nhất** — cùng một mô hình trên nhiều nhà cung cấp được gộp thành một mục duy nhất với failover nghiêm ngặt trong nhóm; các hồ sơ chuỗi dự phòng có tên (một chuỗi cho lập trình, một chuỗi cho thị giác) chuyển đổi được từ bảng điều khiển hoặc theo từng yêu cầu qua `auto:<profile>`, và các chuỗi tùy chỉnh đổi tên tại chỗ được ngay trong trình quản lý chuỗi.
- **Theo dõi tốc độ theo từng khóa** — bộ đếm RPM/RPD/TPM/TPD theo từng `(platform, model, key)` tự học các trần mà nhà cung cấp công bố, nên việc định tuyến luôn nằm dưới mọi giới hạn.
- **Catalog mô hình tự cập nhật** — bộ định tuyến đồng bộ một catalog đã ký từ freellmapi.co hai lần mỗi ngày: mô hình mới, thay đổi hạn mức và bản sửa các điểm kỳ quặc của nhà cung cấp đều tự động đến nơi. Bản cài đặt miễn phí theo bản chụp hằng tháng, nơi mỗi mô hình gia nhập 30 ngày sau khi vào nguồn cấp trực tiếp; bộ định tuyến premium nhận ngay trong ngày. [Premium →](#premium-catalog-trực-tiếp)
- **Phiên dính & bàn giao ngữ cảnh** — cuộc hội thoại ở yên trên một mô hình trong 30 phút; một ghi chú bàn giao gọn nhẹ tùy chọn giữ mạch hội thoại liền lạc khi buộc phải đổi mô hình giữa chừng. [Chi tiết →](docs/en/clients/01-agent-clients.md#context-handoff)
- **Nén prompt (tùy chọn bật)** — một pipeline yêu cầu dùng chung, fail-open, có thể khử trùng lặp prompt, lọc đầu ra của công cụ, nén JSON lặp lại và cắt ngữ cảnh cũ trước khi tra cache và định tuyến. [Chi tiết →](docs/en/compression/01-compression-pipeline.md)
- **Khóa mã hóa, một token duy nhất ra ngoài** — khóa nhà cung cấp được mã hóa AES-256-GCM trong SQLite và giải mã trong bộ nhớ theo từng yêu cầu; ứng dụng của bạn chỉ bao giờ thấy một bearer token hợp nhất duy nhất dạng `freellmapi-…`.
- **Bảng điều khiển quản trị & phân tích** — giao diện React để quản lý khóa, sắp xếp lại chuỗi, chạy playground, và đọc số liệu phân tích p50/p95/TTFT trên các cửa sổ 24 giờ–90 ngày; có cổng đăng nhập, theme tối/sáng, [60 ngôn ngữ](#ngôn-ngữ).
- **Máy chủ MCP sẵn sàng cho ChatGPT & tài liệu tương tác** — ChatGPT và các client MCP khác có thể gọi suy luận của FreeLLMAPI, liệt kê mô hình dùng được, kiểm tra sức khỏe/mức dùng/cache/metadata định tuyến của nhà cung cấp, và quản lý chiến lược định tuyến qua `/mcp`; một trình xem OpenAPI không phụ thuộc thư viện nằm tại `/v1/docs`. [ChatGPT và agent lập trình →](docs/en/clients/01-agent-clients.md#mcp-server)
- **Tiện ích vận hành** — cache phản hồi tùy chọn bật, sao lưu DB mã hóa, kiểm tra sức khỏe khóa định kỳ, nhập/xuất khóa hàng loạt, cấu hình khởi động khai báo. [Cài đặt & triển khai →](docs/en/install/01-install.md)
- **Chạy ở mọi nơi Node 20+ chạy** — Windows, macOS, máy chủ Linux, hoặc một SBC ARM nhỏ (kể cả Raspberry Pi). ~40 MB RSS khi nhàn rỗi phía sau PM2 / systemd / bất kỳ trình giám sát nào bạn thích.

Phạm vi được giữ hẹp có chủ đích — xem [những gì chưa được hỗ trợ](docs/en/architecture/00-high-level-index.md#not-yet-supported).

## Bắt đầu nhanh

**Một dòng lệnh** (cần Docker — thiết lập `~/freellmapi`, tạo khóa mã hóa, kéo image và khởi động container):

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

Muốn đọc trước khi pipe vào bash? [Script nằm ở đây](https://freellmapi.co/install.sh). Chạy lại nó là an toàn: `.env` của bạn (và khóa mã hóa) được giữ nguyên và container cập nhật lên `:latest`.

Mở http://localhost:3001, thêm khóa nhà cung cấp của bạn ở trang **Keys**, sắp xếp lại **Fallback Chain** theo ý thích, và lấy khóa API hợp nhất của bạn ở phần đầu trang **Keys**. Khóa hợp nhất đó chính là thứ bạn trỏ OpenAI SDK của mình vào.

Trên Windows, đường dễ nhất là ứng dụng desktop từ **[Microsoft Store](https://apps.microsoft.com/detail/9PBN6G8K2B7F)**: nó đã được ký (nên Smart App Control cho phép chạy) và tự cập nhật. Bộ cài `.exe` trên [Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest) là cùng một ứng dụng, bản chưa ký (xem bên dưới). Trên Android, xem [hướng dẫn Termux](docs/en/install/02-android-termux.md) đang thử nghiệm.

Mọi thứ còn lại — Docker Compose, phát triển local, cấu hình khởi động khai báo, bản build production, truy cập LAN và sao lưu — nằm trong **[docs/en/install/01-install.md](docs/en/install/01-install.md)**.

## Ứng dụng desktop

Một ứng dụng menu-bar nguyên bản nằm trong [`desktop/`](./desktop): toàn bộ bộ định tuyến + bảng điều khiển chạy local ngay từ khay hệ thống của bạn, với một popover kính hiển thị thống kê yêu cầu trực tiếp.

![Ứng dụng desktop FreeLLMAPI](repo-assets/desktop.png)

**[Tải từ Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest)** — file `.dmg` cho macOS và bộ cài `.exe` cho Windows được đính kèm trong mọi bản phát hành. Trên Windows, hãy ưu tiên bản **[Microsoft Store](https://apps.microsoft.com/detail/9PBN6G8K2B7F)**: nó đã được ký nên Smart App Control không chặn, và Store giữ nó luôn cập nhật. Không cần tài khoản hay mật khẩu để thiết lập: thông tin xác thực duy nhất bạn cần là khóa API hợp nhất từ popover trên khay. Các bước build từ mã nguồn và nơi dữ liệu của bạn nằm: [docs/en/install/01-install.md#desktop-app](docs/en/install/01-install.md#desktop-app).

Với macOS 12 Monterey trở lên, chọn **arm64 (Apple Silicon)** hoặc **x64 (Intel)**. Cả hai bản build Mac đều có kèm bản tải ZIP.

## Dùng với các client tương thích OpenAI

Bất cứ thứ gì trỏ được vào một base URL tương thích OpenAI đều dùng được: đặt nó thành `http://localhost:3001/v1` cùng khóa hợp nhất từ bảng điều khiển. Mọi trình tạo đều hỗ trợ `--dry-run`; `npx freellmapi launch` (Claude Code) và `launch-codex` (Codex) giữ thông tin xác thực hoàn toàn ngoài các file cấu hình. Bộ định tuyến đồng thời là một máy chủ MCP để các agent của bạn có thể nội soi ngay giữa phiên.

**ChatGPT** kết nối tới cùng bộ định tuyến local này qua một Secure MCP Tunnel riêng tư. Công cụ MCP
`ask_freellmapi` định tuyến một tác vụ do ChatGPT yêu cầu qua `/v1/chat/completions` và
trả về đáp án kèm metadata về mô hình đã phục vụ, fallback, cache, thực thi và token. Base
URL và xác thực bearer nằm trong cấu hình tunnel-client; mô hình mặc định được đặt bằng
`MCP_INFERENCE_DEFAULT_MODEL` (`auto` khi không đặt). Không khóa nào được phép nằm trong Git hay trong
URL của MCP. **[Thiết lập ChatGPT →](docs/en/clients/01-agent-clients.md#chatgpt-private-secure-mcp-tunnel)**

Khóa nhà cung cấp cũng quản lý được từ terminal, bằng token phiên của bảng điều khiển (`FREELLMAPI_DASHBOARD_TOKEN` hoặc `--token`): `npx freellmapi keys add|list|remove|test <platform>`, trong đó `keys test` kiểm tra lại các khóa đã lưu. Xem [cli/README.md](cli/README.md#provider-keys).

FreeLLMAPI được thiết kế local-first và đơn người dùng. Khóa nhà cung cấp của bạn ở yên trong cơ sở dữ liệu SQLite của bạn, mã hóa khi lưu trữ, và các yêu cầu đi từ máy của bạn tới các nhà cung cấp upstream bạn đã bật.

## Ngôn ngữ

Bảng điều khiển có sẵn **60 ngôn ngữ** (menu khay của desktop có 6). Giao diện
tự phát hiện ngôn ngữ trình duyệt/hệ thống của bạn ở lần tải đầu tiên và bạn có thể chuyển bất cứ
lúc nào từ **⋯ → Settings**; lựa chọn sẽ được ghi nhớ. Các ngôn ngữ viết từ phải sang trái
(العربية, עברית, فارسی, اردو) tự động lật toàn bộ bố cục, và chỉ từ điển của
ngôn ngữ đang dùng mới được tải — phần còn lại không bao giờ chạm vào băng thông của bạn.

<img src="https://flagcdn.com/24x18/us.png" srcset="https://flagcdn.com/48x36/us.png 2x" width="24" height="18" alt="United States" title="United States"> <img src="https://flagcdn.com/24x18/cn.png" srcset="https://flagcdn.com/48x36/cn.png 2x" width="24" height="18" alt="China" title="China"> <img src="https://flagcdn.com/24x18/es.png" srcset="https://flagcdn.com/48x36/es.png 2x" width="24" height="18" alt="Spain" title="Spain"> <img src="https://flagcdn.com/24x18/fr.png" srcset="https://flagcdn.com/48x36/fr.png 2x" width="24" height="18" alt="France" title="France"> <img src="https://flagcdn.com/24x18/br.png" srcset="https://flagcdn.com/48x36/br.png 2x" width="24" height="18" alt="Brazil" title="Brazil"> <img src="https://flagcdn.com/24x18/it.png" srcset="https://flagcdn.com/48x36/it.png 2x" width="24" height="18" alt="Italy" title="Italy"> <img src="https://flagcdn.com/24x18/in.png" srcset="https://flagcdn.com/48x36/in.png 2x" width="24" height="18" alt="India" title="India"> <img src="https://flagcdn.com/24x18/sa.png" srcset="https://flagcdn.com/48x36/sa.png 2x" width="24" height="18" alt="Saudi Arabia" title="Saudi Arabia"> <img src="https://flagcdn.com/24x18/bd.png" srcset="https://flagcdn.com/48x36/bd.png 2x" width="24" height="18" alt="Bangladesh" title="Bangladesh"> <img src="https://flagcdn.com/24x18/ru.png" srcset="https://flagcdn.com/48x36/ru.png 2x" width="24" height="18" alt="Russia" title="Russia"> <img src="https://flagcdn.com/24x18/pk.png" srcset="https://flagcdn.com/48x36/pk.png 2x" width="24" height="18" alt="Pakistan" title="Pakistan"> <img src="https://flagcdn.com/24x18/id.png" srcset="https://flagcdn.com/48x36/id.png 2x" width="24" height="18" alt="Indonesia" title="Indonesia"> <img src="https://flagcdn.com/24x18/de.png" srcset="https://flagcdn.com/48x36/de.png 2x" width="24" height="18" alt="Germany" title="Germany"> <img src="https://flagcdn.com/24x18/jp.png" srcset="https://flagcdn.com/48x36/jp.png 2x" width="24" height="18" alt="Japan" title="Japan"> <img src="https://flagcdn.com/24x18/ke.png" srcset="https://flagcdn.com/48x36/ke.png 2x" width="24" height="18" alt="Kenya" title="Kenya"> <img src="https://flagcdn.com/24x18/tr.png" srcset="https://flagcdn.com/48x36/tr.png 2x" width="24" height="18" alt="Türkiye" title="Türkiye"> <img src="https://flagcdn.com/24x18/vn.png" srcset="https://flagcdn.com/48x36/vn.png 2x" width="24" height="18" alt="Vietnam" title="Vietnam"> <img src="https://flagcdn.com/24x18/kr.png" srcset="https://flagcdn.com/48x36/kr.png 2x" width="24" height="18" alt="South Korea" title="South Korea"> <img src="https://flagcdn.com/24x18/ir.png" srcset="https://flagcdn.com/48x36/ir.png 2x" width="24" height="18" alt="Iran" title="Iran"> <img src="https://flagcdn.com/24x18/th.png" srcset="https://flagcdn.com/48x36/th.png 2x" width="24" height="18" alt="Thailand" title="Thailand"> <img src="https://flagcdn.com/24x18/pl.png" srcset="https://flagcdn.com/48x36/pl.png 2x" width="24" height="18" alt="Poland" title="Poland"> <img src="https://flagcdn.com/24x18/ua.png" srcset="https://flagcdn.com/48x36/ua.png 2x" width="24" height="18" alt="Ukraine" title="Ukraine"> <img src="https://flagcdn.com/24x18/mm.png" srcset="https://flagcdn.com/48x36/mm.png 2x" width="24" height="18" alt="Myanmar" title="Myanmar"> <img src="https://flagcdn.com/24x18/ro.png" srcset="https://flagcdn.com/48x36/ro.png 2x" width="24" height="18" alt="Romania" title="Romania"> <img src="https://flagcdn.com/24x18/nl.png" srcset="https://flagcdn.com/48x36/nl.png 2x" width="24" height="18" alt="Netherlands" title="Netherlands"> <img src="https://flagcdn.com/24x18/my.png" srcset="https://flagcdn.com/48x36/my.png 2x" width="24" height="18" alt="Malaysia" title="Malaysia"> <img src="https://flagcdn.com/24x18/ph.png" srcset="https://flagcdn.com/48x36/ph.png 2x" width="24" height="18" alt="Philippines" title="Philippines"> <img src="https://flagcdn.com/24x18/ng.png" srcset="https://flagcdn.com/48x36/ng.png 2x" width="24" height="18" alt="Nigeria" title="Nigeria"> <img src="https://flagcdn.com/24x18/et.png" srcset="https://flagcdn.com/48x36/et.png 2x" width="24" height="18" alt="Ethiopia" title="Ethiopia"> <img src="https://flagcdn.com/24x18/uz.png" srcset="https://flagcdn.com/48x36/uz.png 2x" width="24" height="18" alt="Uzbekistan" title="Uzbekistan"> <img src="https://flagcdn.com/24x18/az.png" srcset="https://flagcdn.com/48x36/az.png 2x" width="24" height="18" alt="Azerbaijan" title="Azerbaijan"> <img src="https://flagcdn.com/24x18/lk.png" srcset="https://flagcdn.com/48x36/lk.png 2x" width="24" height="18" alt="Sri Lanka" title="Sri Lanka"> <img src="https://flagcdn.com/24x18/np.png" srcset="https://flagcdn.com/48x36/np.png 2x" width="24" height="18" alt="Nepal" title="Nepal"> <img src="https://flagcdn.com/24x18/kh.png" srcset="https://flagcdn.com/48x36/kh.png 2x" width="24" height="18" alt="Cambodia" title="Cambodia"> <img src="https://flagcdn.com/24x18/gr.png" srcset="https://flagcdn.com/48x36/gr.png 2x" width="24" height="18" alt="Greece" title="Greece"> <img src="https://flagcdn.com/24x18/cz.png" srcset="https://flagcdn.com/48x36/cz.png 2x" width="24" height="18" alt="Czechia" title="Czechia"> <img src="https://flagcdn.com/24x18/hu.png" srcset="https://flagcdn.com/48x36/hu.png 2x" width="24" height="18" alt="Hungary" title="Hungary"> <img src="https://flagcdn.com/24x18/se.png" srcset="https://flagcdn.com/48x36/se.png 2x" width="24" height="18" alt="Sweden" title="Sweden"> <img src="https://flagcdn.com/24x18/il.png" srcset="https://flagcdn.com/48x36/il.png 2x" width="24" height="18" alt="Israel" title="Israel"> <img src="https://flagcdn.com/24x18/dk.png" srcset="https://flagcdn.com/48x36/dk.png 2x" width="24" height="18" alt="Denmark" title="Denmark"> <img src="https://flagcdn.com/24x18/fi.png" srcset="https://flagcdn.com/48x36/fi.png 2x" width="24" height="18" alt="Finland" title="Finland"> <img src="https://flagcdn.com/24x18/no.png" srcset="https://flagcdn.com/48x36/no.png 2x" width="24" height="18" alt="Norway" title="Norway"> <img src="https://flagcdn.com/24x18/sk.png" srcset="https://flagcdn.com/48x36/sk.png 2x" width="24" height="18" alt="Slovakia" title="Slovakia"> <img src="https://flagcdn.com/24x18/bg.png" srcset="https://flagcdn.com/48x36/bg.png 2x" width="24" height="18" alt="Bulgaria" title="Bulgaria"> <img src="https://flagcdn.com/24x18/hr.png" srcset="https://flagcdn.com/48x36/hr.png 2x" width="24" height="18" alt="Croatia" title="Croatia"> <img src="https://flagcdn.com/24x18/rs.png" srcset="https://flagcdn.com/48x36/rs.png 2x" width="24" height="18" alt="Serbia" title="Serbia"> <img src="https://flagcdn.com/24x18/lt.png" srcset="https://flagcdn.com/48x36/lt.png 2x" width="24" height="18" alt="Lithuania" title="Lithuania"> <img src="https://flagcdn.com/24x18/tw.png" srcset="https://flagcdn.com/48x36/tw.png 2x" width="24" height="18" alt="Taiwan" title="Taiwan"> <img src="https://flagcdn.com/24x18/pt.png" srcset="https://flagcdn.com/48x36/pt.png 2x" width="24" height="18" alt="Portugal" title="Portugal"> <img src="https://flagcdn.com/24x18/ge.png" srcset="https://flagcdn.com/48x36/ge.png 2x" width="24" height="18" alt="Georgia" title="Georgia">

Danh sách đầy đủ các locale nằm trong
[`client/src/i18n/locale-config.ts`](./client/src/i18n/locale-config.ts).

Sáu locale gốc được người thật rà soát; các locale mới hơn được dịch máy
và sẽ tốt dần lên khi người bản ngữ gửi bản sửa — một PR chỉ sửa một chuỗi cũng là
một đóng góp đầu tiên tuyệt vời.

Bản dịch nằm trong [`client/src/i18n/locales/`](./client/src/i18n/locales) dưới dạng
các file JSON phẳng. Để sửa một chuỗi, hãy sửa giá trị trong file JSON của locale đó. Để
thêm một ngôn ngữ, hãy sao chép `en.json`, dịch các giá trị, và đăng ký locale trong
`client/src/i18n/locale-config.ts` (và `desktop/src/i18n.ts` cho các chuỗi trên khay);
`npm test` kiểm tra mọi locale về tính tương đương khóa/placeholder — hoan nghênh các PR.

## Premium (catalog trực tiếp)

Bộ định tuyến tự giữ catalog mô hình của nó luôn mới: nó kéo một catalog đã ký
từ [freellmapi.co](https://freellmapi.co) hai lần mỗi ngày và áp dụng mô hình mới,
thay đổi hạn mức, và các bản sửa điểm kỳ quặc của nhà cung cấp vào DB local của bạn. Các lựa chọn
bật/tắt của riêng bạn và các nhà cung cấp tùy chỉnh không bao giờ bị đụng tới, và mọi
bản tải xuống đều được kiểm chứng với một khóa Ed25519 đã ghim trước khi áp dụng.

Catalog hiện theo dõi **87 nhà cung cấp**, **736 họ mô hình**, **1.313
endpoint nhà cung cấp/mô hình miễn phí** (1.137 chat, 29 hình ảnh, 41 âm thanh, 68 embeddings,
19 chuyển ghi, 6 video, 13 quyết định), và khoảng **10,1 tỷ token mỗi
tháng** năng lực gói miễn phí được liệt kê. Duyệt toàn bộ tại
**[freellmapi.co/models](https://freellmapi.co/models.html)**.

Bản cài đặt miễn phí kéo cùng catalog đã ký đó, nhưng từ bản chụp hằng tháng: một
mô hình gia nhập nó 30 ngày sau khi vào nguồn cấp trực tiếp, nên bản build miễn phí
hiện chậm hơn khoảng 303 mô hình. Không có gì hết hạn và không có gì bị
cắt xén — nó chỉ đến muộn hơn.

Premium giữ catalog đã ký đó luôn trực tiếp trên mọi bộ định tuyến bạn chạy. Khi một nhà cung cấp
ra mắt một mô hình miễn phí mạnh, âm thầm siết hạn mức, hoặc phá vỡ một định dạng wire,
các bộ định tuyến dùng nguồn cấp trực tiếp sẽ nhận bản cập nhật ngay trong ngày chúng tôi phát hành.

**[Dùng bản trực tiếp tại freellmapi.co →](https://freellmapi.co/?utm_source=github&utm_medium=readme&utm_campaign=premium&utm_content=readme_bottom#pricing)**

- $19/năm hoặc $49 một lần, trọn đời. Thanh toán qua Stripe; hủy bất cứ lúc nào, tự phục vụ.
- Một khóa `fla_` bao phủ mọi bộ định tuyến bạn chạy: desktop, homelab, Raspberry Pi.
- Kích hoạt trong bảng điều khiển tại mục **Premium**; hủy hoặc quản lý thanh toán
  tự phục vụ tại [freellmapi.co/manage](https://freellmapi.co/manage).
- Bản thân bộ định tuyến vẫn mang giấy phép MIT và hoàn toàn miễn phí, mãi mãi. Premium chỉ là
  nguồn cấp trực tiếp, và nó là thứ tài trợ cho việc kiểm thử mô hình hằng ngày cùng công tác bảo trì catalog
  giúp catalog luôn hoạt động.

Máy chủ catalog không bao giờ thấy prompt, completion hay khóa nhà cung cấp của bạn — bộ
định tuyến vẫn hoàn toàn tự host theo cả hai cách.

## Sử dụng API

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

response = client.chat.completions.with_raw_response.create(
    model="auto",  # let the router pick; or "auto:fast", "auto:smart", a profile, or a model id
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
completion = response.parse()
print(completion.choices[0].message.content)
print("Routed via:", response.headers.get("x-routed-via"))
```

Streaming, các chiến lược định tuyến `auto:*`, gọi công cụ, đầu vào thị giác, grounding bằng Google Search của Gemini, embeddings, và bề mặt Anthropic Messages — kèm ví dụ curl và Python cho từng mục — tất cả nằm trong **[docs/en/api/01-rest-api.md](docs/en/api/01-rest-api.md)**. Mọi phản hồi đều mang header `X-Routed-Via: <platform>/<model>` để bạn thấy nhà cung cấp nào thực sự đã phục vụ nó.

## Ảnh chụp màn hình

### Mô hình

Chọn một chiến lược định tuyến và xem ngân sách token hằng tháng đầy dần trên toàn bộ đội ngũ nhà cung cấp. Mỗi mô hình hiển thị điểm độ tin cậy, tốc độ và trí tuệ trực tiếp — thứ tự dưới đây là cách các yêu cầu đang được định tuyến ngay lúc này.

![Trang Models](repo-assets/models.png)

### Khóa

Quản lý thông tin xác thực của nhà cung cấp và lấy khóa API hợp nhất mà ứng dụng của bạn kết nối bằng nó. Mỗi khóa hiển thị một chấm trạng thái và thời điểm nó được kiểm tra sức khỏe gần nhất.

![Trang Keys](repo-assets/keys.png)

### Playground

Gửi một chat completion qua bộ định tuyến và xem nhà cung cấp nào đã phục vụ nó, với ID mô hình và độ trễ in ngay trên tin nhắn. Đính kèm file bằng nút bấm, kéo-thả, hoặc dán: hình ảnh (PNG/JPEG/WebP/GIF) được thu nhỏ trong trình duyệt và gửi dưới dạng phần nội dung hình ảnh tới một mô hình có khả năng thị giác, còn file văn bản (TXT/MD/CSV/JSON/LOG) được nhúng thẳng vào prompt dưới dạng khối fenced.

![Trang Playground](repo-assets/playground.png)

### Thống kê phân tích

Khối lượng yêu cầu, tỉ lệ thành công, token vào và ra, độ trễ trung bình, và số liệu tách theo từng nhà cung cấp trên các cửa sổ 24 giờ / 7 ngày / 30 ngày / 90 ngày.

![Trang Analytics](repo-assets/analytics.png)

## Cách hoạt động

![Một yêu cầu vào, mô hình miễn phí tốt nhất ra — chuỗi dự phòng với điểm trực tiếp, thời gian chờ nguội và theo dõi hạn mức](repo-assets/router-flow.png)

Một yêu cầu vào, mô hình miễn phí tốt nhất ra: bộ định tuyến chọn mô hình ưu tiên cao nhất có khóa khỏe mạnh và đang nằm dưới mọi giới hạn tốc độ của nó, giải mã khóa trong bộ nhớ, và gọi nhà cung cấp — khi gặp 429/5xx, nó cho khóa đó chờ nguội và thử lại mô hình tiếp theo trong chuỗi của bạn. Phần dẫn qua từng thành phần, cơ chế định tuyến bên trong và chi tiết vận hành nằm trong **[docs/en/architecture/00-high-level-index.md](docs/en/architecture/00-high-level-index.md)**.

## Câu hỏi thường gặp

**Tôi có cần mật khẩu không?** Không cần với ứng dụng desktop — bảng điều khiển tự đăng nhập bằng một tài khoản local ẩn, nên không có gì phải thiết lập và không có gì để quên. Mở nó từ biểu tượng trên khay → **Open Dashboard**, hoặc trong bất kỳ trình duyệt nào trên cùng máy tính (ví dụ http://127.0.0.1:31415); cả hai đều tự đăng nhập. Một thiết bị khác truy cập ứng dụng qua LAN vẫn sẽ thấy biểu mẫu đăng nhập. Bản cài đặt máy chủ (Docker, một dòng lệnh, `npm run dev`) thì có tài khoản email + mật khẩu.

**Tôi quên mật khẩu trên một bản cài đặt máy chủ.** Nhấn **Forgot password?** ở trang đăng nhập. Không có email nào để gửi liên kết tới, nên mã dùng một lần được in ra log của máy chủ — đọc nó bằng `docker compose logs -f freellmapi` (hoặc trong terminal đang chạy máy chủ, hoặc trong file log của desktop), rồi nhập vào biểu mẫu đặt lại. Mã có hiệu lực 15 phút.

**Log nằm ở đâu?** Trong log container đối với Docker, trong terminal đối với bản chạy từ mã nguồn, và trong `<data dir>/logs/freeapi.log` đối với ứng dụng desktop — tới được từ mục **Open Logs Folder** trong menu khay.

**Làm sao để gỡ cài đặt?** Xóa ứng dụng (Trash trên macOS, *Settings → Apps* trên Windows, `docker compose down -v` đối với Docker), rồi xóa thư mục dữ liệu: `%APPDATA%\FreeLLMAPI\`, `~/Library/Application Support/FreeLLMAPI/`, hoặc `~/.config/FreeLLMAPI/`. Việc gỡ cài đặt không bao giờ tự đụng vào thư mục đó.

Câu trả lời dài hơn, theo từng phương thức cài đặt: **[docs/en/install/01-install.md#faq-passwords-logs-uninstall](docs/en/install/01-install.md#faq-passwords-logs-uninstall)**.

## Hạn chế

Gộp các gói miễn phí có những đánh đổi thật: không có mô hình tiên phong (frontier), độ trễ thất thường, không có SLA — và trí tuệ hiệu dụng của endpoint giảm dần về cuối ngày khi các mô hình hàng đầu chạm trần hằng ngày của chúng, rồi đặt lại vào nửa đêm UTC. Hãy đọc danh sách trung thực trong **[docs/en/architecture/00-high-level-index.md#limitations](docs/en/architecture/00-high-level-index.md#limitations)** trước khi xây bất cứ thứ gì nghiêm túc trên nền tảng này.

## Đóng góp

Rất hoan nghênh người đóng góp! Xem [CONTRIBUTING.md](CONTRIBUTING.md) để biết vòng lặp phát triển, kỳ vọng với PR, và chính sách về đóng góp có hỗ trợ của AI/LLM (bản ngắn: hoan nghênh, cùng một thước đo chất lượng như mọi PR khác). Các PR đầu tiên tốt:

- **Thêm một nhà cung cấp** — sao chép `server/src/providers/openai-compat.ts` làm mẫu, nối nó vào `server/src/providers/index.ts`, gieo dữ liệu mô hình của nó trong `server/src/db/index.ts`, thêm một test trong `server/src/__tests__/providers/`.
- **Thêm một endpoint** — các bề mặt tương thích OpenAI khác (ví dụ `/v1/realtime`). Lớp cơ sở của nhà cung cấp có thể mọc thêm phương thức mới; các adapter khai báo chúng hỗ trợ những gì.
- **Cải thiện bộ định tuyến** — định tuyến có ý thức về chi phí (cân bằng rẻ nhất-khỏe nhất-nhanh nhất), ưu tiên theo trọng số độ trễ tốt hơn, ghim theo khu vực.
- **Đánh bóng bảng điều khiển** — biểu đồ trên trang Analytics, trải nghiệm luân chuyển khóa, nhập khóa hàng loạt từ `.env`.
- **Tài liệu** — thêm ví dụ, đoạn mã thư viện client cho Go/Rust/v.v., một công thức triển khai cho Docker hoặc Fly.

`npm install && npm run dev` cho bạn máy chủ trên :3001 và bảng điều khiển trên :5173, cả hai đều có HMR. Để có một thiết lập lặp lại được, dùng `./scripts/dev-bootstrap.sh` trên Bash hoặc `.\scripts\dev-bootstrap.ps1` trên PowerShell; cả hai đều giữ nguyên `.env` hiện có. PR nên kèm một test, giữ bộ test hiện tại xanh (`npm test`), và khớp với các mặc định `.editorconfig` / tsconfig đã có trong repo. Quy trình migration cơ sở dữ liệu và toàn bộ vòng lặp đóng góp nằm trong [CONTRIBUTING.md](./CONTRIBUTING.md).

### Những người đóng góp

Cảm ơn [@mamehi](https://github.com/mamehi) đã dịch [README sang tiếng Hàn](README.ko.md), và [@eltociear](https://github.com/eltociear) đã dịch nó [sang tiếng Nhật](README.ja.md).

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
<a href="https://github.com/indraoverflow"><img src="https://images.weserv.nl/?url=github.com/indraoverflow.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@indraoverflow" /></a>
<a href="https://github.com/KHKRUTIK"><img src="https://images.weserv.nl/?url=github.com/KHKRUTIK.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@KHKRUTIK" /></a>
<a href="https://github.com/lxymvl"><img src="https://images.weserv.nl/?url=github.com/lxymvl.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@lxymvl" /></a>
<a href="https://github.com/eltociear"><img src="https://images.weserv.nl/?url=github.com/eltociear.png&w=40&h=40&fit=cover&mask=circle" width="40" alt="@eltociear" /></a>

## Tuyên bố miễn trừ trách nhiệm

**Dự án này dành cho thử nghiệm và học tập cá nhân, không dành cho production.** Các gói miễn phí tồn tại để nhà phát triển dựng prototype trên chúng; chúng không phải một nền tảng suy luận ổn định, được hỗ trợ, và không nên được đối xử như vậy. Nếu bạn xây thứ gì thật trên FreeLLMAPI, hãy đổi sang một API trả phí trước khi phát hành. Quan hệ của bạn với mỗi nhà cung cấp upstream được điều chỉnh bởi các điều khoản bạn đã chấp nhận khi tạo tài khoản — những điều khoản đó vẫn áp dụng khi lưu lượng được proxy qua dự án này, và bạn chịu trách nhiệm tuân thủ chúng.

Cách ToS của từng nhà cung cấp nhìn nhận một proxy cá nhân, đơn người dùng — được rà soát theo từng nhà cung cấp vào tháng 5/2026 — nằm trong [docs/en/architecture/00-high-level-index.md#terms-of-service-review](docs/en/architecture/00-high-level-index.md#terms-of-service-review).

## Giấy phép

[MIT](./LICENSE)
