# Translating

The dashboard ships 60 locales under `client/src/i18n/locales/`. `en.json` is the source of
truth: every other file mirrors its key structure exactly.

Translating the README and the docs pages is a separate job with its own layout and rules,
covered in [i18n/README.md](README.md). The terminology table below applies to both.

## Before you open a PR

- Never add or remove keys in a locale file on its own. If a string needs to exist, it starts
  in `en.json` and every locale follows.
- Run the validator from `client/`:

  ```bash
  npm run check:i18n
  ```

  It checks all 60 locales for key parity, value types, and matching `{placeholder}` names.
  It does not check whether the translation is any good, so read your diff too.
- Keep a PR to one locale where you can. A 60-file diff is very hard to review.
- Translate the meaning, not the words. If an English string is ambiguous, look at where it
  renders before guessing.

## Chinese terminology

The zh-CN terms below were settled in [#669](https://github.com/tashfeenahmed/freellmapi/pull/669)
after a long review. They are written down so the next pass does not relitigate them. If you
want to change one, bring a reason that is stronger than preference: a standards body, a
reference product, or a real ambiguity in the current wording.

| English | zh-CN | Notes |
| --- | --- | --- |
| Provider | 提供方 | Not 提供商. Custom endpoints, local Ollama, and community-run instances are not vendors. |
| Token (LLM) | 词元 | The [national standard term](https://termonline.cn). See the note below. |
| Token (auth, API keys, URL tokens) | 令牌 | Never 词元. These are credentials, not word units. |
| Coding | 编程 | Not 编码, which reads as "encoding". |
| Export | 导出 | Not 出口, which is the shipping sense. |
| Request size | 请求大小 | Not 请求数据量, which reads as an aggregate across many requests. |
| Request body | 请求正文 | What Google Cloud and Cloudflare use in their own Chinese docs. 请求体 is commoner in speech and is not wrong, but use 请求正文 here. |
| Revoke | 撤销 | Not 废除, which is closer to repealing a law. |
| Playground | 试验台 | It is a bench for testing models. Not 试玩台, where 试玩 suggests a game demo. |
| Balance (the custom preset) | 权衡 | The numeric sliders themselves are 权重. |
| you (second person) | 您 | Not 你. Settled in [#723](https://github.com/tashfeenahmed/freellmapi/pull/723) by unifying all 19 mixed keys; the file had been switching register mid-sentence. Dropping the pronoun entirely is still better where the sentence reads naturally without it. |
| English (the UI language) | 英文 | Not 英语. 语 is the spoken tongue; an interface toggle is about written text, and its sibling label is 中文. |

The strategy presets are comparative, so they keep 最: 最快, 最稳定, 最智能.

Punctuation is full-width (，。：；), and Chinese terms do not take Latin-style spaces around
them. Latin words and numbers embedded in Chinese text do take a space on each side, as in
`API 令牌`.

### On 词元

This one has real dissent on the record and is worth understanding before you touch it.
词元 is the term the national sci-tech terminology committee publishes, and it is unambiguous
next to 令牌 for auth credentials, which the file previously confused. Against that, most
Chinese AI products still show `Token` in Latin in their own interfaces, so 词元 will look
formal to some users.

It is decided, not unnoticed. Changing it means changing roughly 25 strings, so raise it as an
issue first rather than folding it into an unrelated PR.

## zh-TW is not zh-CN

zh-TW diverges on purpose and should not be synced to zh-CN term for term:

| English | zh-TW |
| --- | --- |
| Token | `Token`, left in Latin |
| Provider | 提供者 |
| Playground | 遊樂場 |

Taiwanese technical writing keeps far more Latin than mainland writing does. If you are
updating one of the two files, check the other for the same string, but match the local
convention rather than making them identical.
