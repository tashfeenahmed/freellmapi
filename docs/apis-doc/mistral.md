# mistral
---
title: "Send your first API request"
sidebar_label: "Send your first API request"
sidebar_position: 1
description: Send your first request to the Mistral API and get a model response in ~5 minutes.
---

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

## Send your first API request

Create an API key, install the SDK, and send a chat completion request.

- Install the Python or TypeScript SDK
- Send a request to a Mistral model
- Print the model's response

Everything here is the foundation for the agent and RAG quickstarts that follow.

**Time to complete:** ~5 minutes

<SectionTab as="h2" sectionId="prerequisites">Prerequisites</SectionTab>

- Python 3.9+ **or** Node.js 18+ installed on your machine.
- A Mistral AI account. <AppLink href="https://console.mistral.ai">Create account</AppLink>
- A Mistral API key. The Experiment plan is free — no credit card required. Follow the [Activate Studio and generate an API key](/getting-started/quickstarts/studio/activate-and-generate-api-key) quickstart if you don't have one yet.

<SectionTab as="h2" sectionId="step-1">Step 1: Get your API key</SectionTab>

1. Open <AppLink href="https://console.mistral.ai/api-keys" app="studio">API keys</AppLink>.
2. Click **Create new key**.
3. Give the key a name (for example, `quickstart`) and click **Create**.
4. Copy the key to your clipboard. The key appears only once; if you lose it, generate a new one.
5. Set the key as an environment variable in your terminal:

<Tabs groupId="shell">
  <TabItem value="unix" label="macOS / Linux" default>

```bash
export MISTRAL_API_KEY="your_api_key_here"
```

  </TabItem>
  <TabItem value="windows" label="Windows (PowerShell)">

```powershell
$env:MISTRAL_API_KEY="your_api_key_here"
```

  </TabItem>
</Tabs>

<SectionTab as="h2" sectionId="step-2">Step 2: Install the SDK</SectionTab>

<Tabs groupId="language">
  <TabItem value="python" label="Python" default>

```bash
pip install mistralai
```

  </TabItem>
  <TabItem value="typescript" label="TypeScript">

```bash
npm install @mistralai/mistralai
```

  </TabItem>
</Tabs>

<SectionTab as="h2" sectionId="step-3">Step 3: Send your first request</SectionTab>

Create a file and add the following code:

<Tabs groupId="language">
  <TabItem value="python" label="Python" default>

```python
# quickstart.py
import os
from mistralai import Mistral

client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

response = client.chat.complete(
    model="mistral-large-latest",
    messages=[
        {"role": "user", "content": "What is Mistral AI?"}
    ],
)

print(response.choices[0].message.content)
```

  </TabItem>
  <TabItem value="typescript" label="TypeScript">

```typescript
// quickstart.ts

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

const response = await client.chat.complete({
  model: 'mistral-large-latest',
  messages: [
    { role: 'user', content: 'What is Mistral AI?' }
  ],
});

console.log(response.choices[0].message.content);
```

  </TabItem>
  <TabItem value="curl" label="curl">

```bash
curl https://api.mistral.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -d '{
    "model": "mistral-large-latest",
    "messages": [
      {"role": "user", "content": "What is Mistral AI?"}
    ]
  }'
```

  </TabItem>
</Tabs>

<SectionTab as="h2" sectionId="step-4">Step 4: Run it</SectionTab>

<Tabs groupId="language">
  <TabItem value="python" label="Python" default>

```bash
python quickstart.py
```

  </TabItem>
  <TabItem value="typescript" label="TypeScript">

```bash
npx tsx quickstart.ts
```

  </TabItem>
</Tabs>

<SectionTab as="h2" sectionId="verify">Verify</SectionTab>

The terminal prints a short description of Mistral AI. If it doesn't, check the error table below.

<Table className="mt-6 mb-8">
  <TableHeader>
    <TableRow>
      <TableHead>Error</TableHead>
      <TableHead>Cause</TableHead>
      <TableHead>Fix</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>`401 Unauthorized`</TableCell>
      <TableCell>API key is incorrect or not set</TableCell>
      <TableCell>Run `echo $MISTRAL_API_KEY` to confirm the variable is set</TableCell>
    </TableRow>
    <TableRow>
      <TableCell>`402 Payment Required`</TableCell>
      <TableCell>No payment method on account</TableCell>
      <TableCell>Add one at <AppLink href="https://admin.mistral.ai/organization/billing" app="admin">Subscriptions › Billing</AppLink></TableCell>
    </TableRow>
    <TableRow>
      <TableCell>`429 Too Many Requests`</TableCell>
      <TableCell>Rate limit hit</TableCell>
      <TableCell>Wait and retry with exponential backoff</TableCell>
    </TableRow>
  </TableBody>
</Table>

<SectionTab as="h2" sectionId="whats-next">What's next</SectionTab>

<UsefullLinkContainer>
  <LinkCard href="/getting-started/quickstarts/developer/build-an-agent" title="Build an agent with tools" />
  <LinkCard href="/getting-started/quickstarts/developer/rag-document-search" title="RAG with document search" />
