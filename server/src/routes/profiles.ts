/**
 * Express router handles CRUD endpoints for named model fallback profiles.
 * Profiles allow users to maintain different prioritized chains of LLMs.
 * Features include metadata updates, reordering fallback priority, auto-sorting presets,
 * and built-in safety blocks to prevent modification of default settings.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

export const profilesRouter = Router();

const RESERVED_PROFILE_NAMES = [
  'auto', 'smart', 'fast', 'cheap', 'budget',
  'intelligence', 'speed', 'active', 'default',
];

const profileNameSchema = z
  .string()
  .min(1, 'Profile name cannot be empty')
  .max(20, 'Profile name must not exceed 20 characters')
  .regex(
    /^[a-zA-Z0-9-_]+$/,
    'Only Latin letters, digits, hyphens (-) and underscores (_) are allowed'
  )
  .refine(
    (name) => !RESERVED_PROFILE_NAMES.includes(name.toLowerCase()),
    'This name is reserved by the system'
  );

const createSchema = z.object({
  name: profileNameSchema,
  emoji: z.string().max(4).default(''),
  color: z.string().default('#6366f1'),
  sourceProfileId: z.number().optional(),
});

const updateSchema = z.object({
  name: profileNameSchema.optional(),
  emoji: z.string().max(4).optional(),
  color: z.string().optional(),
  is_favorite: z.boolean().optional(),
  sort_order: z.number().optional(),
  auto_sort: z.enum(['intelligence', 'speed', 'budget']).nullable().optional(),
  layout_config: z.string().nullable().optional(),
});

function getId(req: Request): number {
  return parseInt(req.params.id as string);
}

/**
 * GET /api/profiles
 * Fetches all available profiles. 
 * Sorting order: Default profile first -> Favorited profiles -> Custom sorting order.
 */
profilesRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const profiles = db.prepare(`
    SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at
    FROM profiles
    ORDER BY (CASE WHEN type = 'default' THEN 1 ELSE 0 END) DESC, is_favorite DESC, sort_order ASC, id ASC
  `).all();
  res.json(profiles);
});

// GET /api/profiles/active — get the currently active profile id
profilesRouter.get('/active', (_req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  const activeProfileId = row ? (parseInt(row.value) || null) : null;
  res.json({ activeProfileId });
});

// POST /api/profiles/active — set or clear the active profile
profilesRouter.post('/active', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.body?.profileId;

  if (profileId === null || profileId === undefined) {
    db.prepare(`DELETE FROM settings WHERE key = 'active_profile_id'`).run();
    res.json({ activeProfileId: null });
    return;
  }

  const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(Number(profileId)) as any;
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(profileId));
  res.json({ activeProfileId: Number(profileId) });
});

// GET /api/profiles/:id/models — get profile model order
profilesRouter.get('/:id/models', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as any;
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const rows = db.prepare(`
    SELECT pm.model_db_id, pm.priority, pm.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit,
           m.monthly_token_budget
    FROM profile_models pm
    JOIN models m ON m.id = pm.model_db_id
    WHERE pm.profile_id = ? AND m.enabled = 1
    ORDER BY pm.priority ASC
  `).all(profileId);

  // Normalize SQLite 0/1 integers to proper booleans for TypeScript client
  res.json(rows.map((r: any) => ({ ...r, enabled: r.enabled === 1 })));
});

/**
 * POST /api/profiles
 * Creates a new custom profile.
 * Allows optional cloning of the active profile's model priority and layout configuration.
 */
profilesRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const { name, emoji, color, sourceProfileId } = parsed.data;

  // Check for case-insensitive duplicate profile names
  const duplicate = db.prepare('SELECT id FROM profiles WHERE LOWER(name) = LOWER(?)').get(name) as any;
  if (duplicate) {
    res.status(409).json({ error: { message: `Profile with name '${name}' already exists` } });
    return;
  }

  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM profiles').get() as { mx: number }).mx;

  let layoutConfig: string | null = null;
  let autoSort: string | null = null;
  if (sourceProfileId) {
    const source = db.prepare('SELECT layout_config, auto_sort FROM profiles WHERE id = ?').get(sourceProfileId) as any;
    if (source) {
      layoutConfig = source.layout_config;
      autoSort = source.auto_sort;
    }
  }

  const result = db.prepare(
    'INSERT INTO profiles (name, emoji, color, type, sort_order, layout_config, auto_sort) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, emoji, color, 'custom', maxOrder + 1, layoutConfig, autoSort);

  const profileId = result.lastInsertRowid as number;

  if (sourceProfileId) {
    const source = db.prepare('SELECT id FROM profiles WHERE id = ?').get(sourceProfileId) as any;
    if (!source) {
      copyFromDefault(db, profileId);
    } else {
      db.prepare(`
        INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
        SELECT ?, model_db_id, priority, enabled
        FROM profile_models
        WHERE profile_id = ?
        ORDER BY priority ASC
      `).run(profileId, sourceProfileId);
    }
  } else {
    copyFromDefault(db, profileId);
  }

  const created = db.prepare('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = ?').get(profileId);
  res.status(201).json(created);
});

