// Compute per-directory coverage from v8 coverage-final.json
// Usage: node scripts/coverage-summary.js <path-to-coverage-final.json>
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('usage: node coverage-summary.js <coverage-final.json>'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const files = Object.keys(data);

function summarize() {
  const totals = {};
  for (const f of files) {
    const c = data[f];
    const stmts = Object.keys(c.s).length;
    const covered = Object.values(c.s).filter(v => v > 0).length;
    const fn = Object.keys(c.f).length;
    const fnCovered = Object.values(c.f).filter(v => v > 0).length;
    const branch = Object.values(c.b).reduce((a, arr) => a + arr.length, 0);
    const branchCovered = Object.values(c.b).reduce((a, arr) => a + arr.filter(v => v > 0).length, 0);
    const lines = Object.keys(c.statementMap).length;
    const lineCovered = Object.values(c.s).filter(v => v > 0).length;
    totals[f] = { stmts, covered, fn, fnCovered, branch, branchCovered, lines, lineCovered };
  }
  return totals;
}

const totals = summarize();
const filesSorted = Object.keys(totals).sort();

// Aggregate by top dirs
const dirAgg = {};
for (const f of filesSorted) {
  // e.g. /home/.../client/src/pages/KeysPage.tsx -> src/pages
  const parts = f.split('/');
  let dir = 'other';
  const srcIdx = parts.indexOf('src');
  if (srcIdx !== -1) {
    const rel = parts.slice(srcIdx + 1);
    dir = rel.length > 1 ? `src/${rel[0]}` : 'src/';
  } else if (f.includes('client/dev')) dir = 'dev';
  else if (f.includes('client/dist')) dir = 'dist';
  else if (f.includes('vitest.config')) dir = 'configs';
  else if (f.includes('vite.config')) dir = 'configs';
  else if (f.includes('eslint.config')) dir = 'configs';
  if (!dirAgg[dir]) dirAgg[dir] = { stmts: 0, covered: 0, fn: 0, fnCovered: 0, branch: 0, branchCovered: 0 };
  const t = totals[f];
  dirAgg[dir].stmts += t.stmts; dirAgg[dir].covered += t.covered;
  dirAgg[dir].fn += t.fn; dirAgg[dir].fnCovered += t.fnCovered;
  dirAgg[dir].branch += t.branch; dirAgg[dir].branchCovered += t.branchCovered;
}

console.log('=== Per-directory summary ===');
for (const [d, t] of Object.entries(dirAgg).sort((a, b) => (a[1].covered / a[1].stmts) - (b[1].covered / b[1].stmts))) {
  const pct = t.stmts ? ((t.covered / t.stmts) * 100).toFixed(1) : '0';
  console.log(`${d.padEnd(12)} stmts ${String(t.stmts).padStart(5)} cov ${String(t.covered).padStart(5)}  ${pct}%`);
}

console.log('\n=== Worst 15 files ===');
const byPct = filesSorted
  .map(f => ({ f, ...totals[f] }))
  .filter(t => t.stmts >= 5)
  .sort((a, b) => (a.covered / a.stmts) - (b.covered / b.stmts));
for (const t of byPct.slice(0, 15)) {
  const pct = ((t.covered / t.stmts) * 100).toFixed(1);
  const short = t.f.split('/').slice(-3).join('/');
  console.log(`${pct.padStart(5)}%  ${String(t.stmts).padStart(5)} stmts  ${short}`);
}

const all = Object.values(totals).reduce((a, t) => {
  a.stmts += t.stmts; a.covered += t.covered; a.fn += t.fn; a.fnCovered += t.fnCovered;
  a.branch += t.branch; a.branchCovered += t.branchCovered;
  return a;
}, { stmts: 0, covered: 0, fn: 0, fnCovered: 0, branch: 0, branchCovered: 0 });
console.log(`\n=== ALL (incl configs/dist) === ${((all.covered / all.stmts) * 100).toFixed(1)}% stmts`);

// src-only
const srcOnly = filesSorted.filter(f => f.includes('/src/')).reduce((a, f) => {
  const t = totals[f]; a.stmts += t.stmts; a.covered += t.covered;
  a.fn += t.fn; a.fnCovered += t.fnCovered; a.branch += t.branch; a.branchCovered += t.branchCovered;
  return a;
}, { stmts: 0, covered: 0, fn: 0, fnCovered: 0, branch: 0, branchCovered: 0 });
console.log(`=== SRC ONLY === ${((srcOnly.covered / srcOnly.stmts) * 100).toFixed(1)}% stmts (${srcOnly.covered}/${srcOnly.stmts})`);
