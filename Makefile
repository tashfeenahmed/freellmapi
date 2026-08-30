# ==============================================================================
# JiMesh — Smart LLM Mesh Router Build System
# ==============================================================================

.PHONY: all build up down restart logs ps proto clean

# Default target
all: build

# Build the docker containers (including Go codegen and compilation)
build:
	@echo "Building JiMesh services..."
	docker compose build

# Start the services in detached mode
up:
	@echo "Starting JiMesh (Go Backend + Redis)..."
	docker compose up -d

# Stop the services
down:
	@echo "Stopping JiMesh services..."
	docker compose down

# Restart the services
restart: down up

# Show logs from the containers
logs:
	docker compose logs -f

# Show status of running containers
ps:
	docker compose ps

# Helper to generate the .pb.go files directly on the host using a volume mount.
# This ensures local development, IDE auto-completion, and local testing work seamlessly.
proto:
	@echo "Building/Verifying codegen container..."
	docker build -t jimesh-codegen --target codegen ./src/backend
	@echo "Generating Go files from proto schemas directly to host..."
	docker run --rm -v "$(PWD)/src/backend:/src" jimesh-codegen protoc -I protos --go_out=protos --go_opt=paths=source_relative --go-grpc_out=protos --go-grpc_opt=paths=source_relative protos/jimesh/jimesh.proto
	@echo "Proto files compiled successfully into src/backend/protos/jimesh/"

# Clean up generated proto files on the host
clean:
	@echo "Cleaning up generated proto files..."
	rm -f src/backend/protos/jimesh/*.pb.go
