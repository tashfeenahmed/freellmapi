import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SyntaxHighlighter } from '@/components/SyntaxHighlighter'

const PLACEHOLDER = 'YOUR_API_KEY'
const base = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '')

const examples = [
  {
    lang: 'cURL',
    sections: [
      {
        title: 'Chat completion',
        code: `curl ${base}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${PLACEHOLDER}" \\
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`,
      },
    ],
  },
  {
    lang: 'Python',
    sections: [
      {
        title: 'Basic',
        code: `from openai import OpenAI

client = OpenAI(
    base_url="${base}/v1",
    api_key="${PLACEHOLDER}",
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)

print(response.choices[0].message.content)`,
      },
      {
        title: 'Streaming',
        code: `from openai import OpenAI

client = OpenAI(
    base_url="${base}/v1",
    api_key="${PLACEHOLDER}",
)

stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")`,
      },
    ],
  },
  {
    lang: 'Node.js',
    sections: [
      {
        title: 'Basic',
        code: `import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "${base}/v1",
    apiKey: "${PLACEHOLDER}",
});

const response = await client.chat.completions.create({
    model: "auto",
    messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);`,
      },
      {
        title: 'Streaming',
        code: `import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "${base}/v1",
    apiKey: "${PLACEHOLDER}",
});

const stream = await client.chat.completions.create({
    model: "auto",
    messages: [{ role: "user", content: "Hello!" }],
    stream: true,
});

for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || "");
}`,
      },
    ],
  },
]

function CodeBlock({ title, code, apiKey, lang }: { title: string; code: string; apiKey?: string; lang: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    const text = apiKey ? code.replaceAll(PLACEHOLDER, apiKey) : code
    await navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const displayedCode = apiKey ? code.replaceAll(PLACEHOLDER, apiKey) : code;

  return (
    <div className="px-5 py-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{title}</p>
        <Button variant="ghost" size="xs" onClick={handleCopy}>
          {copied ? (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Copied
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy
            </>
          )}
        </Button>
      </div>
      <pre className="relative text-xs leading-relaxed bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/50 dark:border-zinc-800 p-4 rounded-lg overflow-x-auto whitespace-pre font-mono text-zinc-700 dark:text-zinc-400">
        <code><SyntaxHighlighter code={displayedCode} language={lang} /></code>
      </pre>
    </div>
  )
}

export default function DocsPage() {
  const { data } = useQuery<{ apiKey: string }>({
    queryKey: ['settings', 'api-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const apiKey = data?.apiKey

  return (
    <div>
      <PageHeader
        title="Documentation"
        description="Use FreeLLMAPI with any OpenAI-compatible client by pointing it at this server."
      />

      <div className="space-y-6">
        <Card className="p-5">
          <h2 className="text-sm font-medium mb-2">Authentication</h2>
          <p className="text-sm text-muted-foreground">
            Pass your unified key as a bearer token in the Authorization header.
            The copy button below will insert your real key automatically.
          </p>
        </Card>

        <div className="grid gap-6">
          {examples.map(({ lang, sections }) => (
            <Card key={lang} className="divide-y">
              <div className="px-5 py-3 font-medium text-sm">{lang}</div>
              {sections.map(({ title, code }) => (
                <CodeBlock key={title} title={title} code={code} apiKey={apiKey} lang={lang} />
              ))}
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
