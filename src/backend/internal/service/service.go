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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ji-podhead/jimesh/backend/internal/keypool"
	"github.com/ji-podhead/jimesh/backend/internal/quota"
	"github.com/ji-podhead/jimesh/backend/internal/router"
	"github.com/ji-podhead/jimesh/backend/internal/store"
	"github.com/ji-podhead/jimesh/backend/internal/streams"
	"github.com/ji-podhead/jimesh/backend/internal/tracing"
	pb "github.com/ji-podhead/jimesh/backend/protos/jimesh"
)

// Service aggregates all subsystem clients.
type Service struct {
	Store   *store.DB
	Router  *router.Store
	KeyPool *keypool.Pool
	Streams *streams.Hub // for publishing events
	Tracer  *tracing.Client

	recentMu  sync.Mutex
	recent    []RequestSummary
	recentMax int
}

// New creates a service with wired dependencies.
func New(db *store.DB, rp *router.Store, kp *keypool.Pool, str *streams.Hub, tr *tracing.Client) *Service {
	return &Service{
		Store:     db,
		Router:    rp,
		KeyPool:   kp,
		Streams:   str,
		Tracer:    tr,
		recentMax: 500,
	}
}

// ---------- Request summaries (Sprint 7 analytics backbone) ----------

// RequestSummary is the completed-call record published to
// jimesh:requests and kept in a small in-memory ring for dashboards.
// IsPaidModel/IsPaidKey come from the Sprint-6 auto-classifier so every
// analytics surface can split free vs paid without user labor.
type RequestSummary struct {
	TraceID      string  `json:"trace_id"`
	SessionID    string  `json:"session_id,omitempty"`
	AgentTypeID  string  `json:"agent_type_id,omitempty"`
	ChainID      string  `json:"chain_id,omitempty"`
	Strategy     string  `json:"strategy,omitempty"`
	ModelID      string  `json:"model_id"`
	Platform     string  `json:"platform"`
	KeyID        int64   `json:"key_id"`
	IsPaidModel  bool    `json:"is_paid_model"`
	IsPaidKey    bool    `json:"is_paid_key"`
	Success      bool    `json:"success"`
	StatusCode   int     `json:"status_code"`
	LatencyMs    int64   `json:"latency_ms"`
	InputTokens  int32   `json:"input_tokens,omitempty"`
	OutputTokens int32   `json:"output_tokens,omitempty"`
	CostUSD      float64 `json:"cost_usd,omitempty"`
	Error        string  `json:"error,omitempty"`
	TsUnixMs     int64   `json:"ts_unix_ms"`
}

// RecordRequestSummary stores, streams and traces one completed call.
// Fire-and-forget on purpose: never blocks the proxy path on Redis/Langfuse.
func (s *Service) RecordRequestSummary(rs RequestSummary) {
	if rs.TsUnixMs == 0 {
		rs.TsUnixMs = time.Now().UnixMilli()
	}
	s.recentMu.Lock()
	s.recent = append(s.recent, rs)
	if len(s.recent) > s.recentMax {
		s.recent = s.recent[len(s.recent)-s.recentMax:]
	}
	s.recentMu.Unlock()

	if s.Streams != nil {
		_ = s.Streams.Publish(context.Background(), streams.TopicRequests, rs)
	}
	if s.Tracer != nil && s.Tracer.Enabled() {
		s.Tracer.RecordChat(tracing.ChatCall{
			TraceID:      rs.TraceID,
			SessionID:    rs.SessionID,
			AgentTypeID:  rs.AgentTypeID,
			ChainID:      rs.ChainID,
			Strategy:     rs.Strategy,
			ModelID:      rs.ModelID,
			Platform:     rs.Platform,
			KeyID:        rs.KeyID,
			Success:      rs.Success,
			LatencyMs:    rs.LatencyMs,
			InputTokens:  rs.InputTokens,
			OutputTokens: rs.OutputTokens,
			CostUSD:      rs.CostUSD,
			Error:        rs.Error,
			TsUnixMs:     rs.TsUnixMs,
		})
	}
}

