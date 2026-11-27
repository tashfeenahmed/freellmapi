import { z } from 'zod';
import { BUDGET_INPUT_ERROR, normalizeBudgetInput } from './budget.js';

// Zod field for an operator-typed monthly token budget on the create routes
// (POST /api/keys/custom, POST /api/models; #2030). Kept out of budget.ts,
// which must stay free of value imports (module-purity.test.ts).
export const budgetInputSchema = z.string().max(80).transform((s, ctx) => {
  const normalized = normalizeBudgetInput(s);
  if (normalized === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: BUDGET_INPUT_ERROR });
    return z.NEVER;
  }
  return normalized;
});
