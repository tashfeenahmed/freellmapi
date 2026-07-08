// Valid task types for auxiliary model chains.
// Must stay in sync with the client TASK_TYPES in AuxiliaryPage.tsx.
const VALID_TASK_TYPES = [
  'vision',
  'coding',
  'webextract',
  'videogen',
  'tts',
  'imagegeneration',
  'compression',
  'general',
  'skillhub',
] as const;

export function getValidTaskTypes(): string[] {
  return [...VALID_TASK_TYPES];
}

export function isValidTaskType(type: string): boolean {
  return (VALID_TASK_TYPES as readonly string[]).includes(type);
}
