#!/usr/bin/env node
// ============================================================================
// Rate Limiter Delay Feature Test Script
// ============================================================================
// Usage:
//   1. Start both server instances:
//      - main branch: npm run build && npm run start  (defaults to port 3000)
//      - throttler-branch: npm run build && npm run start -- --port 3001
//
//   2. Run this script against MAIN branch:
//      BASE_URL=http://localhost:3002 UNIFIED_API_KEY=freellmapi-0c75cab56b3ed6818e6f0fc4c15fda2264cabf153168a262 node test/test-throttler.js
//
//   3. Run this script against THROTTLER branch:
//      BASE_URL=http://localhost:3001 UNIFIED_API_KEY=freellmapi-0c75cab56b3ed6818e6f0fc4c15fda2264cabf153168a262 node test/test-throttler.js
//
//   4. Compare the results - throttler branch should have fewer 429s
//
// The script saves results to stats-output.json when SAVE_STATS=1
// ============================================================================

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'freellmapi-test-key';
const UNIFIED_API_KEY = process.env.UNIFIED_API_KEY || '';

// Test configuration
const CONFIG = {
  // Number of requests per test phase
  burstSize: 15,           // Send burst to test RPM limit (gemma4 = 10 RPM)
  sustainedSize: 30,        // Sustained requests over time
  burstConcurrency: 3,      // How many concurrent requests in burst
  sustainedConcurrency: 1,  // Concurrency for sustained test

  // Delays between requests (ms)
  burstDelay: 50,           // Delay between burst requests
  sustainedDelay: 1000,     // 1 second between sustained requests

  // Model/provider to test
  // Use a provider with tight limits for meaningful results
  // Use Claude Code model names (opus, sonnet, haiku) if configured for rerouting,
  // or use "auto" for auto-select, or direct model names
  testCases: [
    // Option 1: Use Claude Code model names (requires freellmapi config to reroute)
    // These names get rerouted to: opus→gemma-4-26b-a4b-it, sonnet→deepseek-ai/deepseek-v4-flash, haiku→llama-3.3-70b-versatile
    // { model: 'opus', provider: 'google', description: 'Claude Code opus → Google (10 RPM, 1000 RPD)' },
    // { model: 'sonnet', provider: 'openrouter', description: 'Claude Code sonnet → DeepSeek (via OpenRouter)' },
    // { model: 'haiku', provider: 'groq', description: 'Claude Code haiku → Groq (30 RPM)' },
    // Option 2: Use auto-select (let the system choose based on routing rules)
    { model: 'auto', provider: 'auto', description: 'Auto-select best available model' },
    // Option 3: Direct model names (if not using Claude Code rerouting)
    // { model: 'gemma-4-26b-a4b-it', provider: 'google', description: 'Google AI Studio (10 RPM, 1000 RPD)' },
    // { model: 'deepseek-v4-flash', provider: 'deepseek', description: 'DeepSeek Flash' },
    // { model: 'llama-3.1-8b-instant', provider: 'groq', description: 'Groq (30 RPM)' },
  ],

  // Request payload
  payload: {
    messages: [{ role: 'user', content: 'Say "test" and nothing else.' }],
    max_tokens: 10,
    temperature: 0.1,
  },

  // Timeout for each request (ms)
  timeout: 30000,
};

// Statistics tracking
class TestStats {
  constructor(name) {
    this.name = name;
    this.total = 0;
    this.success = 0;
    this.rateLimited = 0;  // 429
    this.authErrors = 0;   // 401
    this.serverErrors = 0; // 5xx
    this.clientErrors = 0; // 4xx (not 429)
    this.timeouts = 0;
    this.otherErrors = 0;
    this.latencies = [];
    this.startTime = null;
    this.endTime = null;
  }

