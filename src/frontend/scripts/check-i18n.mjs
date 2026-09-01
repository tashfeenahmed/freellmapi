import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const localeDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/i18n/locales',
)
const expectedLocales = [
  'en', 'zh-CN', 'es', 'fr', 'pt-BR', 'it', 'hi', 'ar', 'bn', 'ru',
  'ur', 'id', 'de', 'ja', 'sw', 'mr', 'te', 'tr', 'ta', 'vi',
  'ko', 'fa', 'th', 'gu', 'pl', 'uk', 'kn', 'ml', 'or', 'my',
  'pa', 'ro', 'nl', 'ms', 'tl', 'ha', 'yo', 'ig', 'am', 'uz',
  'az', 'si', 'ne', 'km', 'el', 'cs', 'hu', 'sv', 'he', 'da',
  'fi', 'no', 'sk', 'bg', 'hr', 'sr', 'lt', 'zh-TW', 'pt-PT', 'ka',
]

function flatten(value, prefix = '', output = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output)
    }
  } else {
    output.set(prefix, value)
  }
  return output
}

function placeholders(value) {
  if (typeof value !== 'string') return []
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
}

const fileNames = (await readdir(localeDirectory))
  .filter(fileName => fileName.endsWith('.json'))
  .sort()
const actualLocales = fileNames.map(fileName => fileName.slice(0, -5))
const missingFiles = expectedLocales.filter(locale => !actualLocales.includes(locale))
const unexpectedFiles = actualLocales.filter(locale => !expectedLocales.includes(locale))
const errors = []

if (missingFiles.length) errors.push(`Missing locale files: ${missingFiles.join(', ')}`)
if (unexpectedFiles.length) errors.push(`Unexpected locale files: ${unexpectedFiles.join(', ')}`)

const english = JSON.parse(await readFile(path.join(localeDirectory, 'en.json'), 'utf8'))
const englishEntries = flatten(english)
const englishKeys = new Set(englishEntries.keys())

for (const locale of actualLocales) {
  const dictionary = JSON.parse(
    await readFile(path.join(localeDirectory, `${locale}.json`), 'utf8'),
  )
  const entries = flatten(dictionary)
  const keys = new Set(entries.keys())
  const missingKeys = [...englishKeys].filter(key => !keys.has(key))
  const extraKeys = [...keys].filter(key => !englishKeys.has(key))

  if (missingKeys.length) {
    errors.push(`${locale}: missing keys: ${missingKeys.join(', ')}`)
  }
  if (extraKeys.length) {
    errors.push(`${locale}: extra keys: ${extraKeys.join(', ')}`)
  }

  for (const [key, englishValue] of englishEntries) {
    if (!entries.has(key)) continue
    const localizedValue = entries.get(key)
    if (typeof localizedValue !== typeof englishValue) {
      errors.push(`${locale}:${key}: expected ${typeof englishValue}, got ${typeof localizedValue}`)
      continue
    }
    const expectedPlaceholders = placeholders(englishValue)
    const actualPlaceholders = placeholders(localizedValue)
    if (expectedPlaceholders.join(',') !== actualPlaceholders.join(',')) {
      errors.push(
        `${locale}:${key}: placeholders {${actualPlaceholders.join(', ')}} do not match {${expectedPlaceholders.join(', ')}}`,
      )
    }
  }
}

if (errors.length) {
  console.error(`i18n validation failed with ${errors.length} error(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`i18n validation passed for ${actualLocales.length} locales and ${englishKeys.size} keys`)
}