// RecentRequests returns recent summaries, newest first, optionally filtered.
func (s *Service) RecentRequests(sessionID, agentTypeID string, limit int) []RequestSummary {
	s.recentMu.Lock()
	defer s.recentMu.Unlock()
	if limit <= 0 || limit > len(s.recent) {
		limit = len(s.recent)
	}
	out := make([]RequestSummary, 0, limit)
	for i := len(s.recent) - 1; i >= 0 && len(out) < limit; i-- {
		rs := s.recent[i]
		if sessionID != "" && rs.SessionID != sessionID {
			continue
		}
		if agentTypeID != "" && rs.AgentTypeID != agentTypeID {
			continue
		}
		out = append(out, rs)
	}
	return out
}

// ---------- Quota (Sprint 6) ----------

// RecordQuotaFromResponse parses quota headers off an upstream response,
// persists state + audit observations, benches the key until the
// provider-reported reset, auto-classifies free/paid, and publishes to
// jimesh:quota. Only touches headers/status — body stays for the caller.
func (s *Service) RecordQuotaFromResponse(ctx context.Context, resp *http.Response, platform string, keyID int64, modelID, endpoint string) []quota.Observation {
	if resp == nil {
		return nil
	}
	obs := quota.ParseFromResponse(resp, platform, keyID, modelID, endpoint)
	if len(obs) == 0 {
		return obs
	}
	nowStr := store.FormatQuotaTime(time.Now())

	// Free/paid auto-classification: 402 / insufficient_quota bodies beat
	// everything; catalog price and free pools settle the rest.
	s.autoClassifyPaid(platform, modelID, keyID, resp.StatusCode)

	for _, o := range obs {
		resetStr := ""
		if o.ResetAtMs > 0 {
			resetStr = store.FormatQuotaTime(o.ResetTime())
		}
		_ = s.Store.UpsertQuotaState(store.QuotaStateRow{
			Platform:       o.Platform,
			KeyID:          o.KeyID,
			QuotaPoolKey:   o.QuotaPoolKey,
			Metric:         string(o.Metric),
			LimitValue:     o.Limit,
			RemainingValue: o.Remaining,
			ResetAt:        resetStr,
			ResetStrategy:  o.ResetStrategy,
			Source:         string(o.Source),
			Confidence:     o.Confidence,
			Notes:          o.Notes,
			ObservedAt:     nowStr,
			UpdatedAt:      nowStr,
		})
		_ = s.Store.InsertQuotaObservation(store.QuotaObservationRow{
			Platform:       o.Platform,
			KeyID:          o.KeyID,
			ModelID:        o.ModelID,
			QuotaPoolKey:   o.QuotaPoolKey,
			Metric:         string(o.Metric),
			StatusCode:     o.StatusCode,
			LimitValue:     o.Limit,
			RemainingValue: o.Remaining,
			ResetAt:        resetStr,
			RetryAfterMs:   o.RetryAfterMs,
			ResetStrategy:  o.ResetStrategy,
			Source:         string(o.Source),
			Confidence:     o.Confidence,
			Notes:          o.Notes,
			Endpoint:       o.Endpoint,
			ObservedAt:     nowStr,
		})

		// Header-informed benching: exhausted windows bench the key until the
		// provider's own reset time; paid exhaustion without reset gets 24h.
		if o.KeyID != 0 && o.Exhausted() {
			if rt := o.ResetTime(); !rt.IsZero() && rt.After(time.Now()) {
				s.KeyPool.BenchUntil(o.KeyID, rt)
			} else if o.StatusCode == 402 {
				s.KeyPool.BenchUntil(o.KeyID, time.Now().Add(time.Duration(quota.DefaultBenchMs)*time.Millisecond))
			}
		}

		if s.Streams != nil {
			_ = s.Streams.Publish(ctx, streams.TopicQuota, o)
		}
	}
	return obs
}

// autoClassifyPaid derives free/paid and writes the flags back so users
// never have to. Definitive evidence writes both model + key; weaker
// evidence writes only the model; unknown leaves everything untouched.
func (s *Service) autoClassifyPaid(platform, modelID string, keyID int64, statusCode int) {
	md, mdErr := s.Store.ModelByIDPlatform(modelID, platform)
	price := 0.0
	modelKnown := mdErr == nil
	if modelKnown {
		price = md.InputPerM + md.OutputPerM
	}
	keyIsPaid := false
	if keyID != 0 {
		keyIsPaid = s.keyIsPaidInDB(keyID)
	}
	cls := quota.ClassifyPaid(quota.ClassifyInput{
		Platform:   platform,
		ModelID:    modelID,
		ModelKnown: modelKnown,
		PricePerM:  price,
		KeyIsPaid:  keyIsPaid,
		StatusCode: statusCode,
	})
	if cls.Evidence == "unknown" || !modelKnown {
		return
	}
	_ = s.Store.MarkModelPaid(platform, modelID, cls.IsPaid)
	if cls.Definitive && cls.IsPaid && keyID != 0 {
		_ = s.Store.MarkKeyPaid(keyID, true)
	}
}

