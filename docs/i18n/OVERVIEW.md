# i18n Documentation

## Scope

This directory holds the translated documentation tree: Simplified Chinese and
future locales for the pages a new user reads before they ever clone the repo.
English is the source of truth; every file here is a mirror of an English
original elsewhere in the repository and is expected to lag slightly behind it.

Translation of the dashboard UI strings is a separate concern and lives in
`client/src/i18n/locales/`. The shared terminology rules that apply to both are
in [01-translating.md](01-translating.md).

## Conventions

- **Mirror layout.** One directory per locale (`zh-CN`, `pt-BR`, `fr`, ...).
  Deleting `docs/i18n/<locale>/` from any translated path yields the path of its
  English original, and adding it back yields the translation.
- **Language toggle.** The root README and every translated README carry a
  centered language bar near the top (above the hero screenshot) linking the
  available editions, e.g. `**English** · [简体中文](zh-CN/README.md)`.
  When a locale is added, its link goes into this bar on every README.
- **Translate prose, not markup.** Badges, code blocks, endpoint paths,
  environment variables, and model ids stay untouched; relative asset and doc
  links must be re-pointed for the deeper directory.
- **Honest status.** Pages without a translation link to the English original
  rather than shipping something stale.

## File index

| File | Description |
| --- | --- |
| [README.md](README.md) | Translation workflow: layout mirror, per-locale status table, rules that keep translations maintainable, and what to do when English changes. |
| [zh-CN/](zh-CN/OVERVIEW.md) | Simplified Chinese translations of the core docs. See its [OVERVIEW.md](zh-CN/OVERVIEW.md) for the file index. |

## Related

- [01-translating.md](01-translating.md) - dashboard locale strings and the settled zh-CN terminology table (applies here too).
- Root [README.md](../../README.md) - carries the language-toggle bar linking to these translations.