function copyFromDefault(db: any, profileId: number) {
  db.prepare(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    SELECT ?, model_db_id, priority, enabled
    FROM fallback_config
    ORDER BY priority ASC
  `).run(profileId);
}

// PUT /api/profiles/:id — update profile metadata
profilesRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  const profile = db.prepare('SELECT id, type FROM profiles WHERE id = ?').get(profileId) as any;
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  // Check for case-insensitive duplicate profile names when editing name
  if (parsed.data.name !== undefined) {
    const duplicate = db.prepare('SELECT id FROM profiles WHERE LOWER(name) = LOWER(?) AND id != ?').get(parsed.data.name, profileId) as any;
    if (duplicate) {
      res.status(409).json({ error: { message: `Profile with name '${parsed.data.name}' already exists` } });
      return;
    }
  }

  const isProtected = profile.type === 'default' || profile.type === 'builtin';
  const updates: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      // Block name/emoji/color edits on protected profiles
      if (isProtected && (key === 'name' || key === 'emoji' || key === 'color')) {
        continue;
      }
      if (key === 'is_favorite') {
        updates.push('is_favorite = ?');
        values.push(value ? 1 : 0);
      } else {
        updates.push(`${key} = ?`);
        values.push(value);
      }
    }
  }

  if (updates.length > 0) {
    values.push(profileId);
    db.prepare(`UPDATE profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  // If auto_sort was updated to a preset, automatically physically sort the models in DB
  if (parsed.data.auto_sort) {
    sortProfileModels(db, profileId, parsed.data.auto_sort);
  }

  const updated = db.prepare('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = ?').get(profileId);
  res.json(updated);
});

// PUT /api/profiles/:id/reorder — update model order + enabled for a profile
const reorderSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

profilesRouter.put('/:id/reorder', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as any;
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profileId);
    const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');
    for (const entry of parsed.data) {
      insert.run(profileId, entry.modelDbId, entry.priority, entry.enabled ? 1 : 0);
    }
  });
  transaction();

  res.json({ success: true });
});

// POST /api/profiles/:id/reset — reset a profile to fallback baseline
profilesRouter.post('/:id/reset', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as any;
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const baselineLayout = JSON.stringify({
    viewMode: "list",
    compactMode: false,
    limitsMode: false,
    limitsVariant: "circle",
    sortDisabledToBottom: false,
    kanbanLayout: [{ id: "board-default", type: "board", title: "Default", emoji: "📋", color: "rgb(99, 102, 241)", collapsed: false, items: [] }],
    tierLayout: [{ id: "tier-default", type: "tier", title: "Default", emoji: "📋", color: "rgb(99, 102, 241)", collapsed: false, items: [] }]
  });

  const transaction = db.transaction(() => {
    // Reset layout_config and auto_sort
    db.prepare('UPDATE profiles SET layout_config = ?, auto_sort = NULL WHERE id = ?').run(baselineLayout, profileId);
    
    // Copy models priority/enabled from fallback_config
    db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profileId);
    db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      SELECT ?, model_db_id, priority, enabled
      FROM fallback_config
      ORDER BY priority ASC
    `).run(profileId);
  });
  transaction();

  const updated = db.prepare('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = ?').get(profileId);
  res.json(updated);
});

// DELETE /api/profiles/:id — delete a profile
profilesRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  const profile = db.prepare('SELECT id, type FROM profiles WHERE id = ?').get(profileId) as any;
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }
  if (profile.type === 'default' || profile.type === 'builtin') {
    res.status(400).json({ error: { message: 'Cannot delete the default profile' } });
    return;
  }
  const count = db.prepare('SELECT COUNT(*) as cnt FROM profiles').get() as { cnt: number };
  if (count.cnt <= 1) {
    res.status(400).json({ error: { message: 'Cannot delete the last profile' } });
    return;
  }

  // If the deleted profile is the currently active one, switch to Default
  const activeRow = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  const activeId = activeRow ? parseInt(activeRow.value) : null;

  db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);

  if (activeId === profileId) {
    const defaultProf = db.prepare("SELECT id FROM profiles WHERE type = 'default' OR type = 'builtin' ORDER BY id ASC LIMIT 1").get() as { id: number } | undefined;
    const fallbackId = defaultProf?.id ?? (db.prepare('SELECT id FROM profiles ORDER BY sort_order ASC LIMIT 1').get() as { id: number })?.id;
    if (fallbackId) {
      db.prepare(`INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(fallbackId));
    }
  }

  res.json({ success: true });
});

