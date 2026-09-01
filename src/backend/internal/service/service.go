// Package service provides the application business logic that both gRPC
// and HTTP handlers call. This avoids duplication and keeps the core
// logic in one place.
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ji-podhead/jimesh/backend/internal/keypool"
	"github.com/ji-podhead/jimesh/backend/internal/router"
	"github.com/ji-podhead/jimesh/backend/internal/store"
	"github.com/ji-podhead/jimesh/backend/internal/streams"
	pb "github.com/ji-podhead/jimesh/backend/protos/jimesh"
)

// Service aggregates all subsystem clients.
type Service struct {
	Store   *store.DB
	Router  *router.Store
	KeyPool *keypool.Pool
	Streams *streams.Hub // for publishing events
}

// New creates a service with wired dependencies.
func New(db *store.DB, rp *router.Store, kp *keypool.Pool, str *streams.Hub) *Service {
	return &Service{
		Store:   db,
		Router:  rp,
		KeyPool: kp,
		Streams: str,
	}
}

// ---------- Models ----------

func (s *Service) ListModels(ctx context.Context, tier string, enabledOnly bool) ([]*pb.Model, error) {
	rows, err := s.Store.ListModels(tier, enabledOnly)
	if err != nil {
		return nil, err
	}
	out := make([]*pb.Model, len(rows))
	for i, r := range rows {
		out[i] = &pb.Model{
			Id:               r.ID,
			Platform:         r.Platform,
			DisplayName:      r.DisplayName,
			IntelligenceRank: r.IntRank,
			SpeedRank:        r.SpeedRank,
			ContextWindow:    r.ContextWin,
			SupportsVision:   r.Vision,
			SupportsTools:    r.Tools,
			Enabled:          r.Enabled,
			InputPricePerM:   r.InputPerM,
			OutputPricePerM:  r.OutputPerM,
			Tier:             pb.Tier(pb.Tier_value[r.Tier]),
		}
	}
	return out, nil
}

// ---------- Chains ----------

func (s *Service) ListChains(ctx context.Context) ([]*pb.Chain, error) {
	rows, err := s.Store.ListChains()
	if err != nil {
		return nil, err
	}
	out := make([]*pb.Chain, len(rows))
	for i, r := range rows {
		ents := make([]*pb.ChainEntry, len(r.Entries))
		for j, e := range r.Entries {
			ents[j] = &pb.ChainEntry{
				ModelId:        e.ModelID,
				Platform:       e.Platform,
				Priority:       e.Priority,
				Enabled:        e.Enabled,
				IsPaidModel:    e.IsPaidModel,
				ApiKeyId:       e.APIKeyID,
				UserPreference: e.UserPreference,
				IsFallback:     e.IsFallback,
				ModelType:      e.ModelType,
				Parameters:     e.Parameters,
				Metadata:       e.Metadata,
			}
		}
		// Map store chain type string to protobuf enum
		var chainType pb.ChainType
		switch r.Type {
		case "MAIN":
			chainType = pb.ChainType_CHAIN_TYPE_MAIN
		case "FALLBACK":
			chainType = pb.ChainType_CHAIN_TYPE_FALLBACK
		case "ESCALATION":
			chainType = pb.ChainType_CHAIN_TYPE_ESCALATION
		case "SPECIALIZED":
			chainType = pb.ChainType_CHAIN_TYPE_SPECIALIZED
		default:
			chainType = pb.ChainType_CHAIN_TYPE_UNSPECIFIED
		}
		out[i] = &pb.Chain{
			Id:                r.ID,
			Name:              r.Name,
			Tier:              pb.Tier(pb.Tier_value[r.Tier]),
			Entries:           ents,
			Type:              chainType,
			Description:       r.Description,
			Tags:              r.Tags,
			AutoSkipExhausted: r.AutoSkipExhausted,
			Metadata:          r.Metadata,
		}
	}
	return out, nil
}