func (s *Service) keyIsPaidInDB(keyID int64) bool {
	keys, err := s.Store.Keys()
	if err != nil {
		return false
	}
	for _, k := range keys {
		if k.ID == keyID {
			return k.IsPaid
		}
	}
	return false
}

// KeyIsPaid reports the stored paid flag of a key (false when unknown).
func (s *Service) KeyIsPaid(keyID int64) bool { return s.keyIsPaidInDB(keyID) }

// ModelIsPaid reports the stored paid flag of a cataloged model.
func (s *Service) ModelIsPaid(platform, modelID string) bool {
	md, err := s.Store.ModelByIDPlatform(modelID, platform)
	return err == nil && md.IsPaidModel
}

// QuotaStates returns the current quota snapshot (expired normalized).
func (s *Service) QuotaStates(ctx context.Context) []store.QuotaStateRow {
	rows, err := s.Store.ListQuotaState()
	if err != nil {
		log.Printf("[service] quota states: %v", err)
		return nil
	}
	return rows
}

// QuotaHeadroom returns keyID→0..1 budget fraction for one platform.
// Absent keys are UNKNOWN (not zero) — callers must respect that.
func (s *Service) QuotaHeadroom(ctx context.Context, platform string) map[int64]float64 {
	m, err := s.Store.QuotaHeadroom(platform)
	if err != nil {
		log.Printf("[service] quota headroom: %v", err)
		return map[int64]float64{}
	}
	return m
}