// POST /api/profiles/:id/sort/:preset — sort models in a profile by a preset
const SORT_PRESETS: Record<string, string> = {
  intelligence: 'm.intelligence_rank ASC',
  speed: 'm.speed_rank ASC',
};

function getBudgetScore(m: { monthly_token_budget: string; tpd_limit: number | null }): number {
  if (m.tpd_limit != null) return m.tpd_limit * 30;
  
  const str = m.monthly_token_budget;
  if (!str) return 0;
  if (str.toLowerCase().includes('unlimited') || str.includes('∞')) return Infinity;
  
  const cleanStr = str.split('(')[0];
  const matches = cleanStr.match(/[\d.]+/g);
  let maxNum = 0;
  if (matches) {
    maxNum = Math.max(...matches.map(mStr => parseFloat(mStr)));
  }
  
  let mult = 1;
  const upper = cleanStr.toUpperCase();
  if (upper.includes('B')) mult = 1_000_000_000;
  else if (upper.includes('M')) mult = 1_000_000;
  else if (upper.includes('K')) mult = 1_000;

  return maxNum * mult;
}

function sortProfileModels(db: any, profileId: number, preset: string) {
  let models: { id: number }[] = [];

  if (preset === 'budget') {
    const allModels = db.prepare(`SELECT id, monthly_token_budget, tpd_limit FROM models`).all() as any[];
    allModels.sort((a, b) => getBudgetScore(b) - getBudgetScore(a));
    models = allModels.map(m => ({ id: m.id }));
  } else {
    const orderBy = SORT_PRESETS[preset];
    if (!orderBy) {
      throw new Error(`Unknown preset: ${preset}. Use: intelligence, speed, budget`);
    }
    models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all() as { id: number }[];
  }

  // Preserve existing enabled flags so sorting doesn't reset disabled models
  const existing = db.prepare(`
    SELECT model_db_id, enabled FROM profile_models WHERE profile_id = ?
  `).all(profileId) as { model_db_id: number; enabled: number }[];
  const enabledMap = new Map(existing.map(e => [e.model_db_id, e.enabled]));

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profileId);
    const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < models.length; i++) {
      // Use existing enabled state if available, default to 1 for newly added models
      const enabled = enabledMap.has(models[i].id) ? enabledMap.get(models[i].id) : 1;
      insert.run(profileId, models[i].id, i + 1, enabled);
    }
  });
  transaction();
}

profilesRouter.post('/:id/sort/:preset', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as any;
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const preset = String(req.params.preset);
  
  try {
    sortProfileModels(db, profileId, preset);
    res.json({ success: true, preset });
  } catch (error: any) {
    res.status(400).json({ error: { message: error.message } });
  }
});

// Initialize built-in profiles if they don't exist
export function seedProfiles(db: any): void {
  const count = db.prepare("SELECT COUNT(*) as cnt FROM profiles WHERE type = 'default' OR type = 'builtin'").get() as { cnt: number };
  if (count.cnt > 0) return;

  const builtins: Array<{
    name: string;
    emoji: string;
    color: string;
    profileType: string;
    modelScores: Array<{ namePattern: string; score: number }>;
  }> = [
      {
        name: 'Default',
        emoji: '⭐',
        color: '#6366f1',
        profileType: 'default',
        modelScores: [
          { namePattern: 'gpt-4o', score: 3 },
          { namePattern: 'qwen3-coder', score: 2 },
          { namePattern: 'gemini', score: 1 },
        ],
      }
    ];

  const insertProfile = db.prepare('INSERT INTO profiles (name, emoji, color, type, sort_order) VALUES (?, ?, ?, ?, ?)');
  const insertModel = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');

  const seed = db.transaction(() => {
    for (const builtin of builtins) {
      const result = insertProfile.run(builtin.name, builtin.emoji, builtin.color, builtin.profileType, -1);
      const profileId = result.lastInsertRowid as number;

      const models = db.prepare('SELECT id, LOWER(display_name) as name FROM models ORDER BY id ASC').all() as { id: number; name: string }[];

      const scored = models.map(m => {
        let score = 0;
        for (const s of builtin.modelScores) {
          if (m.name.includes(s.namePattern)) {
            score = s.score;
            break;
          }
        }
        return { ...m, score };
      });

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < scored.length; i++) {
        insertModel.run(profileId, scored[i].id, i + 1, 1);
      }

      // Set the default active profile
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(profileId));
    }
  });
  seed();

  console.log(`Seeded Default profile`);
}