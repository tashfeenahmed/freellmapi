import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { SyntaxHighlighter } from './SyntaxHighlighter';

interface MarkdownRendererProps {
  content: string;
}

interface Block {
  type: 'code' | 'heading' | 'ul' | 'ol' | 'paragraph' | 'table';
  level?: number;
  language?: string;
  content: string | string[] | { headers: string[]; rows: string[][] };
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-4 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden bg-zinc-50 dark:bg-zinc-900/60 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      {/* Code Header Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100/50 dark:bg-zinc-950/40 select-none">
        <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 tracking-wider uppercase">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 rounded bg-white hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 text-[10px] font-semibold text-zinc-600 dark:text-zinc-400 cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-all"
        >
          {copied ? (
            <>
              <Check className="size-3 text-emerald-600 dark:text-emerald-500 animate-in zoom-in-95 duration-100" />
              <span className="text-emerald-600 dark:text-emerald-500">Copied</span>
            </>
          ) : (
            <>
              <Copy className="size-3 text-zinc-400" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code Area */}
      <div className="p-4 overflow-x-auto">
        <pre className="font-mono text-[12.5px] text-zinc-800 dark:text-zinc-200 leading-relaxed">
          <code><SyntaxHighlighter code={code} language={language} /></code>
        </pre>
      </div>
    </div>
  );
}

function renderInline(text: string): React.ReactNode[] {
  // Regex to capture bold (**text**), italic (*text*), and inline code (`code`)
  const regex = /(\*\*.*?\*\*|\*.*?\*|`.*?`)/g;
  const tokens = text.split(regex);

  return tokens.map((token, i) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      return (
        <strong key={i} className="font-bold text-zinc-900 dark:text-zinc-50">
          {token.slice(2, -2)}
        </strong>
      );
    }
    if (token.startsWith('*') && token.endsWith('*')) {
      return (
        <em key={i} className="italic text-zinc-800 dark:text-zinc-200">
          {token.slice(1, -1)}
        </em>
      );
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code
          key={i}
          className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/50 dark:border-zinc-700/50 font-mono text-[11.5px] text-rose-600 dark:text-rose-450 font-semibold"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    return token;
  });
}

function parseMarkdownToBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let currentBlock: Block | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block detection
    if (line.trim().startsWith('```')) {
      if (currentBlock && currentBlock.type === 'code') {
        blocks.push(currentBlock);
        currentBlock = null;
      } else {
        if (currentBlock) {
          blocks.push(currentBlock);
        }
        const lang = line.trim().slice(3).trim();
        currentBlock = {
          type: 'code',
          language: lang || 'text',
          content: '',
        };
      }
      continue;
    }

    // Inside a code block
    if (currentBlock && currentBlock.type === 'code') {
      currentBlock.content = currentBlock.content
        ? (currentBlock.content as string) + '\n' + line
        : line;
      continue;
    }

    const trimmed = line.trim();

    // Table detection
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cols = trimmed.slice(1, -1).split('|').map(c => c.trim());
      const isSeparator = cols.every(c => /^:?-+:?$/.test(c) || c === '');

      if (isSeparator) {
        if (currentBlock && currentBlock.type === 'table') {
          continue;
        }
      }

      if (currentBlock && currentBlock.type === 'table') {
        const tableData = currentBlock.content as { headers: string[]; rows: string[][] };
        tableData.rows.push(cols);
        continue;
      } else if (!isSeparator) {
        if (currentBlock) {
          blocks.push(currentBlock);
        }
        currentBlock = {
          type: 'table',
          content: {
            headers: cols,
            rows: [],
          },
        };
        continue;
      }
    }

    // Empty line separates paragraphs
    if (trimmed === '') {
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
      continue;
    }

    // Heading detection
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      currentBlock = null;
      continue;
    }

    // Unordered List detection
    const ulMatch = line.match(/^([*\-–])\s+(.+)$/);
    if (ulMatch) {
      if (currentBlock && currentBlock.type === 'ul') {
        (currentBlock.content as string[]).push(ulMatch[2]);
      } else {
        if (currentBlock) {
          blocks.push(currentBlock);
        }
        currentBlock = {
          type: 'ul',
          content: [ulMatch[2]],
        };
      }
      continue;
    }

    // Ordered List detection
    const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      if (currentBlock && currentBlock.type === 'ol') {
        (currentBlock.content as string[]).push(olMatch[2]);
      } else {
        if (currentBlock) {
          blocks.push(currentBlock);
        }
        currentBlock = {
          type: 'ol',
          content: [olMatch[2]],
        };
      }
      continue;
    }

    // Standard paragraph line addition
    if (currentBlock && currentBlock.type === 'paragraph') {
      currentBlock.content = (currentBlock.content as string) + '\n' + trimmed;
    } else {
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      currentBlock = {
        type: 'paragraph',
        content: trimmed,
      };
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock);
  }

  return blocks;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const blocks = parseMarkdownToBlocks(content || '');

  return (
    <div className="space-y-2 select-text">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'code':
            return (
              <CodeBlock
                key={idx}
                code={block.content as string}
                language={block.language || 'text'}
              />
            );

          case 'heading': {
            const level = block.level ?? 3;
            const headingContent = renderInline(block.content as string);
            
            if (level === 1) {
              return (
                <h1 key={idx} className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mt-5 mb-2.5">
                  {headingContent}
                </h1>
              );
            }
            if (level === 2) {
              return (
                <h2 key={idx} className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mt-4.5 mb-2">
                  {headingContent}
                </h2>
              );
            }
            if (level === 3) {
              return (
                <h3 key={idx} className="text-lg font-bold text-zinc-850 dark:text-zinc-100 mt-4 mb-1.5">
                  {headingContent}
                </h3>
              );
            }
            if (level === 4) {
              return (
                <h4 key={idx} className="text-base font-semibold text-zinc-800 dark:text-zinc-200 mt-3.5 mb-1.5">
                  {headingContent}
                </h4>
              );
            }
            if (level === 5) {
              return (
                <h5 key={idx} className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 mt-3 mb-1">
                  {headingContent}
                </h5>
              );
            }
            return (
              <h6 key={idx} className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 mt-2.5 mb-1">
                {headingContent}
              </h6>
            );
          }

          case 'ul':
            return (
              <ul key={idx} className="list-disc pl-5 my-2.5 space-y-1 text-zinc-800 dark:text-zinc-200">
                {(block.content as string[]).map((item, itemIdx) => (
                  <li key={itemIdx} className="leading-relaxed">
                    {renderInline(item)}
                  </li>
                ))}
              </ul>
            );

          case 'ol':
            return (
              <ol key={idx} className="list-decimal pl-5 my-2.5 space-y-1 text-zinc-800 dark:text-zinc-200">
                {(block.content as string[]).map((item, itemIdx) => (
                  <li key={itemIdx} className="leading-relaxed">
                    {renderInline(item)}
                  </li>
                ))}
              </ol>
            );

          case 'table': {
            const { headers, rows } = block.content as { headers: string[]; rows: string[][] };
            return (
              <div key={idx} className="my-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-[0_1px_2px_rgba(0,0,0,0.02)] bg-white dark:bg-zinc-950">
                <table className="w-full border-collapse text-left text-xs select-text">
                  <thead>
                    <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 font-semibold text-zinc-700 dark:text-zinc-300">
                      {headers.map((h, hIdx) => (
                        <th key={hIdx} className="px-4 py-2.5 font-bold uppercase tracking-wider text-[10px]">
                          {renderInline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800 text-zinc-800 dark:text-zinc-200">
                    {rows.map((row, rIdx) => (
                      <tr key={rIdx} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30 transition-colors">
                        {row.map((cell, cIdx) => (
                          <td key={cIdx} className="px-4 py-2.5 whitespace-nowrap">
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }

          case 'paragraph':
          default:
            return (
              <p key={idx} className="my-2.5 leading-relaxed text-zinc-800 dark:text-zinc-200">
                {renderInline(block.content as string)}
              </p>
            );
        }
      })}
    </div>
  );
}