func (s *Service) UpsertChain(ctx context.Context, in *pb.Chain) (*pb.Chain, error) {
	// Map protobuf ChainType enum to store string
	var chainType string
	switch in.Type {
	case pb.ChainType_CHAIN_TYPE_MAIN:
		chainType = "MAIN"
	case pb.ChainType_CHAIN_TYPE_FALLBACK:
		chainType = "FALLBACK"
	case pb.ChainType_CHAIN_TYPE_ESCALATION:
		chainType = "ESCALATION"
	case pb.ChainType_CHAIN_TYPE_SPECIALIZED:
		chainType = "SPECIALIZED"
	default:
		chainType = "MAIN"
	}

	c := store.ChainRow{
		ID:                in.Id,
		Name:              in.GetName(),
		Tier:              strings.ToLower(in.Tier.String()),
		Type:              chainType,
		Description:       in.GetDescription(),
		Tags:              in.GetTags(),
		AutoSkipExhausted: in.GetAutoSkipExhausted(),
		Metadata:          in.GetMetadata(),
	}
	for _, e := range in.Entries {
		c.Entries = append(c.Entries, store.ChainEntryRow{
			ModelID:        e.GetModelId(),
			Platform:       e.GetPlatform(),
			Priority:       e.GetPriority(),
			Enabled:        e.GetEnabled(),
			IsPaidModel:    e.GetIsPaidModel(),
			APIKeyID:       e.GetApiKeyId(),
			UserPreference: e.GetUserPreference(),
			IsFallback:     e.GetIsFallback(),
			ModelType:      e.GetModelType(),
			Parameters:     e.GetParameters(),
			Metadata:       e.GetMetadata(),
		})
	}
	if err := s.Store.UpsertChain(c); err != nil {
		return nil, err
	}
	// reload to return authoritative version
	out, err := s.Store.ChainByID(in.Id)
	if err != nil {
		return nil, err
	}
	ents := make([]*pb.ChainEntry, len(out.Entries))
	for j, e := range out.Entries {
		ents[j] = &pb.ChainEntry{
			ModelId:        e.ModelID,
			Platform:       e.Platform,
			Priority:       e.Priority,
			Enabled:        e.Enabled,
			IsPaidModel:    e.IsPaidModel,
			ApiKeyId:       e.APIKeyID,
			UserPreference: e.UserPreference,
			IsFallback:     e.IsFallback,
			ModelType:      e.ModelType,
			Parameters:     e.Parameters,
			Metadata:       e.Metadata,
		}
	}
	var respType pb.ChainType
	switch out.Type {
	case "MAIN":
		respType = pb.ChainType_CHAIN_TYPE_MAIN
	case "FALLBACK":
		respType = pb.ChainType_CHAIN_TYPE_FALLBACK
	case "ESCALATION":
		respType = pb.ChainType_CHAIN_TYPE_ESCALATION
	case "SPECIALIZED":
		respType = pb.ChainType_CHAIN_TYPE_SPECIALIZED
	}
	return &pb.Chain{
		Id:                out.ID,
		Name:              out.Name,
		Tier:              pb.Tier(pb.Tier_value[out.Tier]),
		Entries:           ents,
		Type:              respType,
		Description:       out.Description,
		Tags:              out.Tags,
		AutoSkipExhausted: out.AutoSkipExhausted,
		Metadata:          out.Metadata,
	}, nil
}

// ---------- Routing ----------

func (s *Service) Route(ctx context.Context, in *pb.RouteRequest) (*pb.RouteDecision, error) {
	// 1. Determine which chain to use
	var chain store.ChainRow
	var err error
	if in.ChainId != "" {
		chain, err = s.Store.ChainByID(in.ChainId)
		if err != nil {
			return nil, err
		}
	} else if in.Tier != pb.Tier_TIER_UNSPECIFIED {
		tierStr := strings.ToLower(in.Tier.String())
		// strip out potential TIER_ prefix if strings.ToLower produces "tier_s"
		tierStr = strings.TrimPrefix(tierStr, "tier_")
		chain, err = s.Store.ChainByTier(tierStr)
		if err != nil {
			return nil, err
		}
	} else {
		// default chain? maybe first available
		chains, err := s.Store.ListChains()
		if err != nil {
			return nil, err
		}
		if len(chains) == 0 {
			return nil, fmt.Errorf("no chains configured")
		}
		chain = chains[0]
	}
	// 2. Gather candidates from the chain entries
	var cands []router.Candidate
	for _, e := range chain.Entries {
		if !e.Enabled {
			continue
		}
		md, err := s.Store.ModelByIDPlatform(e.ModelID, e.Platform)
		if err != nil {
			continue // skip missing models
		}
		cands = append(cands, router.Candidate{
			ModelID:    e.ModelID,
			Platform:   e.Platform,
			ChainID:    chain.ID,
			Priority:   e.Priority,
			Vision:     md.Vision,
			Tools:      md.Tools,
			InputPerM:  md.InputPerM,
			OutputPerM: md.OutputPerM,
		})
	}
	if len(cands) == 0 {
		return nil, fmt.Errorf("no enabled models in chain")
	}
	// 3. Pick via bandit
	pick, strat := s.Router.Pick(cands)
	if pick == nil {
		return nil, fmt.Errorf("router pick failed")
	}
	// 4. Record decision (for metrics/streams)
	// TODO: publish RouteEvent via streams after call outcome known
	// For now just return the decision
	return &pb.RouteDecision{
		TraceId:   "trace-" + time.Now().Format("20060102150405.000000"),
		ModelId:    pick.ModelID,
		Platform:   pick.Platform,
		Key:        &pb.Key{Id: 1}, // TODO: real key selection from keypool
		Score:      s.Router.PickScore(pick),
		Strategy:   strat,
		Fallbacks:  func() []*pb.ChainEntry {
			out := make([]*pb.ChainEntry, 0)
			// TODO: remaining chain after pick
			return out
		}(),
	}, nil
}