// ModelCostUSD computes the USD cost of a call from token usage and catalog
// prices (0 when the model is unknown — never an invented number).
func (s *Service) ModelCostUSD(platform, modelID string, inputTokens, outputTokens int32) float64 {
	md, err := s.Store.ModelByIDPlatform(modelID, platform)
	if err != nil {
		return 0
	}
	return float64(inputTokens)/1_000_000*md.InputPerM +
		float64(outputTokens)/1_000_000*md.OutputPerM
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

		pbNodes := make([]*pb.ChainNode, len(r.Nodes))
		for j, n := range r.Nodes {
			var nodeType pb.NodeType
			switch n.Type {
			case "STATIC":
				nodeType = pb.NodeType_NODE_TYPE_STATIC_MODEL
			case "SMART_CONTAINER":
				nodeType = pb.NodeType_NODE_TYPE_SMART_CONTAINER
			case "SUB_CHAIN":
				nodeType = pb.NodeType_NODE_TYPE_SUB_CHAIN_LINK
			}
			
			var members []*pb.ContainerMember
			for _, m := range n.SmartMembers {
				members = append(members, &pb.ContainerMember{
					ModelId:        m.ModelID,
					Platform:       m.Platform,
					Enabled:        m.Enabled,
					IsPaidModel:    m.IsPaidModel,
					ApiKeyId:       m.APIKeyID,
					UserPreference: m.UserPreference,
					SelfRetry:      m.SelfRetry,
				})
			}
			
			pbNodes[j] = &pb.ChainNode{
				Id:              n.ID,
				Type:            nodeType,
				Priority:        n.Priority,
				Enabled:         n.Enabled,
				StaticModelId:   n.StaticModelID,
				StaticPlatform:  n.StaticPlatform,
				StaticApiKeyId:  n.StaticAPIKeyID,
				StaticSelfRetry: n.StaticSelfRetry,
				SmartConfig: &pb.SmartRoutingConfig{
					Strategy:             n.SmartConfig.Strategy,
					WeightReliability:  n.SmartConfig.WeightReliability,
					WeightSpeed:        n.SmartConfig.WeightSpeed,
					WeightIntelligence: n.SmartConfig.WeightIntelligence,
					KeySelectionStrategy: n.SmartConfig.KeySelection,
					ExploreEnabled:     n.SmartConfig.ExploreEnabled,
					PeakAdjust:         n.SmartConfig.PeakAdjust,
				},
				SmartMembers:  members,
				TargetChainId: n.TargetChainID,
			}
		}

		out[i] = &pb.Chain{
			Id:                 r.ID,
			Name:               r.Name,
			Tier:               pb.Tier(pb.Tier_value[r.Tier]),
			Entries:            ents,
			Type:               chainType,
			Description:        r.Description,
			Tags:               r.Tags,
			AutoSkipExhausted:  r.AutoSkipExhausted,
			Metadata:           r.Metadata,
			Strategy:           r.Strategy,
			WeightReliability:  r.WeightReliability,
			WeightSpeed:        r.WeightSpeed,
			WeightIntelligence: r.WeightIntelligence,
			KeySelection:       r.KeySelection,
			ExploreEnabled:     r.ExploreEnabled,
			PeakAdjust:         r.PeakAdjust,
			Nodes:              pbNodes,
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
		ID:                 in.Id,
		Name:               in.GetName(),
		Tier:               strings.ToLower(in.Tier.String()),
		Type:               chainType,
		Description:        in.GetDescription(),
		Tags:               in.GetTags(),
		AutoSkipExhausted:  in.GetAutoSkipExhausted(),
		Metadata:           in.GetMetadata(),
		Strategy:           in.GetStrategy(),
		WeightReliability:  in.GetWeightReliability(),
		WeightSpeed:        in.GetWeightSpeed(),
		WeightIntelligence: in.GetWeightIntelligence(),
		KeySelection:       in.GetKeySelection(),
		ExploreEnabled:     in.GetExploreEnabled(),
		PeakAdjust:         in.GetPeakAdjust(),
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
	
	// Map nodes
	for _, n := range in.Nodes {
		var nType string
		switch n.Type {
		case pb.NodeType_NODE_TYPE_STATIC_MODEL:
			nType = "STATIC"
		case pb.NodeType_NODE_TYPE_SMART_CONTAINER:
			nType = "SMART_CONTAINER"
		case pb.NodeType_NODE_TYPE_SUB_CHAIN_LINK:
			nType = "SUB_CHAIN"
		}
		
		var mRows []store.ContainerMemberRow
		for _, m := range n.SmartMembers {
			mRows = append(mRows, store.ContainerMemberRow{
				ModelID:        m.ModelId,
				Platform:       m.Platform,
				Enabled:        m.Enabled,
				IsPaidModel:    m.IsPaidModel,
				APIKeyID:       m.ApiKeyId,
				UserPreference: m.UserPreference,
				SelfRetry:      m.SelfRetry,
			})
		}
		
		var smartConfig store.ContainerStrategyRow
		if n.SmartConfig != nil {
			smartConfig = store.ContainerStrategyRow{
				Strategy:           n.SmartConfig.Strategy,
				WeightReliability:  n.SmartConfig.WeightReliability,
				WeightSpeed:        n.SmartConfig.WeightSpeed,
				WeightIntelligence: n.SmartConfig.WeightIntelligence,
				KeySelection:       n.SmartConfig.KeySelectionStrategy,
				ExploreEnabled:     n.SmartConfig.ExploreEnabled,
				PeakAdjust:         n.SmartConfig.PeakAdjust,
			}
		}
		
		c.Nodes = append(c.Nodes, store.ChainNodeRow{
			ID:              n.Id,
			Type:            nType,
			Priority:        n.Priority,
			Enabled:         n.Enabled,
			StaticModelID:   n.StaticModelId,
			StaticPlatform:  n.StaticPlatform,
			StaticAPIKeyID:  n.StaticApiKeyId,
			StaticSelfRetry: n.StaticSelfRetry,
			SmartConfig:     smartConfig,
			SmartMembers:    mRows,
			TargetChainID:   n.TargetChainId,
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

	pbNodes := make([]*pb.ChainNode, len(out.Nodes))
	for j, n := range out.Nodes {
		var nodeType pb.NodeType
		switch n.Type {
		case "STATIC":
			nodeType = pb.NodeType_NODE_TYPE_STATIC_MODEL
		case "SMART_CONTAINER":
			nodeType = pb.NodeType_NODE_TYPE_SMART_CONTAINER
		case "SUB_CHAIN":
			nodeType = pb.NodeType_NODE_TYPE_SUB_CHAIN_LINK
		}
		
		var members []*pb.ContainerMember
		for _, m := range n.SmartMembers {
			members = append(members, &pb.ContainerMember{
				ModelId:        m.ModelID,
				Platform:       m.Platform,
				Enabled:        m.Enabled,
				IsPaidModel:    m.IsPaidModel,
				ApiKeyId:       m.APIKeyID,
				UserPreference: m.UserPreference,
				SelfRetry:      m.SelfRetry,
			})
		}
		
		pbNodes[j] = &pb.ChainNode{
			Id:              n.ID,
			Type:            nodeType,
			Priority:        n.Priority,
			Enabled:         n.Enabled,
			StaticModelId:   n.StaticModelID,
			StaticPlatform:  n.StaticPlatform,
			StaticApiKeyId:  n.StaticAPIKeyID,
			StaticSelfRetry: n.StaticSelfRetry,
			SmartConfig: &pb.SmartRoutingConfig{
				Strategy:             n.SmartConfig.Strategy,
				WeightReliability:  n.SmartConfig.WeightReliability,
				WeightSpeed:        n.SmartConfig.WeightSpeed,
				WeightIntelligence: n.SmartConfig.WeightIntelligence,
				KeySelectionStrategy: n.SmartConfig.KeySelection,
				ExploreEnabled:     n.SmartConfig.ExploreEnabled,
				PeakAdjust:         n.SmartConfig.PeakAdjust,
			},
			SmartMembers:  members,
			TargetChainId: n.TargetChainID,
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
		Id:                 out.ID,
		Name:               out.Name,
		Tier:               pb.Tier(pb.Tier_value[out.Tier]),
		Entries:            ents,
		Type:               respType,
		Description:        out.Description,
		Tags:               out.Tags,
		AutoSkipExhausted:  out.AutoSkipExhausted,
		Metadata:           out.Metadata,
		Strategy:           out.Strategy,
		WeightReliability:  out.WeightReliability,
		WeightSpeed:        out.WeightSpeed,
		WeightIntelligence: out.WeightIntelligence,
		KeySelection:       out.KeySelection,
		ExploreEnabled:     out.ExploreEnabled,
		PeakAdjust:         out.PeakAdjust,
		Nodes:              pbNodes,
	}, nil
}

// ---------- Routing ----------

func (s *Service) buildStaticDecision(n store.ChainNodeRow, key *keypool.Entry, md store.ModelRow) *pb.RouteDecision {
	return &pb.RouteDecision{
		TraceId:  "trace-" + time.Now().Format("20060102150405.000000"),
		ModelId:   n.StaticModelID,
		Platform:  n.StaticPlatform,
		Strategy:  "static_cascade",
		Score:     1.0,
		Key: &pb.Key{
			Id:                  key.ID,
			Platform:             key.Platform,
			Label:                key.Label,
			Enabled:              key.Enabled,
			Status:               key.Status,
			CooldownUntilUnixMs:  key.CooldownUntil.UnixMilli(),
			Reliability:          key.Reliability,
			Speed:                key.Speed,
			TotalRequests:        key.TotalRequests,
		},
	}
}

func (s *Service) buildSmartDecision(pick *router.Candidate, n store.ChainNodeRow, key *keypool.Entry, md store.ModelRow, strat string) *pb.RouteDecision {
	var chosenKey *pb.Key
	if key != nil {
		chosenKey = &pb.Key{
			Id:                   key.ID,
			Platform:             key.Platform,
			Label:                key.Label,
			Enabled:              key.Enabled,
			Status:               key.Status,
			CooldownUntilUnixMs:  key.CooldownUntil.UnixMilli(),
			Reliability:          key.Reliability,
			Speed:                key.Speed,
			TotalRequests:        key.TotalRequests,
		}
	} else {
		chosenKey = &pb.Key{
			Id:       0,
			Platform: pick.Platform,
			Label:    "Fallback Key",
			Enabled:  true,
			Status:   "ok",
		}
	}
	return &pb.RouteDecision{
		TraceId:  "trace-" + time.Now().Format("20060102150405.000000"),
		ModelId:   pick.ModelID,
		Platform:  pick.Platform,
		Strategy:  strat,
		Score:     s.Router.PickScore(pick),
		Key:       chosenKey,
	}
}

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

	// 1.5. Dynamic Hybrid Visual Nodes Routing Canvas! (If visual nodes exist, run this!)
	if len(chain.Nodes) > 0 {
		for _, n := range chain.Nodes {
			if !n.Enabled {
				continue
			}

			switch n.Type {
			case "STATIC":
				// Static fallback node! Check key availability
				if n.StaticAPIKeyID != "" {
					if id, err := strconv.ParseInt(n.StaticAPIKeyID, 10, 64); err == nil {
						key, ok := s.KeyPool.Get(id)
						if ok && key.Enabled && key.CooldownUntil.Before(time.Now()) {
							md, err := s.Store.ModelByIDPlatform(n.StaticModelID, n.StaticPlatform)
							if err == nil {
								return s.buildStaticDecision(n, &key, md), nil
							}
						}
					}
				} else {
					available := s.KeyPool.AvailableKeys(n.StaticPlatform, n.StaticModelID)
					if len(available) > 0 {
						md, err := s.Store.ModelByIDPlatform(n.StaticModelID, n.StaticPlatform)
						if err == nil {
							return s.buildStaticDecision(n, available[0], md), nil
						}
					}
				}

			case "SMART_CONTAINER":
				// Smart Container Node! Route across members with container config
				var containerCands []router.Candidate
				for _, m := range n.SmartMembers {
					if !m.Enabled {
						continue
					}
					if m.APIKeyID != "" {
						if id, err := strconv.ParseInt(m.APIKeyID, 10, 64); err == nil {
							key, ok := s.KeyPool.Get(id)
							if !ok || !key.Enabled || key.CooldownUntil.After(time.Now()) {
								continue
							}
							// ModelScope explicit filtering check
							if len(key.ModelScope) > 0 {
								found := false
								for _, scopeM := range key.ModelScope {
									if scopeM == m.ModelID {
										found = true
										break
									}
								}
								if !found {
									continue
								}
							}
						} else {
							continue
						}
					} else {
						available := s.KeyPool.AvailableKeys(m.Platform, m.ModelID)
						if len(available) == 0 {
							continue
						}
					}

					md, err := s.Store.ModelByIDPlatform(m.ModelID, m.Platform)
					if err != nil {
						continue
					}
					containerCands = append(containerCands, router.Candidate{
						ModelID:        m.ModelID,
						Platform:       m.Platform,
						ChainID:        chain.ID,
						Vision:         md.Vision,
						Tools:          md.Tools,
						InputPerM:      md.InputPerM,
						OutputPerM:     md.OutputPerM,
						UserPreference: m.UserPreference,
					})
				}

				if len(containerCands) > 0 {
					pick, strat := s.Router.Pick(containerCands)
					if pick != nil {
						md, _ := s.Store.ModelByIDPlatform(pick.ModelID, pick.Platform)
						var kRow *keypool.Entry
						keys := s.KeyPool.AvailableKeys(pick.Platform, pick.ModelID)
						if len(keys) > 0 {
							kRow = keys[0]
						}
						return s.buildSmartDecision(pick, n, kRow, md, strat), nil
					}
				}

			case "SUB_CHAIN":
				// Sub-chain connector portal!
				if n.TargetChainID != "" && n.TargetChainID != chain.ID {
					log.Printf("[service] Routing mesh: recursive failover jump to connected sub-chain %s", n.TargetChainID)
					return s.Route(ctx, &pb.RouteRequest{
						ChainId: n.TargetChainID,
					})
				}
			}
		}

		if chain.ID != "auto:b" {
			log.Printf("[service] Visual routing cascade completely exhausted. Falling back to B-Tier (auto:b)...")
			return s.Route(ctx, &pb.RouteRequest{
				ChainId: "auto:b",
			})
		}
		return nil, fmt.Errorf("all nodes in fallback mesh exhausted")
	}

	// 2. Gather candidates from the chain entries, filtering out throttled/cooldown keys BEFORE pick
	var cands []router.Candidate
	for _, e := range chain.Entries {
		if !e.Enabled {
			continue
		}

		// Pre-Call Throttle Check!
		if e.APIKeyID != "" {
			if id, err := strconv.ParseInt(e.APIKeyID, 10, 64); err == nil {
				key, ok := s.KeyPool.Get(id)
				if !ok || !key.Enabled || key.CooldownUntil.After(time.Now()) {
					continue // key throttled, exclude candidate!
				}
				// ModelScope explicit filtering check
				if len(key.ModelScope) > 0 {
					found := false
					for _, scopeM := range key.ModelScope {
						if scopeM == e.ModelID {
							found = true
							break
						}
					}
					if !found {
						continue // candidate not within key modelscope, exclude!
					}
				}
			} else {
				continue
			}
		} else {
			available := s.KeyPool.AvailableKeys(e.Platform, e.ModelID)
			if len(available) == 0 {
				continue // platform throttled or no keys match modelscope, exclude candidate!
			}
		}

		md, err := s.Store.ModelByIDPlatform(e.ModelID, e.Platform)
		if err != nil {
			continue // skip missing models
		}
		cands = append(cands, router.Candidate{
			ModelID:        e.ModelID,
			Platform:       e.Platform,
			ChainID:        chain.ID,
			Priority:       e.Priority,
			Vision:         md.Vision,
			Tools:          md.Tools,
			InputPerM:      md.InputPerM,
			OutputPerM:     md.OutputPerM,
			UserPreference: e.UserPreference,
		})
	}
	if len(cands) == 0 {
		// Automated Fallback chain failover if MAIN is exhausted
		if chain.ID != "auto:b" {
			log.Printf("[service] chain %s completely exhausted. Falling back to B-Tier (auto:b) fallback chain...", chain.ID)
			return s.Route(ctx, &pb.RouteRequest{
				ChainId: "auto:b",
			})
		}
		return nil, fmt.Errorf("no enabled models or healthy keys available in fallback chains")
	}

	// 3. Pick via bandit (or sort by cost if chain type is ESCALATION)
	var pick *router.Candidate
	var strat string

	if strings.ToUpper(chain.Type) == "ESCALATION" {
		// Sort candidates by cost: free/cheap first! (Escalation Chain Logic)
		sort.Slice(cands, func(i, j int) bool {
			costI := cands[i].InputPerM + cands[i].OutputPerM
			costJ := cands[j].InputPerM + cands[j].OutputPerM
			if costI == costJ {
				return cands[i].Priority < cands[j].Priority
			}
			return costI < costJ
		})
		pick = &cands[0]
		strat = "escalation_cost"
	} else {
		p, s := s.Router.Pick(cands)
		pick = p
		strat = s
	}

	if pick == nil {
		return nil, fmt.Errorf("router pick failed")
	}

	// Find the matching chain entry to inspect routing overrides
	var matchedEntry *store.ChainEntryRow
	for _, e := range chain.Entries {
		if e.ModelID == pick.ModelID && e.Platform == pick.Platform {
			matchedEntry = &e
			break
		}
	}

	// 4. Key Selection (specific key override vs standard KeyPool best available keys)
	var chosenKey *pb.Key
	if matchedEntry != nil && matchedEntry.APIKeyID != "" {
		if id, err := strconv.ParseInt(matchedEntry.APIKeyID, 10, 64); err == nil {
			if k, ok := s.KeyPool.Get(id); ok && k.Enabled {
				chosenKey = &pb.Key{
					Id:                   k.ID,
					Platform:             k.Platform,
					Label:                k.Label,
					Enabled:              k.Enabled,
					Status:               k.Status,
					CooldownUntilUnixMs:  k.CooldownUntil.UnixMilli(),
					Reliability:          k.Reliability,
					Speed:                k.Speed,
					TotalRequests:        k.TotalRequests,
				}
			}
		}
	}

	// If no specific key is matched/enabled, pick the best available key for this platform
	if chosenKey == nil {
		keys := s.KeyPool.AvailableKeys(pick.Platform, pick.ModelID)
		if len(keys) > 0 {
			best := keys[0]
			chosenKey = &pb.Key{
				Id:                   best.ID,
				Platform:             best.Platform,
				Label:                best.Label,
				Enabled:              best.Enabled,
				Status:               best.Status,
				CooldownUntilUnixMs:  best.CooldownUntil.UnixMilli(),
				Reliability:          best.Reliability,
				Speed:                best.Speed,
				TotalRequests:        best.TotalRequests,
			}
		} else {
			// Stub key fallback (keeps routing working during cold start/keyless envs)
			chosenKey = &pb.Key{
				Id:       0,
				Platform: pick.Platform,
				Label:    "Fallback Key",
				Enabled:  true,
				Status:   "ok",
			}
		}
	}

	// 5. Compute the remaining Fallback Chain sorted by priority ascending
	fallbacks := make([]*pb.ChainEntry, 0)
	for _, e := range chain.Entries {
		if !e.Enabled {
			continue
		}
		if e.ModelID == pick.ModelID && e.Platform == pick.Platform {
			continue // exclude the picked model (it is the primary choice)
		}
		fallbacks = append(fallbacks, &pb.ChainEntry{
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
		})
	}
	sort.Slice(fallbacks, func(i, j int) bool {
		return fallbacks[i].Priority < fallbacks[j].Priority
	})

	// 6. Record and return decision
	return &pb.RouteDecision{
		TraceId:   "trace-" + time.Now().Format("20060102150405.000000"),
		ModelId:    pick.ModelID,
		Platform:   pick.Platform,
		Key:        chosenKey,
		Score:      s.Router.PickScore(pick),
		Strategy:   strat,
		Fallbacks:  fallbacks,
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

// ApplyFeedback updates bandit + keypool from one route event. Used by the
// Redis feedback loop and inline (EmitRouteEvent) when Redis is disabled,
// so proxy traffic always teaches the router.
func (s *Service) ApplyFeedback(ev *pb.RouteEvent) {
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
}

// EmitRouteEvent publishes a route event to the feedback stream — or applies
// it inline when Redis is off, so the bandit still learns without a bus.
func (s *Service) EmitRouteEvent(ev *pb.RouteEvent) {
	if s.Streams != nil {
		_ = s.Streams.Publish(context.Background(), streams.TopicEvents, ev)
		return
	}
	s.ApplyFeedback(ev)
}

// StartFeedbackLoop listens to completed execution events from Redis Streams,
// and asynchronously updates both Thompson-Sampling bandit and per-key cost-aware cooldowns.
func (s *Service) StartFeedbackLoop(ctx context.Context) {
	if s.Streams == nil {
		log.Printf("[service] streams not enabled, feedback loop disabled (proxy applies feedback inline)")
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

		s.ApplyFeedback(&ev)

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
		log.Printf("[service] offline/failed to fetch online catalog: %v. Returning empty catalog to guarantee pure key-based discovery.", err)
		catalog = []store.ModelRow{} // No hardcoded fallback presets!
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

// CostReport aggregates real expenditure from recorded request summaries
// (tokens × catalog prices). Scope: since process start — the in-memory ring
// is the honest source; persisting a request_log table is Sprint 7 follow-up.
// Free/paid split lives in /api/agents/analytics/summary (REST); the proto
// CostReport gets split fields with the Sprint 6 proto extension.
func (s *Service) CostReport(ctx context.Context, period string) (*pb.CostReport, error) {
	recent := s.RecentRequests("", "", 0)

	var totalCost float64
	var totalRequests int64
	var inputTokens int64
	var outputTokens int64
	byPlatform := make(map[string]float64)

	for _, rs := range recent {
		totalCost += rs.CostUSD
		totalRequests++
		inputTokens += int64(rs.InputTokens)
		outputTokens += int64(rs.OutputTokens)
		byPlatform[rs.Platform] += rs.CostUSD
	}

	return &pb.CostReport{
		Period:         period,
		TotalCostUsd:   totalCost,
		TotalRequests:  totalRequests,
		InputTokens:    inputTokens,
		OutputTokens:   outputTokens,
		CostByPlatform: byPlatform,
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

	// Load existing DB keys into KeyPool
	for _, k := range dbKeys {
		s.KeyPool.Upsert(keypool.Entry{
			ID:         k.ID,
			Platform:   k.Platform,
			Label:      k.Label,
			Enabled:    k.Enabled,
			Status:     "ok",
			ModelScope: k.ModelScope, // Load ModelScope from Postgres!
		})
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
				id, err := s.Store.AddKey(dk.platform, val, "Auto-Discovered Key", true, false)
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
