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

// Helper for absolute paths
const resolvePath = (p: string) => path.resolve(p);

// 1. Session state
const activeFiles = new Map<string, string>(); // Absolute path -> filename key
const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

// Default system prompt instructing the model on the structured editing protocol
const systemPrompt = `You are an expert software developer and coding assistant.
You are helping the user modify their codebase.
You can read and modify files that the user has added to the active context.

ACTIVE CONTEXT FILES:
The user will provide the current contents of the active files in their prompt.

To modify a file, you MUST format your response as follows:
FILE_EDIT: <filepath>
\`\`\`
<complete new content of the file>
\`\`\`

Rules for edits:
1. You MUST return the ENTIRE updated content of the file inside the block. Do not use placeholders like "// ... rest of code stays the same ...".
2. If you want to modify multiple files, use multiple separate FILE_EDIT blocks.
3. If you just want to answer a question or explain something without modifying files, output normal text. Do not use the FILE_EDIT header in that case.
4. Always specify the relative or absolute filepath exactly as provided in the context.`;

messages.push({ role: 'system', content: systemPrompt });

// 2. Auto-discover the Unified API Key from SQLite
let apiKey = process.env.FREELLMAPI_KEY || process.env.OPENAI_API_KEY || '';
const dbPath = path.resolve(__dirname, '../../server/data/freeapi.db');

if (!apiKey) {
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
      if (row?.value) {
        apiKey = row.value;
      }
    } catch (err: any) {
      // Silently ignore or fallback
    }
  }
}

if (!apiKey) {
  console.error(pc.red('\n❌ Error: No API key found.'));
  console.error('Please make sure your server has run at least once to generate a key,');
  console.error('or set the FREELLMAPI_KEY environment variable.\n');
  process.exit(1);
}

// 3. Initialize OpenAI SDK
const proxyUrl = process.env.FREELLMAPI_URL || 'http://localhost:3001/v1';
const openai = new OpenAI({
  baseURL: proxyUrl,
  apiKey: apiKey,
});

// Setup Readline Interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Print startup banner
console.log(pc.bold(pc.cyan('\n=============================================')));
console.log(pc.bold(pc.cyan('      FreeLLMAPI Interactive Coder CLI      ')));
console.log(pc.bold(pc.cyan('=============================================')));
console.log('  Commands:');
console.log(`    ${pc.bold('/add <file>')}    - Add a file to the active context`);
console.log(`    ${pc.bold('/remove <file>')} - Remove a file from context`);
console.log(`    ${pc.bold('/context')}       - Show current active files`);
console.log(`    ${pc.bold('/clear')}         - Clear conversation memory`);
console.log(`    ${pc.bold('exit / quit')}    - Exit the chat session`);
console.log(pc.gray('---------------------------------------------'));

// Parse initial arguments (e.g. if started as `npm run cli -- src/index.ts`)
const initialArgs = process.argv.slice(2);
if (initialArgs.length > 0) {
  initialArgs.forEach(fileArg => {
    const absPath = resolvePath(fileArg);
    activeFiles.set(absPath, fileArg);
    console.log(pc.green(`✔ Added file on startup: ${pc.bold(fileArg)}`));
  });
}

// 4. Structured Edit Parser
interface FileEdit {
  filePath: string;
  newContent: string;
}

