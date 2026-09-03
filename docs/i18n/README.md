# Translated documentation

English is the source of truth. Everything in this directory is a translation of
a file that lives elsewhere in the repo, and it is expected to lag a little
behind. That is fine, as long as it is honest about it.

This is separate from the dashboard UI strings, which live in
`client/src/i18n/locales/` and are covered by [01-translating.md](01-translating.md).
Read that file too if you are translating into Chinese, because the terminology
table there applies here as well. A README that calls a provider `提供商` while
the dashboard calls it `提供方` is worse than no translation.

## Layout

One directory per locale, named with the same code the dashboard uses
(`zh-CN`, `pt-BR`, `fr`, and so on):

```
docs/i18n/<locale>/README.md        translation of  /README.md
docs/i18n/<locale>/docs/README.md   translation of  /docs/README.md
docs/i18n/<locale>/docs/install.md  translation of  /docs/install.md
```

The mirror is deliberate. Given any translated file you can find its English
original by deleting `docs/i18n/<locale>/` from the path, and the reverse works
too.

## Status

| Page | zh-CN |
| --- | --- |
| `README.md` | ✅ |
| `docs/README.md` | ✅ |
| `docs/install.md` | ✅ |
| `docs/api/01-rest-api.md` | ✅ |
| `docs/clients/01-agent-clients.md` | English |
| `docs/compression/01-compression-pipeline.md` | English |
| `docs/architecture.md` | English |

Untranslated pages are not a gap to apologise for. Link to the English original
and leave it, rather than shipping a stale translation of a 300-line reference
that someone will trust and act on.

## Adding a language

1. Create `docs/i18n/<locale>/` and translate `README.md` first. It is the page
   almost everyone reads, and on its own it is a complete contribution.
2. Add a link to the language bar at the top of `/README.md`, and to the bar in
   every other translated README.
3. Add a column to the status table above.

## Rules that keep this maintainable

- **Translate prose, not markup.** Badges, HTML tables, image tags, code blocks,
  and CLI commands stay exactly as they are. So do product names, endpoint paths,
  environment variables, and model ids.
- **Fix the relative paths.** A translated README sits three directories deep, so
  `repo-assets/x.png` becomes `../../../repo-assets/x.png` and `docs/api/01-rest-api.md`
  becomes `../../api/01-rest-api.md`. Broken image links are the most common mistake here.
- **Do not copy the contributor avatar list.** It changes with nearly every merge
  and nobody wants to update it in six languages. Keep the heading so the
  section structure still matches one-to-one, and link out to the English
  README from under it.
- **Keep the numbers in sync or leave them out.** Provider counts and token
  totals move. If you are not going to update them, write around them.
- **Match the dashboard.** If a term appears in the UI, use whatever the locale's
  JSON file already uses. Consistency between the README and the app the reader
  is about to open matters more than any individual word choice.

## When English changes

Nothing enforces this automatically, and nothing should: a stale translation is
better than a blocked release. If you change the root README substantially,
open an issue tagged `i18n` so translators know there is work waiting. If you
maintain a translation, watching that label is the easiest way to keep up.
