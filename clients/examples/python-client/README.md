# Python gRPC Client Example — JiMesh Integration

This example demonstrates how external clients (such as the Python Trading Bot or other AI Agents) integrate with the high-performance **JiMesh Go Backend** using gRPC for model routing decisions and Redis Streams for asynchronous execution feedback.

---

## 🏗️ Architecture

```
┌─────────────────┐             1. RouteRequest             ┌─────────────────┐
│                 ├────────────────────────────────────────>│                 │
│                 │                                         │   JiMesh Go     │
│  Python Agent   │             2. RouteDecision            │    Backend      │
│  (Trading Bot)  │<────────────────────────────────────────┤   (Port 3009)   │
│                 │                                         └─────────────────┘
│                 │      3. Asynchronous feedback event
│                 ├──────────────────────────────────────┐
└─────────────────┘                                      │
                                                         ▼
                                                ┌─────────────────┐
                                                │  Redis Streams  │
                                                │(jimesh:events)  │
                                                └────────┬────────┘
                                                         │
                                                         │ 4. Consume & Update
                                                         ▼
                                                ┌─────────────────┐
                                                │   JiMesh Async  │
                                                │  Feedback Loop  │
                                                └─────────────────┘
```

1. **Routing Path (gRPC):** The Python Client queries the Go Backend's `Route` RPC over gRPC (`localhost:3009`). It gets back a `RouteDecision` containing the selected Model, Platform, and authorized API Key in under **1 millisecond**.
2. **Execution:** The Python Client executes the actual inference call against the LLM provider directly (or through proxy).
3. **Feedback Path (Redis Streams):** Once the LLM call succeeds or fails, the client publishes a `RouteEvent` onto the Redis Stream `jimesh:events`.
4. **Bandit Learning:** The Go Backend's async feedback loop consumes this event, immediately updating the Thompson Sampling bandit posterior scores and cost-aware keypools on the fly!

---

## 🚀 Setup & Run

### 1. Install Dependencies
Install gRPC, protobuf, and redis client libraries:
```bash
pip install grpcio grpcio-tools redis
```

### 2. Generate Python gRPC Code from Protobuf
Compile the `jimesh.proto` file into Python modules:
```bash
python -m grpc_tools.protoc \
  -I../../backend/protos \
  --python_out=. \
  --grpc_python_out=. \
  ../../backend/protos/jimesh/jimesh.proto
```

### 3. Run the Client Example
Start the mock agent:
```bash
python client.py
```
