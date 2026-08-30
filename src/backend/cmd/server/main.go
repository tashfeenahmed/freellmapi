// main.go is the entry point for the JiMesh Go backend.
// It wires together:
//   - Store (SQLite)
//   - Router (Thompson Sampling bandit)
//   - KeyPool (cost-aware cooldown)
//   - Streams (Redis Streams pub/sub)
//   - Service (business logic layer)
//   - gRPC server (protobuf RPCs)
//   - HTTP gateway (REST/JSON)
//   - Graceful shutdown on SIGINT/SIGTERM
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/ji-podhead/jimesh/backend/internal/gateway"
	"github.com/ji-podhead/jimesh/backend/internal/keypool"
	"github.com/ji-podhead/jimesh/backend/internal/router"
	"github.com/ji-podhead/jimesh/backend/internal/service"
	"github.com/ji-podhead/jimesh/backend/internal/store"
	"github.com/ji-podhead/jimesh/backend/internal/streams"
	pb "github.com/ji-podhead/jimesh/backend/protos/jimesh"

	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
)

// config holds runtime configuration from env/flags.
type config struct {
	grpcPort    int
	httpPort    int
	sqlitePath  string
	redisURL    string
	redisEnable bool
	shutdownSec int
}

func loadConfig() *config {
	c := &config{}
	flag.IntVar(&c.grpcPort, "grpc-port", 50051, "gRPC server port")
	flag.IntVar(&c.httpPort, "http-port", 8080, "HTTP server port")
	flag.StringVar(&c.sqlitePath, "sqlite-path", "./data/jimesh.db", "Path to sqlite file")
	flag.StringVar(&c.redisURL, "redis-url", "", "Redis URL (default redis://localhost:6379)")
	flag.BoolVar(&c.redisEnable, "redis-enable", true, "Enable Redis PubSub")
	flag.IntVar(&c.shutdownSec, "shutdown-sec", 10, "Graceful shutdown timeout (seconds)")
	flag.Parse()
	return c
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := loadConfig()
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("starting JiMesh Go backend (grpc=%d http=%d sqlite=%s redis-enable=%v)",
		c.grpcPort, c.httpPort, c.sqlitePath, c.redisEnable)

	// ---------- Initialize dependencies ----------
	var err error

	// Store
	db, err := store.Open(c.sqlitePath)
	if err != nil {
		log.Fatalf("failed to open sqlite: %v", err)
	}
	defer db.Close()
	// Seed default chains if empty
	if err := db.SeedDefaults(); err != nil {
		log.Printf("warning: failed to seed defaults: %v", err)
	}

	// Router (bandit)
	rp := router.NewStore()

	// KeyPool
	kp := keypool.New()

	// Streams (Redis PubSub)
	var str *streams.Hub
	if c.redisEnable {
		str, err = streams.New()
		if err != nil {
			log.Fatalf("failed to connect to redis: %v", err)
		}
		defer str.Close()
		log.Printf("redis connected: %s", c.redisURL)
	} else {
		log.Printf("redis disabled")
	}

	// Service layer (business logic)
	svc := service.New(db, rp, kp, str)
	if str != nil {
		svc.StartFeedbackLoop(ctx)
	}
	// Auto-discover keys on startup
	if err := svc.AutoDiscoverKeys(ctx); err != nil {
		log.Printf("[main] key auto-discovery warning: %v", err)
	}

	// ---------- gRPC Server ----------
	grpcLis, err := net.Listen("tcp", fmt.Sprintf(":%d", c.grpcPort))
	if err != nil {
		log.Fatalf("failed to listen gRPC: %v", err)
	}
	grpcS := grpc.NewServer()
	pb.RegisterJiMeshServer(grpcS, &grpcServer{svc: svc})
	// Enable reflection for cli tools like grpcurl
	reflection.Register(grpcS)
	log.Printf("gRPC listening on %s", grpcLis.Addr())

	// ---------- HTTP Gateway ----------
	gw := gateway.New(fmt.Sprintf(":%d", c.httpPort), svc)
	log.Printf("HTTP listening on %s", gw.Addr())

	// ---------- Run servers ----------
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		log.Printf("gRPC server started: %v", grpcS.Serve(grpcLis))
	}()

	go func() {
		defer wg.Done()
		if err := gw.Start(); err != nil {
			log.Fatalf("HTTP server failed: %v", err)
		}
	}()

	// ---------- Graceful shutdown ----------
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigChan
	log.Printf("received signal %s, shutting down...", sig)
	cancel()

	// Shutdown HTTP first (stops accepting new connections)
	gwCtx, gwCancel := context.WithTimeout(context.Background(), time.Duration(c.shutdownSec)*time.Second)
	defer gwCancel()
	if err := gw.Stop(gwCtx); err != nil {
		log.Printf("HTTP shutdown error: %v (forcing)", err)
	}

	// Shutdown gRPC
	grpcS.GracefulStop()

	wg.Wait()
	log.Printf("shutdown complete")
}

// ---------- gRPC server implementation ----------

type grpcServer struct {
	pb.UnimplementedJiMeshServer
	svc *service.Service
}

// ListModels implements JiMesh.ListModels
func (s *grpcServer) ListModels(ctx context.Context, in *pb.ListModelsRequest) (*pb.ListModelsResponse, error) {
	models, err := s.svc.ListModels(ctx, in.Tier.String(), in.EnabledOnly)
	if err != nil {
		return nil, err
	}
	return &pb.ListModelsResponse{Models: models}, nil
}

