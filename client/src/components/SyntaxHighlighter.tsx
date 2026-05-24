import React from 'react';

interface SyntaxHighlighterProps {
  code: string;
  language: string;
}

interface Rule {
  name: string;
  regex: RegExp;
}

// Highly optimized regex rules anchored with ^ for fast sequential matching
const jsRules: Rule[] = [
  { name: 'comment', regex: /^\/\/.*|^\/\*[\s\S]*?\*\// },
  { name: 'string', regex: /^"(?:\\.|[^"\n])*"|^'(?:\\.|[^'\n])*'|^\`(?:\\.|[^`])*\`/ },
  { name: 'number', regex: /^\b0x[a-fA-F0-9]+\b|^\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
  { name: 'jsx-tag', regex: /^<\/?(?:[a-zA-Z_][a-zA-Z0-9_-]*)/ },
  { name: 'jsx-attr', regex: /^\b[a-zA-Z_][a-zA-Z0-9_-]*(?=\s*=)/ },
  { name: 'keyword', regex: /^\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|import|export|from|as|class|extends|new|this|super|typeof|instanceof|void|delete|in|of|try|catch|finally|throw|async|await|yield|type|interface|enum|public|private|protected|readonly|static|get|set|keyof|any|unknown|never|string|number|boolean|symbol|object|true|false|null|undefined)\b/ },
  { name: 'builtin', regex: /^\b(?:console|process|window|document|Promise|Error|Map|Set|JSON|Object|Array|String|Number|Boolean|Function|Math|setTimeout|setInterval)\b/ },
  { name: 'type', regex: /^\b[A-Z][a-zA-Z0-9_]*\b/ },
  { name: 'function', regex: /^\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/ },
  { name: 'operator', regex: /^=>|^&&|^\|\||^[-+*/%=<>!&|^~?:]+/ },
  { name: 'punctuation', regex: /^[\{\}\[\]\(\)\.,;]/ },
];

const pythonRules: Rule[] = [
  { name: 'comment', regex: /^#.*/ },
  { name: 'string', regex: /^"""[\s\S]*?"""|^'''[\s\S]*?'''|^"(?:\\.|[^"\n])*"|^'(?:\\.|[^'\n])*'/ },
  { name: 'number', regex: /^\b\d+(?:\.\d+)?\b/ },
  { name: 'decorator', regex: /^@[a-zA-Z_][a-zA-Z0-9_.]*/ },
  { name: 'keyword', regex: /^\b(?:def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|in|is|not|and|or|lambda|try|except|finally|raise|assert|with|yield|global|nonlocal|del|None|True|False)\b/ },
  { name: 'builtin', regex: /^\b(?:print|len|range|str|int|float|list|dict|set|tuple|open|type|isinstance|sum|min|max|abs|round|enumerate|zip|map|filter|any|all)\b/ },
  { name: 'type', regex: /^\b[A-Z][a-zA-Z0-9_]*\b/ },
  { name: 'function', regex: /^\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/ },
  { name: 'operator', regex: /^[-+*/%=<>!&|^~]+/ },
  { name: 'punctuation', regex: /^[:.,;()\[\]{}]/ },
];

const bashRules: Rule[] = [
  { name: 'comment', regex: /^#.*/ },
  { name: 'string', regex: /^"(?:\\.|[^"\n])*"|^'(?:\\.|[^'\n])*'/ },
  { name: 'number', regex: /^\b\d+(?:\.\d+)?\b/ },
  { name: 'option', regex: /^-\w+|^--[\w-]+/ },
  { name: 'command', regex: /^\b(?:curl|bash|sh|echo|cat|grep|awk|sed|sudo|mkdir|cd|ls|rm|cp|mv|chmod|chown|export|alias|if|then|else|fi|for|in|do|done|while)\b/ },
  { name: 'variable', regex: /^\$[a-zA-Z_][a-zA-Z0-9_]*|^\$\{[a-zA-Z_][a-zA-Z0-9_]*\}/ },
  { name: 'operator', regex: /^&&|^\|\||^\\|^;|^=/ },
  { name: 'punctuation', regex: /^[\(\)\[\]]/ },
];

const jsonRules: Rule[] = [
  { name: 'property', regex: /^"(?:\\.|[^"\n])*"\s*(?=:)/ },
  { name: 'string', regex: /^"(?:\\.|[^"\n])*"/ },
  { name: 'number', regex: /^\b\d+(?:\.\d+)?\b/ },
  { name: 'keyword', regex: /^\b(?:true|false|null)\b/ },
  { name: 'punctuation', regex: /^[\{\}\[\]:,]/ },
];

const sqlRules: Rule[] = [
  { name: 'comment', regex: /^--.*|^\/\*[\s\S]*?\*\// },
  { name: 'string', regex: /^"(?:\\.|[^"\n])*"|^'(?:\\.|[^'\n])*'/ },
  { name: 'number', regex: /^\b\d+(?:\.\d+)?\b/ },
  { name: 'keyword', regex: /^\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|AND|OR|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|HAVING|ORDER|LIMIT|OFFSET|CREATE|TABLE|ALTER|DROP|INDEX|INTO|VALUES|SET|IN|LIKE|IS|NULL|NOT|EXISTS|AS|COUNT|SUM|AVG|MIN|MAX|HAVING|UNION|ALL|ANY|CASE|WHEN|THEN|ELSE|END)\b/i },
  { name: 'operator', regex: /^[-+*/%=<>!&|^~]+/ },
  { name: 'punctuation', regex: /^[,.();]/ },
];