</UsefullLinkContainer>

---
---
title: "Send your first API request"
sidebar_label: "Send your first API request"
sidebar_position: 1
description: Send your first request to the Mistral API and get a model response in ~5 minutes.
---

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

# Send your first API request

Create an API key, install the SDK, and send a chat completion request.

- Install the Python or TypeScript SDK
- Send a request to a Mistral model
- Print the model's response

Everything here is the foundation for the agent and RAG quickstarts that follow.

**Time to complete:** ~5 minutes

<SectionTab as="h2" sectionId="prerequisites">Prerequisites</SectionTab>

- Python 3.9+ **or** Node.js 18+ installed on your machine.
- A Mistral AI account. <AppLink href="https://console.mistral.ai">Create account</AppLink>
- A Mistral API key. The Experiment plan is free — no credit card required. Follow the [Activate Studio and generate an API key](/getting-started/quickstarts/studio/activate-and-generate-api-key) quickstart if you don't have one yet.

<SectionTab as="h2" sectionId="step-1">Step 1: Get your API key</SectionTab>

1. Open <AppLink href="https://console.mistral.ai/api-keys" app="studio">API keys</AppLink>.
2. Click **Create new key**.
3. Give the key a name (for example, `quickstart`) and click **Create**.
4. Copy the key to your clipboard. The key appears only once; if you lose it, generate a new one.
5. Set the key as an environment variable in your terminal:

<Tabs groupId="shell">
  <TabItem value="unix" label="macOS / Linux" default>

```bash
export MISTRAL_API_KEY="your_api_key_here"
```

  </TabItem>
  <TabItem value="windows" label="Windows (PowerShell)">

```powershell
$env:MISTRAL_API_KEY="your_api_key_here"
```

  </TabItem>
</Tabs>

<SectionTab as="h2" sectionId="step-2">Step 2: Install the SDK</SectionTab>

<Tabs groupId="language">
  <TabItem value="python" label="Python" default>

```bash
pip install mistralai
```

  </TabItem>
  <TabItem value="typescript" label="TypeScript">

```bash
npm install @mistralai/mistralai
```

  </TabItem>
</Tabs>

<SectionTab as="h2" sectionId="step-3">Step 3: Send your first request</SectionTab>

Create a file and add the following code:

<Tabs groupId="language">
  <TabItem value="python" label="Python" default>

```python
# quickstart.py
import os
from mistralai import Mistral

client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

response = client.chat.complete(
    model="mistral-large-latest",
    messages=[
        {"role": "user", "content": "What is Mistral AI?"}
    ],
)

print(response.choices[0].message.content)
```

  </TabItem>
  <TabItem value="typescript" label="TypeScript">

```typescript
// quickstart.ts

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

const response = await client.chat.complete({
  model: 'mistral-large-latest',
  messages: [
    { role: 'user', content: 'What is Mistral AI?' }
  ],
});

console.log(response.choices[0].message.content);
```

  </TabItem>
  <TabItem value="curl" label="curl">

```bash
curl https://api.mistral.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -d '{
    "model": "mistral-large-latest",
    "messages": [
      {"role": "user", "content": "What is Mistral AI?"}
    ]
  }'
```

  </TabItem>
</Tabs>

<SectionTab as="h2" sectionId="step-4">Step 4: Run it</SectionTab>

<Tabs groupId="language">
  <TabItem value="python" label="Python" default>

```bash
python quickstart.py
```

  </TabItem>
  <TabItem value="typescript" label="TypeScript">

```bash
npx tsx quickstart.ts
```

  </TabItem>
</Tabs>

<SectionTab as="h2" sectionId="verify">Verify</SectionTab>

The terminal prints a short description of Mistral AI. If it doesn't, check the error table below.

<Table className="mt-6 mb-8">
  <TableHeader>
    <TableRow>
      <TableHead>Error</TableHead>
      <TableHead>Cause</TableHead>
      <TableHead>Fix</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>`401 Unauthorized`</TableCell>
      <TableCell>API key is incorrect or not set</TableCell>
      <TableCell>Run `echo $MISTRAL_API_KEY` to confirm the variable is set</TableCell>
    </TableRow>
    <TableRow>
      <TableCell>`402 Payment Required`</TableCell>
      <TableCell>No payment method on account</TableCell>
      <TableCell>Add one at <AppLink href="https://admin.mistral.ai/organization/billing" app="admin">Subscriptions › Billing</AppLink></TableCell>
    </TableRow>
    <TableRow>
      <TableCell>`429 Too Many Requests`</TableCell>
      <TableCell>Rate limit hit</TableCell>
      <TableCell>Wait and retry with exponential backoff</TableCell>
    </TableRow>
  </TableBody>
</Table>

<SectionTab as="h2" sectionId="whats-next">What's next</SectionTab>

<UsefullLinkContainer>
  <LinkCard href="/getting-started/quickstarts/developer/build-an-agent" title="Build an agent with tools" />
  <LinkCard href="/getting-started/quickstarts/developer/rag-document-search" title="RAG with document search" />
</UsefullLinkContainer>
---