import os
import time
import random
import json
import grpc
import redis

# Import generated gRPC code
# Note: In production, generate these using:
# python -m grpc_tools.protoc -I../../backend/protos --python_out=. --grpc_python_out=. ../../backend/protos/jimesh/jimesh.proto
try:
    import jimesh_pb2 as pb
    import jimesh_pb2_grpc as pb_grpc
except ImportError:
    print("[python-client] gRPC files not generated yet. Running with simulation.")
    pb = None

def main():
    print("======================================================================")
    print("🚀 JiMesh Python Client Simulation (e.g. Trading Bot / AI Agent)")
    print("======================================================================")

    redis_host = os.getenv("REDIS_HOST", "localhost")
    redis_port = int(os.getenv("REDIS_PORT", 6380))
    grpc_target = os.getenv("GRPC_TARGET", "localhost:3009")

    # Redis client
    r = redis.Redis(host=redis_host, port=redis_port, db=0)
    try:
        r.ping()
        print(f"✅ Connected to Redis on {redis_host}:{redis_port}")
    except Exception as e:
        print(f"❌ Could not connect to Redis: {e}")
        print("Please make sure Docker services are running with 'make up'.")
        return

    # Connection to gRPC server
    channel = grpc.insecure_channel(grpc_target)
    try:
        grpc.channel_ready_future(channel).result(timeout=3)
        print(f"✅ Connected to JiMesh gRPC on {grpc_target}")
        stub = pb_grpc.JiMeshStub(channel) if pb else None
    except Exception as e:
        print(f"⚠️ Could not connect to gRPC server: {e}")
        print("Simulating local gRPC responses, but will still write live feedback to Redis.")
        stub = None

    # Simulate 5 consecutive agent requests
    models_to_test = ["auto:s", "auto:a", "auto:b"]
    platforms = ["openai", "anthropic", "gemini"]

    for i in range(1, 6):
        print(f"\n--- Request #{i} ---")
        selected_tier = random.choice([1, 2, 3]) # pb.Tier.TIER_S, TIER_A, TIER_B
        
        # 1. Ask JiMesh which model & key to route to
        trace_id = f"py-trace-{int(time.time() * 1000)}"
        model_id = "claude-3-5-sonnet"
        platform = "anthropic"
        key_id = 1

        if stub:
            try:
                # Ask gRPC
                req = pb.RouteRequest(tier=selected_tier)
                decision = stub.Route(req)
                trace_id = decision.trace_id
                model_id = decision.model_id
                platform = decision.platform
                key_id = decision.key.id
                print(f"🤖 JiMesh routed to: {platform}/{model_id} (using authorized key ID: {key_id})")
            except Exception as e:
                print(f"gRPC call failed: {e}. Falling back to simulation.")
        else:
            # Simulation values
            platform = random.choice(platforms)
            model_id = random.choice(models_to_test)
            key_id = random.randint(1, 10)
            print(f"🤖 (Simulation) routed to: {platform}/{model_id} (using authorized key ID: {key_id})")

        # 2. Simulate direct LLM execution latency & outcome
        sim_latency = random.randint(150, 2500)
        sim_success = random.random() > 0.15  # 85% success rate
        failure_reason = "" if sim_success else random.choice(["429 Rate Limit Exceeded", "402 Payment Required", "503 Provider Down"])

        print(f"📡 Executing API call... success={sim_success} duration={sim_latency}ms")
        time.sleep(0.5) # small delay for realism

        # 3. Publish asynchronous RouteEvent feedback onto Redis Stream 'jimesh:events'
        event_payload = {
            "trace_id": trace_id,
            "model_id": model_id,
            "platform": platform,
            "key_id": key_id,
            "success": sim_success,
            "latency_ms": sim_latency,
            "failure_reason": failure_reason,
            "tokens_input": random.randint(100, 1000),
            "tokens_output": random.randint(50, 500)
        }

        # Write to Redis Stream
        try:
            r.xadd("jimesh:events", {"data": json.dumps(event_payload)})
            print(f"⚡ Asynchronous RouteEvent pushed to Redis Stream 'jimesh:events'!")
        except Exception as e:
            print(f"❌ Failed to push feedback to Redis: {e}")

    print("\nSimulation complete! Check the Docker Go backend logs with 'make logs' to watch the bandit learn from this feedback!")

if __name__ == "__main__":
    main()
