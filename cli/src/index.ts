import { OpenAI } from 'openai';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import * as diff from 'diff';
import pc from 'picocolors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. CLI Usage & Argument Parsing
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log(pc.bold(pc.cyan('\n  FreeLLMAPI Coder CLI (POC)\n')));
  console.log('  Usage:');
  console.log(`    npm run cli -- <file_path> <instructions>`);
  console.log('\n  Example:');
  console.log(`    npm run cli -- src/App.tsx "add a comments to the main component"\n`);
  process.exit(1);
}

const targetFilePath = path.resolve(args[0]);
const instructions = args[1];

// 2. Auto-discover the Unified API Key from the SQLite Database
let apiKey = process.env.FREELLMAPI_KEY || process.env.OPENAI_API_KEY || '';
const dbPath = path.resolve(__dirname, '../../server/data/freeapi.db');

if (!apiKey) {
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
      if (row?.value) {
        apiKey = row.value;
        console.log(pc.green(`✔ Auto-discovered unified API key from local database.`));
      }
    } catch (err: any) {
      console.log(pc.yellow(`⚠ Database found, but failed to read key: ${err.message}`));
    }
  }
}

if (!apiKey) {
  console.error(pc.red('\n❌ Error: No API key found.'));
  console.error('Please make sure your server has run at least once to generate a key,');
  console.error('or set the FREELLMAPI_KEY environment variable.\n');
  process.exit(1);
}

// 3. Read the Target File
let originalContent = '';
let isNewFile = false;

if (fs.existsSync(targetFilePath)) {
  originalContent = fs.readFileSync(targetFilePath, 'utf8');
} else {
  isNewFile = true;
  console.log(pc.yellow(`⚠ Target file does not exist. It will be created: ${targetFilePath}`));
}

// 4. Initialize OpenAI SDK pointing to your local proxy
const proxyUrl = process.env.FREELLMAPI_URL || 'http://localhost:3001/v1';
const openai = new OpenAI({
  baseURL: proxyUrl,
  apiKey: apiKey,
});

console.log(pc.cyan(`\n🤖 Sending request to ${proxyUrl} using virtual 'auto' model...`));

async function run() {
  try {
    const systemPrompt = `You are a precise coding assistant. Your task is to modify the provided file content based on the user's instructions.
IMPORTANT rules to follow:
1. You MUST return ONLY the final, complete updated content of the file.
2. Do NOT wrap the file in a markdown code block (like \`\`\`typescript ... \`\`\`) unless the file itself is a markdown file. Return the raw content of the file directly.
3. Keep all formatting, comments, and style consistent with the original file.`;

    const userMessage = isNewFile 
      ? `Instructions: ${instructions}\n\n[The file is currently empty/new]` 
      : `Original File Content:\n\`\`\`\n${originalContent}\n\`\`\`\n\nInstructions: ${instructions}`;

    const completion = await openai.chat.completions.create({
      model: 'auto', // leverages freellmapi's automatic fallback router
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.1,
    });

    let suggestion = completion.choices[0].message.content || '';

    // Clean up any stray code blocks if the model wrapped it anyway (common behavior for some LLMs)
    if (suggestion.startsWith('```')) {
      const lines = suggestion.split('\n');
      if (lines[0].startsWith('```')) {
        lines.shift();
      }
      if (lines[lines.length - 1].startsWith('```')) {
        lines.pop();
      }
      suggestion = lines.join('\n');
    }

    if (suggestion.trim() === originalContent.trim() && !isNewFile) {
      console.log(pc.yellow('\nℹ No changes suggested by the model.'));
      process.exit(0);
    }

    // 5. Generate and Display Diff
    console.log(pc.bold(pc.cyan('\nProposed Changes:')));
    console.log(pc.gray('─'.repeat(40)));

    const changes = diff.diffLines(originalContent, suggestion);
    
    // We will show a condensed diff to not overwhelm the console
    let hasChanges = false;
    changes.forEach((part) => {
      if (part.added || part.removed) {
        hasChanges = true;
        const color = part.added ? pc.green : pc.red;
        const prefix = part.added ? '+' : '-';
        const lines = part.value.split('\n');
        // Handle trailing newline
        if (lines[lines.length - 1] === '') lines.pop();
        lines.forEach(line => {
          console.log(color(`${prefix} ${line}`));
        });
      } else {
        // Show a few context lines for unchanged code block
        const lines = part.value.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        
        if (lines.length <= 6) {
          lines.forEach(line => console.log(pc.gray(`  ${line}`)));
        } else {
          // Print first 3 and last 3 lines
          for (let i = 0; i < 3; i++) {
            console.log(pc.gray(`  ${lines[i]}`));
          }
          console.log(pc.gray(`  ... [${lines.length - 6} lines unchanged] ...`));
          for (let i = lines.length - 3; i < lines.length; i++) {
            console.log(pc.gray(`  ${lines[i]}`));
          }
        }
      }
    });

    console.log(pc.gray('─'.repeat(40)));

    if (!hasChanges && !isNewFile) {
      console.log(pc.yellow('\nNo changes found after diff parsing.'));
      process.exit(0);
    }

    // 6. Interactive Confirmation
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(pc.bold('\nApply these changes? (y/N): '), (answer) => {
      rl.close();
      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        const dir = path.dirname(targetFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetFilePath, suggestion, 'utf8');
        console.log(pc.green(`\n✔ Successfully wrote changes to ${targetFilePath}!\n`));
      } else {
        console.log(pc.yellow('\n❌ Changes cancelled.\n'));
      }
      process.exit(0);
    });

  } catch (error: any) {
    console.error(pc.red(`\n❌ API Error: ${error.message}`));
    console.error('Make sure your local freellmapi server is running (npm run dev).');
    process.exit(1);
  }
}

run();