  addResult(status, latency, error = null) {
    this.total++;
    this.latencies.push(latency);

    if (status === 0 && error?.code === 'ETIMEDOUT') {
      this.timeouts++;
    } else if (status === 200 || status === 201) {
      this.success++;
    } else if (status === 429) {
      this.rateLimited++;
    } else if (status === 401) {
      this.authErrors++;
    } else if (status >= 500) {
      this.serverErrors++;
    } else if (status >= 400) {
      this.clientErrors++;
    } else {
      this.otherErrors++;
    }
  }

  getStats() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const sum = this.latencies.reduce((a, b) => a + b, 0);
    const avg = this.latencies.length > 0 ? sum / this.latencies.length : 0;
    const duration = this.endTime && this.startTime
      ? (this.endTime - this.startTime) / 1000
      : 0;

    return {
      name: this.name,
      total: this.total,
      success: this.success,
      rateLimited: this.rateLimited,
      authErrors: this.authErrors,
      serverErrors: this.serverErrors,
      clientErrors: this.clientErrors,
      timeouts: this.timeouts,
      otherErrors: this.otherErrors,
      avgLatency: Math.round(avg),
      p50Latency: sorted[Math.floor(sorted.length * 0.5)] || 0,
      p95Latency: sorted[Math.floor(sorted.length * 0.95)] || 0,
      p99Latency: sorted[Math.floor(sorted.length * 0.99)] || 0,
      duration: Math.round(duration * 10) / 10,
      requestsPerSecond: duration > 0 ? (this.total / duration).toFixed(2) : 'N/A',
      successRate: this.total > 0 ? ((this.success / this.total) * 100).toFixed(1) : '0',
    };
  }

  print() {
    const s = this.getStats();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 ${s.name}`);
    console.log('='.repeat(60));
    console.log(`Total Requests:    ${s.total}`);
    console.log(`✅ Success:        ${s.success} (${s.successRate}%)`);
    console.log(`⏳ Rate Limited:   ${s.rateLimited}`);
    console.log(`🔒 Auth Errors:    ${s.authErrors}`);
    console.log(`🔥 Server Errors:  ${s.serverErrors}`);
    console.log(`⚠️  Client Errors:  ${s.clientErrors}`);
    console.log(`⏰ Timeouts:        ${s.timeouts}`);
    console.log(`❓ Other:           ${s.otherErrors}`);
    console.log('-'.repeat(60));
    console.log(`Avg Latency:       ${s.avgLatency}ms`);
    console.log(`P50 Latency:       ${s.p50Latency}ms`);
    console.log(`P95 Latency:       ${s.p95Latency}ms`);
    console.log(`P99 Latency:       ${s.p99Latency}ms`);
    console.log(`Duration:          ${s.duration}s`);
    console.log(`Requests/sec:      ${s.requestsPerSecond}`);
    console.log('='.repeat(60));
  }
}

// Simple async queue with concurrency limit
class AsyncQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.running++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this.running--;
          this.process();
        });
    }
  }
}

// Make a single request
async function makeRequest(url, headers, payload, timeout) {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latency = Date.now() - start;

    // Try to read response body (even for errors)
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return {
      status: response.status,
      latency,
      data,
      error: null,
    };
  } catch (err) {
    const latency = Date.now() - start;
    return {
      status: 0,
      latency,
      data: null,
      error: err,
    };
  }
}

// Check if error indicates model not found/routed
function isModelNotFoundError(data) {
  if (!data) return false;
  const msg = (data.error?.message || data.error?.error?.message || '').toLowerCase();
  return msg.includes('not found') || msg.includes('model not found') || msg.includes('unknown model');
}

// Test a burst of concurrent requests
async function testBurst(stats, url, headers, payload, size, concurrency, delayBetween) {
  const queue = new AsyncQueue(concurrency);
  const promises = [];

  for (let i = 0; i < size; i++) {
    promises.push(
      queue.add(async () => {
        const result = await makeRequest(url, headers, payload, CONFIG.timeout);
        stats.addResult(result.status, result.latency, result.error);

        if (delayBetween > 0 && i < size - 1) {
          await new Promise(r => setTimeout(r, delayBetween));
        }
      })
    );
  }

  await Promise.all(promises);
}

// Test sustained requests with delay between each
async function testSustained(stats, url, headers, payload, size, delay) {
  for (let i = 0; i < size; i++) {
    const result = await makeRequest(url, headers, payload, CONFIG.timeout);
    stats.addResult(result.status, result.latency, result.error);

    if (delay > 0 && i < size - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Run all tests for a single model
async function testModel(stats, model, provider) {
  const url = `${BASE_URL}/v1/chat/completions`;

  const headers = {
  };

  // For unified API key
  if (UNIFIED_API_KEY) {
    headers['x-api-key'] = UNIFIED_API_KEY;
  }

  const payload = {
    ...CONFIG.payload,
    model: model,
  };

  console.log(`\nTesting ${model} (${provider})...`);

  // Phase 1: Burst test - send multiple requests quickly
  console.log(`  Phase 1: Burst test (${CONFIG.burstSize} requests, concurrency ${CONFIG.burstConcurrency})`);

  // First, verify the model works with a single request
  let modelVerified = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await makeRequest(url, headers, payload, CONFIG.timeout);
    stats.addResult(result.status, result.latency, result.error);

    if (result.status === 200) {
      modelVerified = true;
      break;
    } else if (isModelNotFoundError(result.data)) {
      console.log(`    ⚠️  Model '${model}' not found/routed. Skipping...`);
      return; // Skip this model
    }
    // Retry on other errors (could be transient)
    if (attempt < 2) {
      console.log(`    ⚠️  Request failed (${result.status}), retrying...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!modelVerified) {
    console.log(`    ❌ Model verification failed for ${model}. Skipping remaining phases.`);
    return;
  }

  // Now run the actual burst test (remaining requests from burstSize - 1 already sent)
  console.log(`    ✅ Model verified, running burst test...`);
  await testBurst(stats, url, headers, payload, CONFIG.burstSize - 1, CONFIG.burstConcurrency, CONFIG.burstDelay);

  // Phase 2: Sustained test - send requests with 1s delay
  console.log(`  Phase 2: Sustained test (${CONFIG.sustainedSize} requests, 1s delay)`);
  await testSustained(stats, url, headers, payload, CONFIG.sustainedSize, CONFIG.sustainedDelay);
}