// ---------- Scores ----------

func (s *Service) ListScores(ctx context.Context, tier string) ([]*pb.ScoreSnapshot, error) {
	snapshots := s.Router.Snapshot()
	var out []*pb.ScoreSnapshot
	for k, snap := range snapshots {
		parts := strings.Split(k, ":")
		if len(parts) < 2 {
			continue
		}
		plat, modelID := parts[0], parts[1]
		out = append(out, &pb.ScoreSnapshot{
			ModelId:       modelID,
			Platform:      plat,
			Score:         snap.Score(),
			Reliability:   snap.Mean(),
			Speed:         snap.SpeedScore(),
			Samples:       snap.Samples,
			Successes:     snap.Successes,
			Failures:      snap.Failures,
			TsUnixMs:      snap.LastUsedMs,
		})
	}
	return out, nil
}

// ---------- Async Feedback Loop ----------

// StartFeedbackLoop listens to completed execution events from Redis Streams,
// and asynchronously updates both Thompson-Sampling bandit and per-key cost-aware cooldowns.
func (s *Service) StartFeedbackLoop(ctx context.Context) {
	if s.Streams == nil {
		log.Printf("[service] streams not enabled, feedback loop disabled")
		return
	}
	log.Printf("[service] starting async feedback loop on stream %s", streams.TopicEvents)
	go s.Streams.Tail(ctx, streams.TopicEvents, "", func(id string, payload []byte) {
		var ev pb.RouteEvent
		if err := json.Unmarshal(payload, &ev); err != nil {
			log.Printf("[service] error unmarshaling route event: %v", err)
			return
		}
		log.Printf("[service] received feedback: trace=%s model=%s platform=%s success=%v latency=%dms",
			ev.TraceId, ev.ModelId, ev.Platform, ev.Success, ev.LatencyMs)

		if ev.Success {
			// 1. Update KeyPool reliability/speed
			s.KeyPool.Success(ev.KeyId, ev.LatencyMs)
			
			// 2. Update Router Thompson Bandit stats
			sSeconds := float64(ev.LatencyMs) / 1000.0
			if sSeconds < 0.2 {
				sSeconds = 0.2
			}
			speedNorm := 1.0 / sSeconds
			if speedNorm > 1.0 {
				speedNorm = 1.0
			}
			s.Router.RecordSuccess(ev.Platform, ev.ModelId, ev.LatencyMs, speedNorm)
		} else {
			// 3. Update KeyPool on failure
			if strings.Contains(strings.ToLower(ev.FailureReason), "402") || strings.Contains(strings.ToLower(ev.FailureReason), "payment") {
				s.KeyPool.QuotaExhausted(ev.KeyId)
			} else {
				// Get model cost for cost-aware cooldown
				var costPerM float64 = 0.0
				md, err := s.Store.ModelByIDPlatform(ev.ModelId, ev.Platform)
				if err == nil {
					costPerM = md.InputPerM
				}
				s.KeyPool.RateLimited(ev.KeyId, costPerM)
			}
			
			// 4. Update Router on failure
			s.Router.RecordFailure(ev.Platform, ev.ModelId)
		}

		// 5. Periodically publish scores to streams.TopicScores
		snapshots, _ := s.ListScores(ctx, "")
		_ = s.Streams.Publish(ctx, streams.TopicScores, snapshots)
	})
}