function parseFileEdits(text: string): { edits: FileEdit[]; explanation: string } {
  const edits: FileEdit[] = [];
  const regex = /FILE_EDIT:\s*([^\n]+)\r?\n```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/g;
  let match;
  let lastIndex = 0;
  let explanation = '';

  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1].trim();
    const newContent = match[2];
    edits.push({ filePath, newContent });

    explanation += text.substring(lastIndex, match.index);
    lastIndex = regex.lastIndex;
  }
  explanation += text.substring(lastIndex);
  return { edits, explanation: explanation.trim() };
}

// 5. Diff Rendering and Application Helper
async function handleFileEdit(edit: FileEdit): Promise<boolean> {
  const targetPath = resolvePath(edit.filePath);
  let originalContent = '';
  const isNew = !fs.existsSync(targetPath);

  if (!isNew) {
    originalContent = fs.readFileSync(targetPath, 'utf8');
  }

  if (originalContent.trim() === edit.newContent.trim()) {
    console.log(pc.yellow(`\nℹ File ${pc.bold(edit.filePath)} is already up to date.`));
    return true;
  }

  console.log(pc.bold(pc.cyan(`\nProposed Changes to: ${pc.bold(edit.filePath)}`)));
  console.log(pc.gray('─'.repeat(50)));

  const changes = diff.diffLines(originalContent, edit.newContent);
  let hasChanges = false;

  changes.forEach((part) => {
    if (part.added || part.removed) {
      hasChanges = true;
      const color = part.added ? pc.green : pc.red;
      const prefix = part.added ? '+' : '-';
      const lines = part.value.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      lines.forEach(line => console.log(color(`${prefix} ${line}`)));
    } else {
      const lines = part.value.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      if (lines.length <= 6) {
        lines.forEach(line => console.log(pc.gray(`  ${line}`)));
      } else {
        for (let i = 0; i < 3; i++) console.log(pc.gray(`  ${lines[i]}`));
        console.log(pc.gray(`  ... [${lines.length - 6} lines unchanged] ...`));
        for (let i = lines.length - 3; i < lines.length; i++) console.log(pc.gray(`  ${lines[i]}`));
      }
    }
  });

  console.log(pc.gray('─'.repeat(50)));

  if (!hasChanges) return true;

  return new Promise((resolve) => {
    rl.question(pc.bold(`Apply changes to ${pc.cyan(edit.filePath)}? (y/N): `), (ans) => {
      if (ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes') {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetPath, edit.newContent, 'utf8');
        console.log(pc.green(`✔ Wrote changes to ${edit.filePath}!`));
        resolve(true);
      } else {
        console.log(pc.yellow(`❌ Changes to ${edit.filePath} skipped.`));
        resolve(false);
      }
    });
  });
}

// 6. Interactive Chat Loop
async function chatLoop() {
  rl.question(pc.bold(pc.cyan('\nChat > ')), async (input) => {
    const trimmedInput = input.trim();
    if (!trimmedInput) {
      return chatLoop();
    }

    const lowerInput = trimmedInput.toLowerCase();

    // Handle Exit
    if (lowerInput === 'exit' || lowerInput === 'quit') {
      console.log(pc.yellow('\nEnding session. Goodbye! 👋\n'));
      rl.close();
      process.exit(0);
    }

    // Command: /add <file>
    if (trimmedInput.startsWith('/add ')) {
      const fileArg = trimmedInput.substring(5).trim();
      if (!fileArg) {
        console.log(pc.red('⚠ Please specify a file path. Example: /add src/App.tsx'));
      } else {
        const absPath = resolvePath(fileArg);
        activeFiles.set(absPath, fileArg);
        console.log(pc.green(`✔ Added file to context: ${pc.bold(fileArg)}`));
      }
      return chatLoop();
    }

    // Command: /remove <file>
    if (trimmedInput.startsWith('/remove ')) {
      const fileArg = trimmedInput.substring(8).trim();
      if (!fileArg) {
        console.log(pc.red('⚠ Please specify a file path. Example: /remove src/App.tsx'));
      } else {
        const absPath = resolvePath(fileArg);
        if (activeFiles.delete(absPath)) {
          console.log(pc.green(`✔ Removed file from context: ${pc.bold(fileArg)}`));
        } else {
          console.log(pc.yellow(`⚠ File was not in context: ${fileArg}`));
        }
      }
      return chatLoop();
    }

    // Command: /context
    if (lowerInput === '/context') {
      console.log(pc.bold('\n--- Monitored Files in Context ---'));
      if (activeFiles.size === 0) {
        console.log(pc.gray('  (No active files. Use "/add <filepath>" to add files)'));
      } else {
        activeFiles.forEach((filename) => {
          console.log(`  • ${pc.cyan(filename)}`);
        });
      }
      console.log(pc.bold('----------------------------------'));
      return chatLoop();
    }

    // Command: /clear
    if (lowerInput === '/clear') {
      messages.length = 0;
      messages.push({ role: 'system', content: systemPrompt });
      console.log(pc.green('✔ Conversation history cleared!'));
      return chatLoop();
    }

    // User Message Processing
    try {
      // Read current contents of files in context
      let filesContext = '';
      if (activeFiles.size > 0) {
        filesContext += '--- ACTIVE FILES CONTEXT ---\n';
        for (const [absPath, filename] of activeFiles) {
          let content = '';
          if (fs.existsSync(absPath)) {
            content = fs.readFileSync(absPath, 'utf8');
          } else {
            content = '[New file - does not exist yet]';
          }
          filesContext += `[File: ${filename}]\n\`\`\`\n${content}\n\`\`\`\n\n`;
        }
        filesContext += '----------------------------\n\n';
      }

      const userContent = `${filesContext}User Prompt: ${trimmedInput}`;
      messages.push({ role: 'user', content: userContent });

      console.log(pc.gray('🤖 Thinking...'));

      const completion = await openai.chat.completions.create({
        model: 'auto', // routes to fallback chain
        messages: messages,
        temperature: 0.1,
      });

      const reply = completion.choices[0].message.content || '';
      messages.push({ role: 'assistant', content: reply });

      // Parse structured edits from response
      const { edits, explanation } = parseFileEdits(reply);

      // Print normal explanation text
      if (explanation) {
        console.log(pc.white(`\n${explanation}`));
      }

      // Handle any proposed file edits sequentially
      if (edits.length > 0) {
        for (const edit of edits) {
          await handleFileEdit(edit);
        }
      }

    } catch (error: any) {
      console.error(pc.red(`\n❌ Error calling LLM: ${error.message}`));
      console.error('Verify your server is running via `npm run dev -w server`.');
    }

    // Loop
    chatLoop();
  });
}

// Start REPL Loop
chatLoop();