// Print comparison between two stats objects
function printComparison(statsMain, statsThrottler) {
  const m = statsMain.getStats();
  const t = statsThrottler.getStats();

  const rateLimitDiff = m.rateLimited - t.rateLimited;
  const successRateDiff = parseFloat(t.successRate) - parseFloat(m.successRate);

  console.log('\n' + '='.repeat(70));
  console.log('📈 COMPARISON: Main vs Throttler');
  console.log('='.repeat(70));
  console.log(`${'Metric'.padEnd(25)} ${'Main'.padEnd(15)} ${'Throttler'.padEnd(15)} Difference`);
  console.log('-'.repeat(70));
  console.log(`${'Total Requests'.padEnd(25)} ${String(m.total).padEnd(15)} ${String(t.total).padEnd(15)} -`);
  console.log(`${'Success Rate (%)'.padEnd(25)} ${m.successRate.padEnd(15)} ${t.successRate.padEnd(15)} ${successRateDiff >= 0 ? '+' : ''}${successRateDiff.toFixed(1)}`);
  console.log(`${'Rate Limited (429)'.padEnd(25)} ${String(m.rateLimited).padEnd(15)} ${String(t.rateLimited).padEnd(15)} ${rateLimitDiff >= 0 ? '-' : '+'}${Math.abs(rateLimitDiff)}`);
  console.log(`${'Avg Latency (ms)'.padEnd(25)} ${String(m.avgLatency).padEnd(15)} ${String(t.avgLatency).padEnd(15)} ${t.avgLatency - m.avgLatency >= 0 ? '+' : ''}${t.avgLatency - m.avgLatency}`);
  console.log(`${'P95 Latency (ms)'.padEnd(25)} ${String(m.p95Latency).padEnd(15)} ${String(t.p95Latency).padEnd(15)} ${t.p95Latency - m.p95Latency >= 0 ? '+' : ''}${t.p95Latency - m.p95Latency}`);
  console.log('-'.repeat(70));

  if (rateLimitDiff > 0) {
    console.log('✅ THROTTLER REDUCED 429s by', rateLimitDiff);
  } else if (rateLimitDiff < 0) {
    console.log('⚠️  THROTTLER HAD', Math.abs(rateLimitDiff), 'MORE 429s (unexpected)');
  } else {
    console.log('➖ NO DIFFERENCE in 429s');
  }

  if (successRateDiff > 0) {
    console.log('✅ THROTTLER INCREASED SUCCESS RATE by', successRateDiff.toFixed(1), '%');
  } else if (successRateDiff < 0) {
    console.log('⚠️  THROTTLER DECREASED SUCCESS RATE by', Math.abs(successRateDiff).toFixed(1), '%');
  }

  console.log('='.repeat(70));

  // Verdict
  if (rateLimitDiff > 0 && successRateDiff > 0) {
    console.log('\n🎉 VERDICT: Throttler feature is WORKING as expected!');
    console.log('   - Fewer rate limit errors (429)');
    console.log('   - Higher success rate');
  } else if (rateLimitDiff <= 0 && successRateDiff >= 0) {
    console.log('\n👍 THROTTLER: No regression, may be helping');
  } else {
    console.log('\n❌ VERDICT: Unexpected results - review configuration and logs');
  }
}