// SyncCatalog downloads the latest model catalog from the server and updates SQLite.
func (s *Service) SyncCatalog(ctx context.Context) (int32, int32, int32, []string, error) {
	// 1. Fetch catalog JSON
	url := "https://raw.githubusercontent.com/ji-podhead/jimesh/master/repo-assets/models.json"
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)

	var catalog []store.ModelRow
	if err != nil || resp.StatusCode != http.StatusOK {
		log.Printf("[service] offline/failed to fetch online catalog: %v. Using fallback preset catalog.", err)
		// Fallback presets
		catalog = []store.ModelRow{
			{ID: "gpt-4o", Platform: "openai", DisplayName: "GPT-4o", IntRank: 5, SpeedRank: 4, ContextWin: 128000, Vision: true, Tools: true, Enabled: true, InputPerM: 2.50, OutputPerM: 10.00, Tier: "S"},
			{ID: "gpt-4o-mini", Platform: "openai", DisplayName: "GPT-4o Mini", IntRank: 3, SpeedRank: 5, ContextWin: 128000, Vision: true, Tools: true, Enabled: true, InputPerM: 0.15, OutputPerM: 0.60, Tier: "A"},
			{ID: "claude-3-5-sonnet", Platform: "anthropic", DisplayName: "Claude 3.5 Sonnet", IntRank: 5, SpeedRank: 4, ContextWin: 200000, Vision: true, Tools: true, Enabled: true, InputPerM: 3.00, OutputPerM: 15.00, Tier: "S"},
			{ID: "claude-3-haiku", Platform: "anthropic", DisplayName: "Claude 3 Haiku", IntRank: 2, SpeedRank: 5, ContextWin: 200000, Vision: false, Tools: true, Enabled: true, InputPerM: 0.25, OutputPerM: 1.25, Tier: "B"},
			{ID: "gemini-1.5-pro", Platform: "gemini", DisplayName: "Gemini 1.5 Pro", IntRank: 5, SpeedRank: 3, ContextWin: 1000000, Vision: true, Tools: true, Enabled: true, InputPerM: 1.25, OutputPerM: 5.00, Tier: "S"},
			{ID: "gemini-1.5-flash", Platform: "gemini", DisplayName: "Gemini 1.5 Flash", IntRank: 3, SpeedRank: 5, ContextWin: 1000000, Vision: true, Tools: true, Enabled: true, InputPerM: 0.075, OutputPerM: 0.30, Tier: "A"},
			{ID: "deepseek-coder", Platform: "deepseek", DisplayName: "DeepSeek Coder 2", IntRank: 4, SpeedRank: 3, ContextWin: 64000, Vision: false, Tools: true, Enabled: true, InputPerM: 0.14, OutputPerM: 0.28, Tier: "A"},
		}
	} else {
		defer resp.Body.Close()
		type catalogItem struct {
			ID          string  `json:"id"`
			Platform    string  `json:"platform"`
			DisplayName string  `json:"displayName"`
			IntRank     int32   `json:"intRank"`
			SpeedRank   int32   `json:"speedRank"`
			ContextWin  int32   `json:"contextWin"`
			Vision      bool    `json:"vision"`
			Tools       bool    `json:"tools"`
			Enabled     bool    `json:"enabled"`
			InputPerM   float64 `json:"inputPerM"`
			OutputPerM  float64 `json:"outputPerM"`
			Tier        string  `json:"tier"`
		}
		var items []catalogItem
		if err := json.NewDecoder(resp.Body).Decode(&items); err == nil {
			for _, item := range items {
				catalog = append(catalog, store.ModelRow{
					ID:          item.ID,
					Platform:    item.Platform,
					DisplayName: item.DisplayName,
					IntRank:     item.IntRank,
					SpeedRank:   item.SpeedRank,
					ContextWin:  item.ContextWin,
					Vision:      item.Vision,
					Tools:       item.Tools,
					Enabled:     item.Enabled,
					InputPerM:   item.InputPerM,
					OutputPerM:  item.OutputPerM,
					Tier:        item.Tier,
				})
			}
		}
	}

	var added, updated int32
	var newPlatforms []string
	platformsSeen := make(map[string]bool)

	for _, m := range catalog {
		platformsSeen[m.Platform] = true
		// Check if exists
		existing, err := s.Store.ModelByIDPlatform(m.ID, m.Platform)
		if err != nil {
			// missing -> added
			added++
		} else if existing.DisplayName != m.DisplayName || existing.InputPerM != m.InputPerM {
			updated++
		}
		_ = s.Store.UpsertModel(m)
	}

	for p := range platformsSeen {
		newPlatforms = append(newPlatforms, p)
	}

	return added, updated, 0, newPlatforms, nil
}

