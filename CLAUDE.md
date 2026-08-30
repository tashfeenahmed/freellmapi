# CLAUDE.md — Developer & Agent Workspace Guidance

This file outlines build, test, formatting, and linting commands, along with architecture guidelines, specifically tailored for Claude CLI (Claude Code) and other AI agents.

---

## 🛠️ Build & Development Commands

1.  **Orchestrating Services (Docker Compose):**
    *   Build all containers: `make build`
    *   Start services (Go Backend + Redis): `make up`
    *   Stop services: `make down`
    *   Restart services (compiles & applies `.go` changes in 0.5s): `make restart`
    *   Follow container logs: `make logs`
    *   Show running container status: `make ps`

2.  **Protobuf & gRPC Codegen:**
    *   Compile schemas and write outputs directly to host: `make proto`
    *   *Constraint:* Never edit generated `.pb.go` or `_grpc.pb.go` files manually. Modify `src/backend/protos/jimesh/jimesh.proto` and run `make proto`.

---

## 🧪 Testing Commands

1.  **Go Backend (`src/backend/`):**
    *   Run tests: `go test ./...` (inside `src/backend/` directory)
    *   Run tests with coverage: `go test -cover ./...`

2.  **React Frontend (`src/frontend/`):**
    *   Run tests: `npm run test` (from `src/frontend/` directory)

3.  **CLI Tool (`clients/cli/`):**
    *   Run tests: `npm run test` (from `clients/cli/` directory)

---

## 🎨 Formatting & Linting

1.  **Go Backend:**
    *   Format code: `go fmt ./...`

2.  **JavaScript / TypeScript:**
    *   Lint code: `npm run lint` (inside respective folders)

---

## 🧱 Architectural Mandates

*   **No Root `node_modules`:** All Node.js dependencies **MUST** live strictly within subfolders (`src/frontend/`, `clients/desktop/`, or `clients/cli/`). Do not run `npm install` in the monorepo root.
*   **Pure Go (No CGO):** Use `CGO_ENABLED=0` and pure-Go drivers (`modernc.org/sqlite`).
*   **Event-Driven Learning:** Clients send execution outcomes to Redis Stream `jimesh:events` (`localhost:6380` on host). The backend's background feedback loop consumes them to adjust bandit routing weights.
