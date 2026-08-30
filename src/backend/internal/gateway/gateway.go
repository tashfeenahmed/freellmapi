// Package gateway serves the public HTTP/1.1+2 API and health checks.
// It delegates to internal/service for all business logic, keeping the
// handler layer thin. HTTP/3 can be added later via quic-go with similar
// structure.
package gateway

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ji-podhead/jimesh/backend/internal/service"
	pb "github.com/ji-podhead/jimesh/backend/protos/jimesh"
)

// Server bundles the mux and dependencies.
type Server struct {
	mux  *http.ServeMux
	svc  *service.Service
	addr string
	srv  *http.Server
	log  *log.Logger
}

// Addr returns the configured listening address.
func (s *Server) Addr() string {
	return s.addr
}

// New creates a server that listens on addr and uses svc for logic.
func New(addr string, svc *service.Service) *Server {
	mux := http.NewServeMux()
	s := &Server{
		mux:  mux,
		svc:  svc,
		addr: addr,
		log:  log.New(log.Writer(), "[gateway] ", log.LstdFlags),
	}
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/ready", s.handleReady)
	mux.HandleFunc("/v1/models", s.handleListModels)
	mux.HandleFunc("/v1/chains", s.handleChains)
	mux.HandleFunc("/v1/route", s.handleRoute)
	mux.HandleFunc("/v1/score", s.handleGetScores)
	mux.HandleFunc("/v1/providers", s.handleProviders)
	// catch-all for unimplemented endpoints
	mux.HandleFunc("/", s.handleNotFound)
	return s
}

// Start binds and begins accepting connections.
func (s *Server) Start() error {
	s.srv = &http.Server{
		Addr:    s.addr,
		Handler: s.mux,
		// timeouts to avoid slowloris
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	s.log.Printf("listening on %s", s.addr)
	return s.srv.ListenAndServe()
}

// Stop shuts down the server gracefully.
func (s *Server) Stop(ctx context.Context) error {
	if s.srv == nil {
		return nil
	}
	return s.srv.Shutdown(ctx)
}

// ---------- Handlers ----------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	// TODO: actually check store + redis connectivity
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
}

func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tier := q.Get("tier")
	enabled := q.Get("enabled") != "false"
	models, err := s.svc.ListModels(r.Context(), tier, enabled)
	if err != nil {
		s.errorJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"models": models})
}

func (s *Server) handleChains(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleChainsGet(w, r)
	case http.MethodPost:
		s.handleChainsPost(w, r)
	default:
		s.errorJSON(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleChainsGet(w http.ResponseWriter, r *http.Request) {
	chains, err := s.svc.ListChains(r.Context())
	if err != nil {
		s.errorJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"chains": chains})
}

func (s *Server) handleChainsPost(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Tier string `json:"tier"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		s.errorJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if in.ID == "" || in.Name == "" || in.Tier == "" {
		s.errorJSON(w, http.StatusBadRequest, "missing required fields")
		return
	}
	var t pb.Tier
	if val, ok := pb.Tier_value["TIER_"+strings.ToUpper(in.Tier)]; ok {
		t = pb.Tier(val)
	} else if val, ok := pb.Tier_value[strings.ToUpper(in.Tier)]; ok {
		t = pb.Tier(val)
	}
	chain, err := s.svc.UpsertChain(r.Context(), &pb.Chain{
		Id:   in.ID,
		Name: in.Name,
		Tier: t,
	})
	if err != nil {
		s.errorJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(chain)
}

func (s *Server) handleRoute(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	chainID := q.Get("chain_id")
	tierStr := q.Get("tier")
	est := q.Get("estimated_tokens")
	vision := q.Get("vision") != "false"
	tools := q.Get("tools") != "false"
	tokens := int32(1000)
	if est != "" {
		if n, err := strconv.Atoi(est); err == nil {
			tokens = int32(n)
		}
	}
	var tier pb.Tier
	if tierStr != "" {
		if val, ok := pb.Tier_value["TIER_"+strings.ToUpper(tierStr)]; ok {
			tier = pb.Tier(val)
		} else if val, ok := pb.Tier_value[strings.ToUpper(tierStr)]; ok {
			tier = pb.Tier(val)
		}
	}
	dec, err := s.svc.Route(r.Context(), &pb.RouteRequest{
		ChainId:         chainID,
		Tier:            tier,
		EstimatedTokens: tokens,
		RequireVision:   vision,
		RequireTools:    tools,
	})
	if err != nil {
		s.errorJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(dec)
}

func (s *Server) handleGetScores(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tier := q.Get("tier")
	scores, err := s.svc.ListScores(r.Context(), tier)
	if err != nil {
		s.errorJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"scores": scores})
}

func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	healths, keys, err := s.svc.ListProviders(r.Context())
	if err != nil {
		s.errorJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"health": healths,
		"keys":   keys,
	})
}

func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) {
	s.errorJSON(w, http.StatusNotFound, "not found")
}

func (s *Server) errorJSON(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