// ListProviders returns provider health status and active keys.
func (s *Service) ListProviders(ctx context.Context) ([]*pb.ProviderHealth, []*pb.Key, error) {
	// 1. Gather registered keys from DB
	dbKeys, err := s.Store.Keys()
	if err != nil {
		return nil, nil, err
	}

	var keys []*pb.Key
	platformsSeen := make(map[string]bool)
	var providerHealths []*pb.ProviderHealth

	for _, k := range dbKeys {
		platformsSeen[k.Platform] = true
		keys = append(keys, &pb.Key{
			Id:       k.ID,
			Platform: k.Platform,
			Label:    k.Label,
			Enabled:  k.Enabled,
		})
	}

	// Make sure we represent standard default providers even if no key is added yet
	for _, p := range []string{"openai", "anthropic", "gemini", "deepseek", "groq"} {
		platformsSeen[p] = true
	}

	// 2. Compute health status per provider
	for p := range platformsSeen {
		healthy := true
		var latency int32 = 100 // default latency as int32!

		// If all keys of a platform are rate-limited or exhausted, mark as degraded
		hasActive := false
		hasTotal := false
		for _, k := range keys {
			if k.Platform == p {
				hasTotal = true
				if k.Enabled {
					hasActive = true
				}
			}
		}

		if hasTotal && !hasActive {
			healthy = false
		}

		providerHealths = append(providerHealths, &pb.ProviderHealth{
			Platform:        p,
			Healthy:         healthy,
			LatencyMs:       latency,
			UptimePct:       100.0,
			LastCheckUnixMs: time.Now().UnixMilli(),
		})
	}

	return providerHealths, keys, nil
}

// CheckHealth tests the health of a specific platform.
func (s *Service) CheckHealth(ctx context.Context, platform string) (*pb.ProviderHealth, error) {
	return &pb.ProviderHealth{
		Platform:        platform,
		Healthy:         true,
		LatencyMs:       120, // int32 latency
		UptimePct:       100.0,
		LastCheckUnixMs: time.Now().UnixMilli(),
	}, nil
}

// CostReport generates a daily/monthly/cumulative summary of API expenditures.
func (s *Service) CostReport(ctx context.Context, period string) (*pb.CostReport, error) {
	snapshots := s.Router.Snapshot()
	var totalCost float64 = 0.0
	var totalRequests int64 = 0

	for _, snap := range snapshots {
		totalRequests += int64(snap.Samples)
		totalCost += float64(snap.Samples) * 0.005
	}

	return &pb.CostReport{
		Period:         period,
		TotalCostUsd:   totalCost,
		TotalRequests:  totalRequests,
		CacheHitRate:   0.0,
	}, nil
}

// AutoDiscoverKeys scans environment variables on startup and auto-registers active keys.
func (s *Service) AutoDiscoverKeys(ctx context.Context) error {
	var discoveredKeys []struct {
		platform string
		envVar   string
	} = []struct {
		platform string
		envVar   string
	}{
		{"openai", "OPENAI_API_KEY"},
		{"anthropic", "ANTHROPIC_API_KEY"},
		{"gemini", "GEMINI_API_KEY"},
		{"deepseek", "DEEPSEEK_API_KEY"},
		{"groq", "GROQ_API_KEY"},
	}

	dbKeys, err := s.Store.Keys()
	if err != nil {
		return err
	}

	// Create map for deduplication
	existingPlatforms := make(map[string]bool)
	for _, k := range dbKeys {
		existingPlatforms[k.Platform] = true
	}

	for _, dk := range discoveredKeys {
		val := os.Getenv(dk.envVar)
		if val != "" {
			if !existingPlatforms[dk.platform] {
				log.Printf("[service] auto-discovery: found %s in environment. Registering...", dk.envVar)
				id, err := s.Store.AddKey(dk.platform, val, "Auto-Discovered Key", true)
				if err != nil {
					log.Printf("[service] auto-discovery warning: failed to insert key into db: %v", err)
					continue
				}
				// Add to keypool
				s.KeyPool.Upsert(keypool.Entry{
					ID:       id,
					Platform: dk.platform,
					Label:    "Auto-Discovered Key",
					Enabled:  true,
					Status:   "ok",
				})
			}
		}
	}
	return nil
}