// Main test runner
async function runTests() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║         Rate Limiter Delay Feature Test Suite                       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nTarget URL: ${BASE_URL}`);
  console.log(`Using Unified API Key: ${UNIFIED_API_KEY ? 'Yes' : 'No (using Bearer token)'}`);
  console.log(`Test Config:`);
  console.log(`  - Burst size: ${CONFIG.burstSize} requests`);
  console.log(`  - Sustained size: ${CONFIG.sustainedSize} requests`);
  console.log(`  - Burst concurrency: ${CONFIG.burstConcurrency}`);
  console.log(`  - Burst delay: ${CONFIG.burstDelay}ms`);
  console.log(`  - Sustained delay: ${CONFIG.sustainedDelay}ms`);

  const overallStats = new TestStats('Overall Results');

  // Create stats for each test case
  const testStats = [];

  for (const tc of CONFIG.testCases) {
    const stats = new TestStats(`${tc.model} (${tc.provider})`);
    stats.startTime = Date.now();

    try {
      await testModel(stats, tc.model, tc.provider);
    } catch (err) {
      console.error(`Error testing ${tc.model}:`, err.message);
      stats.addResult(0, 0, err);
    }

    stats.endTime = Date.now();
    testStats.push(stats);
    stats.print();

    // Aggregate into overall
    overallStats.total += stats.total;
    overallStats.success += stats.success;
    overallStats.rateLimited += stats.rateLimited;
    overallStats.authErrors += stats.authErrors;
    overallStats.serverErrors += stats.serverErrors;
    overallStats.clientErrors += stats.clientErrors;
    overallStats.timeouts += stats.timeouts;
    overallStats.otherErrors += stats.otherErrors;
    overallStats.latencies.push(...stats.latencies);
  }

  if (!overallStats.startTime) {
    overallStats.startTime = Date.now();
  }
  overallStats.endTime = Date.now();

  overallStats.print();

  // Save stats if requested
  if (process.env.SAVE_STATS) {
    const fs = require('fs');
    fs.writeFileSync('stats-output.json', JSON.stringify({
      timestamp: new Date().toISOString(),
      baseUrl: BASE_URL,
      stats: overallStats.getStats(),
      testDetails: testStats.map(s => s.getStats()),
    }, null, 2));
    console.log('\n📁 Saved stats to stats-output.json');
  }

  return overallStats;
}

// Run tests
runTests()
  .then(stats => {
    console.log('\n✅ Test suite completed');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Test suite failed:', err);
    process.exit(1);
  });