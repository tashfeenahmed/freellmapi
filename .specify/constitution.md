# FreeLLMAPI Constitution

## Core Principles

### I. Feature-First Development
Every feature starts with a specification. Specs describe **what** and **why**, not **how**. Technical implementation details belong in plans, not specs.

### II. Backward Compatibility
Existing API endpoints and response shapes MUST NOT change unless explicitly agreed. New features add endpoints, they don't modify existing ones, unless strictly required.

### III. Testing First (NON-NEGOTIABLE)
Server routes MUST have integration tests via the existing supertest + vitest pattern. Frontend changes MUST be verified via Playwright scenarios. Existing test suite must remain green.

### IV. Agent-Executed QA
Every task MUST include executable QA scenarios (curl, Playwright, tmux). NO acceptance criteria requiring human manual testing. Evidence captured to `.omo/evidence/`.

### V. Matching Codebase Conventions
New code MUST follow the patterns established in existing files: shadcn-style UI components (using @base-ui/react), Express route patterns, shared type definitions, test structure.

## Technology Stack
- Frontend: React + Vite + shadcn/ui (backed by @base-ui/react)
- Backend: Express + better-sqlite3 + multer
- Testing: vitest (server) + Playwright (client)
- API keys: AES-256-GCM encryption before SQLite storage

## Development Workflow
1. Feature specification → stored in `.specify/specs/`
2. Technical plan → stored in `.omo/plans/`
3. Implementation via task execution
4. Review: plan compliance, code quality, QA, scope fidelity

## Governance
This constitution supersedes ad-hoc development practices. Amendments require documentation and approval.

**Version**: 1.0.0 | **Ratified**: 2026-05-31
