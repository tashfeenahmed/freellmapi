import { getActiveRegistry } from './router-registry.js';
import { isUnifyEnabled, getModelGroups } from './model-groups.js';
import { hasUsableKeyForModel } from './router.js';

export interface NormalizedModel {
  id: string;
  name: string;
  ownedBy: string;
  available: number;
  enabled: number;
  contextWindow: number | null;
  intel: number;
  platforms: string[];
  supportsTools: boolean;
  executionStatus: 'ready' | 'needsKey' | 'exhausted';
}

export interface ModelListing {
  models: NormalizedModel[];
  autoContextWindow: number | null;
}

function executionStatusFor(modelDbIds: number[], available: number): 'ready' | 'needsKey' | 'exhausted' {
  if (available !== 1) return 'needsKey';
  return modelDbIds.some(id => hasUsableKeyForModel(id)) ? 'ready' : 'exhausted';
}

export function buildModelListing(): ModelListing {
  const reg = getActiveRegistry();
  const allModels = reg.getAllModels();

  let allListed: NormalizedModel[];

  if (isUnifyEnabled()) {
    const byId = new Map(
      allModels.map(m => {
        const creds = reg.getCredentialsForProvider(m.providerId);
        const available = m.enabled && creds.some(c => c.enabled && c.runtime.circuitState !== 'DISABLED') ? 1 : 0;
        return [m.id, { ...m, available }];
      })
    );

    allListed = getModelGroups().map(g => {
      const infos = g.members
        .map(mem => byId.get(mem.model_db_id))
        .filter(Boolean) as Array<(typeof allModels)[0] & { available: number }>;
      const ctxs = infos.map(i => i.contextWindow).filter((c): c is number => c != null);
      const available = infos.some(i => i.available === 1) ? 1 : 0;
      return {
        id: g.canonicalId,
        name: g.groupLabel,
        ownedBy: 'freellmapi',
        available,
        enabled: infos.some(i => i.enabled) ? 1 : 0,
        contextWindow: ctxs.length ? Math.max(...ctxs) : null,
        intel: infos.length ? Math.min(...infos.map(i => i.priority)) : Number.MAX_SAFE_INTEGER,
        platforms: [...new Set(infos.map(i => i.providerKey))],
        supportsTools: infos.some(i => i.capabilities.tools),
        executionStatus: executionStatusFor(g.members.map(m => m.model_db_id), available),
      };
    });
  } else {
    const modelMap = new Map<string, NormalizedModel & { rawPriority: number }>();
    for (const m of allModels) {
      const creds = reg.getCredentialsForProvider(m.providerId);
      const available = m.enabled && creds.some(c => c.enabled && c.runtime.circuitState !== 'DISABLED') ? 1 : 0;
      const execStatus = executionStatusFor([m.id], available);

      const existing = modelMap.get(m.modelId);
      if (!existing || available > existing.available || m.priority > existing.rawPriority) {
        modelMap.set(m.modelId, {
          id: m.modelId,
          name: m.displayName || m.modelId,
          ownedBy: m.providerKey,
          available,
          enabled: m.enabled ? 1 : 0,
          contextWindow: m.contextWindow,
          intel: m.priority,
          rawPriority: m.priority,
          platforms: [m.providerKey],
          supportsTools: m.capabilities.tools,
          executionStatus: execStatus,
        });
      }
    }
    allListed = Array.from(modelMap.values());
  }

  allListed.sort(
    (a, b) =>
      b.available - a.available ||
      b.enabled - a.enabled ||
      b.intel - a.intel ||
      a.name.localeCompare(b.name)
  );

  const availableContextWindows = allListed
    .filter(m => m.available === 1 && m.contextWindow != null)
    .map(m => m.contextWindow as number);
  const autoContextWindow = availableContextWindows.length > 0 ? Math.max(...availableContextWindows) : null;

  return { models: allListed, autoContextWindow };
}
