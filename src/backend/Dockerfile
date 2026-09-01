# ---------- Stage 1: codegen ----------
FROM golang:1.23-bookworm AS codegen
# Install protoc and plugins
RUN apt-get update && apt-get install -y --no-install-recommends \
        protobuf-compiler \
        unzip \
    && rm -rf /var/lib/apt/lists/*
# Install Go plugins
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.34.2 \
    && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.4.0
WORKDIR /src
COPY protos ./protos
# Generate Go protobuf and gRPC code
RUN protoc -I protos --go_out=protos --go_opt=paths=source_relative \
           --go-grpc_out=protos --go-grpc_opt=paths=source_relative \
           protos/jimesh/*.proto

# ---------- Stage 2: build ----------
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=codegen /src/protos ./protos
# Build static binary (no cgo)
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -trimpath -o /out/server ./cmd/server

# ---------- Stage 3: runtime ----------
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
EXPOSE 50051 8080
# HTTP/3 would need another port (e.g. 443/udp) but omitted for MVP
ENTRYPOINT ["/server"]