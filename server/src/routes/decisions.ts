import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { listDecisionModels, runDecision, setDecisionModelEnabled, DecisionError } from '../services/decision.js';

// Dashboard: the Models → Decision page. Models come from the catalog's
// decisionModels registry; this lists them with key and usage counts, lets the
// operator switch one off, and runs a test decision from the page.
export const decisionsRouter = Router();

decisionsRouter.get('/models', (_req: Request, res: Response) => {
  res.json(listDecisionModels());
});

const patchSchema = z.object({ enabled: z.boolean() });

decisionsRouter.patch('/models/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid model id' } });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Provide enabled' } });
    return;
  }
  if (!setDecisionModelEnabled(id, parsed.data.enabled)) {
    res.status(404).json({ error: { message: 'Decision model not found' } });
    return;
  }
  res.json(listDecisionModels().find(m => m.id === id));
});

// Per-card "Test": one fixed choice question, pinned to that row. The "Try it"
// box below answers whatever the operator typed and may fall through the chain;
// this answers a constant question against one row, which is the only way to
// tell a working model from a working chain. Pin by row id: two rows can share
// a model id (a custom relay next to its catalog entry).
const TEST_DECISION = {
  state: 'Ordered Tuesday, arrived Thursday. Packaging was clean and nothing was missing.',
  questions: {
    answer: {
      type: 'choice' as const,
      instructions: 'Is this review positive or negative?',
      criteria: { positive: null, negative: null },
    },
  },
};

decisionsRouter.post('/models/:id/test', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid model id' } });
    return;
  }
  if (!listDecisionModels().some(m => m.id === id)) {
    res.status(404).json({ error: { message: 'Decision model not found' } });
    return;
  }
  const started = Date.now();
  try {
    const result = await runDecision(TEST_DECISION, { rowId: id, clientAgent: 'dashboard' });
    res.json({
      success: true,
      model: result.model,
      provider: result.provider,
      latencyMs: Date.now() - started,
      answer: (result.answers.answer as { choice?: string } | undefined)?.choice ?? null,
    });
  } catch (err: any) {
    const status = err instanceof DecisionError ? err.status : 502;
    res.status(status).json({ error: { message: err?.message ?? 'Decision test failed', ...(err?.code ? { code: err.code } : {}) } });
  }
});

// "Try it" on the page: one choice question over the text the user typed.
const trySchema = z.object({
  model: z.string().min(1).optional(),
  state: z.string().min(1).max(20_000),
  question: z.string().min(1).max(2_000),
  options: z.array(z.string().min(1).max(200)).min(2).max(20),
});

decisionsRouter.post('/try', async (req: Request, res: Response) => {
  const parsed = trySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Provide text, a question and at least two options' } });
    return;
  }
  const { model, state, question, options } = parsed.data;
  try {
    const result = await runDecision(
      {
        state,
        questions: {
          answer: { type: 'choice', instructions: question, criteria: Object.fromEntries(options.map(o => [o, null])) },
        },
      },
      { model, clientAgent: 'dashboard' },
    );
    res.json(result);
  } catch (err: any) {
    const status = err instanceof DecisionError ? err.status : 502;
    res.status(status).json({ error: { message: err?.message ?? 'Decision failed', ...(err?.code ? { code: err.code } : {}) } });
  }
});