// ListChains implements JiMesh.ListChains
func (s *grpcServer) ListChains(ctx context.Context, in *pb.ListChainsRequest) (*pb.ListChainsResponse, error) {
	chains, err := s.svc.ListChains(ctx)
	if err != nil {
		return nil, err
	}
	return &pb.ListChainsResponse{Chains: chains}, nil
}

// UpsertChain implements JiMesh.UpsertChain
func (s *grpcServer) UpsertChain(ctx context.Context, in *pb.UpsertChainRequest) (*pb.UpsertChainResponse, error) {
	chain, err := s.svc.UpsertChain(ctx, in.Chain)
	if err != nil {
		return nil, err
	}
	return &pb.UpsertChainResponse{Chain: chain}, nil
}

// Route implements JiMesh.Route
func (s *grpcServer) Route(ctx context.Context, in *pb.RouteRequest) (*pb.RouteDecision, error) {
	return s.svc.Route(ctx, in)
}

// StreamEvents implements JiMesh.StreamEvents
func (s *grpcServer) StreamEvents(in *pb.StreamEventsRequest, stream pb.JiMesh_StreamEventsServer) error {
	if s.svc.Streams == nil {
		return fmt.Errorf("redis streams disabled")
	}
	ctx := stream.Context()
	log.Printf("[grpc] stream events started for client")
	
	errChan := make(chan error, 1)
	s.svc.Streams.Tail(ctx, streams.TopicEvents, "", func(id string, payload []byte) {
		var ev pb.RouteEvent
		if err := json.Unmarshal(payload, &ev); err != nil {
			return
		}
		if in.Platform != "" && in.Platform != ev.Platform {
			return
		}
		if in.ModelId != "" && in.ModelId != ev.ModelId {
			return
		}
		if err := stream.Send(&ev); err != nil {
			select {
			case errChan <- err:
			default:
			}
		}
	})
	
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errChan:
		return err
	}
}

// StreamScores implements JiMesh.StreamScores
func (s *grpcServer) StreamScores(in *pb.StreamScoresRequest, stream pb.JiMesh_StreamScoresServer) error {
	if s.svc.Streams == nil {
		return fmt.Errorf("redis streams disabled")
	}
	ctx := stream.Context()
	log.Printf("[grpc] stream scores started for client")
	
	errChan := make(chan error, 1)
	s.svc.Streams.Tail(ctx, streams.TopicScores, "", func(id string, payload []byte) {
		var list []*pb.ScoreSnapshot
		if err := json.Unmarshal(payload, &list); err != nil {
			return
		}
		for _, snap := range list {
			if err := stream.Send(snap); err != nil {
				select {
				case errChan <- err:
				default:
				}
				return
			}
		}
	})
	
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errChan:
		return err
	}
}

// StreamHealth implements JiMesh.StreamHealth
func (s *grpcServer) StreamHealth(in *pb.StreamHealthRequest, stream pb.JiMesh_StreamHealthServer) error {
	if s.svc.Streams == nil {
		return fmt.Errorf("redis streams disabled")
	}
	ctx := stream.Context()
	log.Printf("[grpc] stream health started for client")
	
	errChan := make(chan error, 1)
	s.svc.Streams.Tail(ctx, streams.TopicHealth, "", func(id string, payload []byte) {
		var health pb.ProviderHealth
		if err := json.Unmarshal(payload, &health); err != nil {
			return
		}
		if err := stream.Send(&health); err != nil {
			select {
			case errChan <- err:
			default:
			}
		}
	})
	
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errChan:
		return err
	}
}

// GetScores implements JiMesh.GetScores
func (s *grpcServer) GetScores(ctx context.Context, in *pb.GetScoresRequest) (*pb.GetScoresResponse, error) {
	scores, err := s.svc.ListScores(ctx, in.Tier.String())
	if err != nil {
		return nil, err
	}
	return &pb.GetScoresResponse{Scores: scores}, nil
}

// ListProviders implements JiMesh.ListProviders
func (s *grpcServer) ListProviders(ctx context.Context, in *pb.ListProvidersRequest) (*pb.ListProvidersResponse, error) {
	healths, keys, err := s.svc.ListProviders(ctx)
	if err != nil {
		return nil, err
	}
	return &pb.ListProvidersResponse{
		Health: healths,
		Keys:   keys,
	}, nil
}

// CheckHealth implements JiMesh.CheckHealth
func (s *grpcServer) CheckHealth(ctx context.Context, in *pb.CheckHealthRequest) (*pb.ProviderHealth, error) {
	return s.svc.CheckHealth(ctx, in.Platform)
}

// CostReport implements JiMesh.CostReport
func (s *grpcServer) CostReport(ctx context.Context, in *pb.ReportRequest) (*pb.ReportResponse, error) {
	report, err := s.svc.CostReport(ctx, in.Period)
	if err != nil {
		return nil, err
	}
	return &pb.ReportResponse{Report: report}, nil
}

// SyncCatalog implements JiMesh.SyncCatalog
func (s *grpcServer) SyncCatalog(ctx context.Context, in *pb.SyncRequest) (*pb.SyncResponse, error) {
	added, updated, removed, newPlats, err := s.svc.SyncCatalog(ctx)
	if err != nil {
		return nil, err
	}
	return &pb.SyncResponse{
		ModelsAdded:    added,
		ModelsUpdated:  updated,
		ModelsRemoved:  removed,
		NewPlatforms:   newPlats,
	}, nil
}
