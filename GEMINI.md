# JiMesh Development Mandates & Agent Instructions

This document defines foundational mandates, directory structures, architectural patterns, and workflow constraints for all AI Agents and developers working on the **JiMesh** repository.

---

## 📁 Repository Directory Structure

This is a clean, multi-language monorepo:
*   `src/backend/` — High-performance Go Backend (gRPC port `3009`, HTTP REST port `3010`, SQLite, Redis Streams).
*   `src/frontend/` — React Admin Dashboard (Vite, TS, Tailwind CSS v4). Stands alone (contains its own isolated `node_modules`).
*   `src/repo-assets/` — Brand assets, comparison images, etc.
*   `clients/desktop/` — Electron Desktop Tray App (TypeScript). Runs `backend` as a background process.
*   `clients/cli/` — TypeScript command-line management tool.
*   `clients/examples/` — Integration and client examples:
    *   `clients/examples/python-client/` — Python client simulation (Trading Bot integration via gRPC and Redis Streams feedback).
    *   `clients/examples/fetch-relay-worker/` — Cloudflare Edge-Relay-Worker.

---

## 🧱 Core Architectural Constraints

1.  **Protobuf is the Single Source of Truth (SSOT):**
    *   All schemas, model structures, fallbacks, and provider definitions **MUST** originate in `src/backend/protos/jimesh/jimesh.proto`.
    *   Never modify Go struct definitions or TypeScript types manually if they represent gRPC/protobuf messages. Modify the `.proto` file and run `make proto` instead.

2.  **Pure Go (No CGO):**
    *   The Go backend **MUST** compile with `CGO_ENABLED=0`.
    *   Use `modernc.org/sqlite` as the SQLite driver to maintain pure Go compliance and distroless compatibility for production.

3.  **Event-Driven Bandit Routing & KeyPool Cooldowns:**
    *   The fast path (`Route`) is highly optimized and reads from the in-memory KeyPool.
    *   The learning feedback path is asynchronous: clients execute LLM calls and push a `RouteEvent` onto the Redis Stream `jimesh:events`.
    *   A background Go goroutine (`StartFeedbackLoop`) consumes events from `jimesh:events`, dynamically updating Thompson Sampling bandit posterior parameters and cost-aware KeyPool cooldowns.

---

## ⚡ Development & Container Conventions

1.  **Zero-Build Volume Mounted Development:**
    *   Do **NOT** rebuild the `jimesh` Docker image for simple `.go` file modifications.
    *   The development container runs the official `golang:1.23-bookworm` image, mounts `./src/backend` directly, and maps your host Go module cache (`/home/ji/go/pkg/mod`) into the container.
    *   To apply any `.go` changes, simply restart the container via `make restart` (takes under 1 second to compile and run).

2.  **Instant Protobuf Compilation:**
    *   To compile `.proto` files, run:
        ```bash
        make proto
        ```
    *   This compiles `jimesh.proto` using a cached codegen container and writes the output (`jimesh.pb.go` and `jimesh_grpc.pb.go`) directly to the host's `./src/backend/protos/jimesh/` folder using a volume mount.

3.  **Zero Root `node_modules` Clutter:**
    *   **NEVER** run `npm install` in the monorepo root or create a `node_modules` folder in the root directory.
    Keep all JS/TS dependencies strictly self-contained within `src/frontend/`, `clients/desktop/`, or `clients/cli/`.

---

## 🚦 Testing & Verification Rules for AI Agents

*   Before submitting any code changes, verify compilation by running `make restart` and inspecting the logs (`docker compose logs jimesh`). There **MUST** be zero compiler warnings or errors.
*   Validate the HTTP Gateway is responsive:
    ```bash
    curl -s http://localhost:3010/health
    ```
*   Verify SQLite data seeding:
    ```bash
    curl -s http://localhost:3010/v1/chains
    ```
