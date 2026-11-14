import fs from 'node:fs';
import readline from 'node:readline/promises';

const BASE = (process.env.FREELLMAPI_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const FILE = 'generated/free-models/openrouter.json';
const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

function validateCatalog(data) {
  if (data.activation !== 'manual-review-required') {
    throw new Error('Unexpected catalog activation mode.');
  }

  if (!Array.isArray(data.models) || data.models.length !== 14) {
    throw new Error('Expected exactly 14 catalog models.');
  }

  for (const model of data.models) {
    if (
      typeof model.id !== 'string' ||
      !model.id.endsWith(':free') ||
      typeof model.name !== 'string' ||
      !Number.isInteger(model.context_length) ||
      !Array.isArray(model.input_modalities) ||
      model.pricing?.prompt !== '0' ||
      model.pricing?.completion !== '0' ||
      !model.output_modalities?.includes('text')
    ) {
      throw new Error('Catalog validation failed for: ' + (model.id || 'unknown model'));
    }
  }
}

async function request(path, options = {}) {
  const response = await fetch(BASE + path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(20000),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `${path} returned HTTP ${response.status}: ` +
      (body.error?.message || body.message || 'Request failed')
    );
  }

  return body;
}

async function hiddenPassword() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('A real interactive Termux terminal is required for hidden password input.');
  }

  process.stdout.write('Dashboard password (hidden): ');

  return new Promise((resolve, reject) => {
    let value = '';
    const input = process.stdin;

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
    };

    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }

        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }

        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else if (char >= ' ') {
          value += char;
        }
      }
    };

    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  validateCatalog(catalog);

  console.log('\nOpenRouter Free Model Importer');
  console.log('Server:', BASE);
  console.log('Catalog models:', catalog.models.length);
  console.log('Mode:', APPLY ? 'APPLY' : VERIFY ? 'VERIFY' : 'DRY RUN');
  console.log('All imported models will remain disabled.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const email = await rl.question('Dashboard email: ');
  rl.close();

  const password = await hiddenPassword();

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  const token = login.token;
  if (!token) throw new Error('Login did not return a session token.');

  const existing = await request('/api/models', { token });

  if (!Array.isArray(existing)) {
    throw new Error('Unexpected response from GET /api/models.');
  }

  if (VERIFY) {
    const ids = [
      'nvidia/nemotron-3.5-super-vl:free',
      'recursive/flint-v1.0:free',
      'thinkingmachines/inkling-small:free',
      'thinkingmachines/inkling:free',
      'xingchen-agi/xing4.0-29b-a4b:free'
    ];

    const results = ids.map(modelId => {
      const model = existing.find(m =>
        m.platform === 'openrouter' && m.modelId === modelId
      );

      return {
        model: modelId,
        enabled: model?.enabled ?? 'MISSING',
        fallbackEnabled: model?.fallbackEnabled ?? 'MISSING',
        status: !model ? 'MISSING' :
          !model.enabled && !model.fallbackEnabled ? 'SAFE' : 'CHECK'
      };
    });

    console.table(results);
    console.log('Safely disabled:', results.filter(r => r.status === 'SAFE').length + '/5');
    return;
  }

  const known = new Set(
    existing.map(model => `${model.platform}/${model.modelId}`)
  );

  const pending = catalog.models.filter(
    model => !known.has(`openrouter/${model.id}`)
  );


  console.log('\nCatalog review:');

  for (const model of catalog.models) {
    const exists = known.has(`openrouter/${model.id}`);
    console.log(`${exists ? '[EXISTS]' : '[NEW]   '} ${model.id}`);
  }

  console.log(`\nAlready present: ${catalog.models.length - pending.length}`);
  console.log(`New models: ${pending.length}`);

  if (!APPLY) {
    console.log('\nDRY RUN complete. No models were created.');
    console.log('Use --apply only when you are ready to import.');
    return;
  }

  if (pending.length === 0) {
    console.log('\nNothing to import.');
    return;
  }

  const confirm = await (async () => {
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await prompt.question('\nType IMPORT to add these disabled models: ');
    prompt.close();
    return answer;
  })();

  if (confirm !== 'IMPORT') {
    console.log('Cancelled. No models were created.');
    return;
  }

  let added = 0;
  let failed = 0;

  for (const model of pending) {
    const payload = {
      platform: 'openrouter',
      modelId: model.id,
      displayName: model.name,
      contextWindow: model.context_length,
      supportsVision: model.input_modalities.includes('image'),
      supportsTools: false,
      enabled: false,
      fallbackEnabled: false,
    };

    try {
      await request('/api/models', {
        method: 'POST',
        token,
        body: JSON.stringify(payload),
      });

      added++;
      console.log('[ADDED - DISABLED] ' + model.id);
    } catch (error) {
      failed++;
      console.error('[FAILED] ' + model.id + ': ' + error.message);
    }
  }

  console.log('\nImport finished.');
  console.log('Added:', added);
  console.log('Failed:', failed);
  console.log('Models were requested with enabled=false and fallbackEnabled=false.');
}

main().catch(error => {
  console.error('\nImporter stopped:', error.message);
  process.exitCode = 1;
});
