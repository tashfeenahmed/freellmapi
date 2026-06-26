import './env.js';
import { initDb } from './db/index.js';
import { routeRequest } from './services/router.js';

const db = initDb();
console.log('Preferred model DB id: 108');
const result = routeRequest(8500, new Set(), 108, false, true);
console.log('Route result:', result);

// Let's run the DB query inside routeRequest manually to see what's in the chain!
const chain = db.prepare(`
  SELECT fc.model_db_id, fc.priority, fc.enabled,
         m.platform, m.model_id, m.display_name, m.intelligence_rank,
         m.size_label, m.monthly_token_budget,
         m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
         m.supports_tools, m.context_window, m.key_id
  FROM fallback_config fc
  JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
  WHERE fc.enabled = 1
`).all();

console.log('Total fallback chain models:', chain.length);
const toolModels = chain.filter((m: any) => m.supports_tools === 1);
console.log('Tool-supporting fallback chain models:', toolModels.map((m: any) => `${m.platform}/${m.model_id} (id: ${m.model_db_id})`));

for (const m of toolModels as any[]) {
  const keys = db.prepare(
    "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all(m.platform);
  console.log(`Platform ${m.platform} has ${keys.length} active keys.`);
}
