/// <reference types="vitest/globals" />
/// <reference types="@testing-library/jest-dom" />

// Augment Vitest's Assertion with the jest-dom matchers so `toBeInTheDocument`
// etc. type-check in *.test.ts(x) files.
import '@testing-library/jest-dom/vitest'