const htmlRules: Rule[] = [
  { name: 'comment', regex: /^<!--[\s\S]*?-->/ },
  { name: 'tag', regex: /^<\/?(?:[a-zA-Z0-9:-]+)/ },
  { name: 'attr-name', regex: /^\b[a-zA-Z0-9:-]+(?=\s*=)/ },
  { name: 'string', regex: /^"(?:\\.|[^"\n])*"|^'(?:\\.|[^'\n])*'/ },
  { name: 'operator', regex: /^\/?>|^=/ },
  { name: 'punctuation', regex: /^[\{\}\(\)\[\];,]/ },
];

const cssRules: Rule[] = [
  { name: 'comment', regex: /^\/\*[\s\S]*?\*\// },
  { name: 'selector', regex: /^[^\{\};:\/\s][^\{\};:\/]*(?=\s*\{)/ },
  { name: 'property', regex: /^[a-zA-Z-]+(?=\s*:)/ },
  { name: 'value', regex: /^:\s*([^;\}]+)/ },
  { name: 'punctuation', regex: /^[\{\};:]/ },
];

const generalRules: Rule[] = [
  { name: 'comment', regex: /^\/\/.*|^\/\*[\s\S]*?\*\/|^#.*/ },
  { name: 'string', regex: /^"(?:\\.|[^"\n])*"|^'(?:\\.|[^'\n])*'|^\`(?:\\.|[^`])*\`/ },
  { name: 'number', regex: /^\b\d+(?:\.\d+)?\b/ },
  { name: 'keyword', regex: /^\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|import|export|from|as|class|extends|new|this|super|typeof|instanceof|void|delete|in|of|try|catch|finally|throw|async|await|yield|type|interface|enum|def|class|print|len|range|str|int|float|list|dict|set|tuple|open|select|insert|update|delete|from|where|and|or|true|false|null|undefined)\b/i },
  { name: 'operator', regex: /^=>|^&&|^\|\||^[-+*/%=<>!&|^~?:]+/ },
  { name: 'punctuation', regex: /^[\{\}\[\]\(\)\.,;]/ },
];

function getRulesForLanguage(lang: string): Rule[] {
  switch (lang.toLowerCase()) {
    case 'javascript':
    case 'js':
    case 'typescript':
    case 'ts':
    case 'jsx':
    case 'tsx':
    case 'node':
    case 'node.js':
      return jsRules;
    case 'python':
    case 'py':
      return pythonRules;
    case 'bash':
    case 'sh':
    case 'shell':
    case 'curl':
      return bashRules;
    case 'json':
      return jsonRules;
    case 'sql':
      return sqlRules;
    case 'html':
    case 'xml':
      return htmlRules;
    case 'css':
      return cssRules;
    default:
      return generalRules;
  }
}

// Map token name to aesthetic tailwind CSS styles
const tokenStyles: Record<string, string> = {
  comment: 'text-zinc-400 dark:text-zinc-500 italic',
  string: 'text-emerald-600 dark:text-emerald-400',
  number: 'text-amber-600 dark:text-amber-400',
  keyword: 'text-indigo-600 dark:text-indigo-400 font-semibold',
  builtin: 'text-teal-600 dark:text-teal-400',
  type: 'text-sky-600 dark:text-sky-400',
  function: 'text-blue-600 dark:text-blue-400',
  operator: 'text-zinc-500 dark:text-zinc-400',
  punctuation: 'text-zinc-400 dark:text-zinc-500',
  option: 'text-rose-600 dark:text-rose-400',
  command: 'text-indigo-600 dark:text-indigo-400 font-semibold',
  variable: 'text-violet-600 dark:text-violet-400',
  property: 'text-violet-600 dark:text-violet-400 font-semibold',
  tag: 'text-blue-600 dark:text-blue-400',
  'jsx-tag': 'text-blue-600 dark:text-blue-400',
  'jsx-attr': 'text-teal-600 dark:text-teal-400',
  'attr-name': 'text-teal-600 dark:text-teal-400',
  selector: 'text-rose-600 dark:text-rose-400 font-semibold',
  value: 'text-zinc-800 dark:text-zinc-200',
  decorator: 'text-amber-600 dark:text-amber-400 italic',
};

interface Token {
  type: string;
  text: string;
}

export function tokenize(code: string, language: string): Token[] {
  const rules = getRulesForLanguage(language);
  const tokens: Token[] = [];
  let index = 0;
  const len = code.length;

  while (index < len) {
    let matched = false;
    const remaining = code.slice(index);

    for (const rule of rules) {
      const match = remaining.match(rule.regex);
      if (match && match.index === 0) {
        tokens.push({
          type: rule.name,
          text: match[0],
        });
        index += match[0].length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      const char = code[index];
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && lastToken.type === 'text') {
        lastToken.text += char;
      } else {
        tokens.push({ type: 'text', text: char });
      }
      index++;
    }
  }

  return tokens;
}

export function SyntaxHighlighter({ code, language }: SyntaxHighlighterProps) {
  const tokens = tokenize(code, language);

  return (
    <>
      {tokens.map((token, i) => {
        const styleClass = tokenStyles[token.type];
        if (styleClass) {
          return (
            <span key={i} className={styleClass}>
              {token.text}
            </span>
          );
        }
        return <React.Fragment key={i}>{token.text}</React.Fragment>;
      })}
    </>
  );
}
