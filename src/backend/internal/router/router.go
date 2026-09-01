// Package router implements the Thompson-Sampling bandit that scores
// model+key pairs for routing decisions. Ported from server/src/services/router.ts.
package router

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"sync"
	"time"
)

// Bandit priors (mirrors scoring.ts: PRIOR_SUCCESS=1, PRIOR_FAILURE=1)
const (
	PriorSuccess    = 1.0
	PriorFailure    = 1.0
	ExploreChance   = 0.10 // 10% probe rate
	ExploreMinSamples = 5  // only probe entries with >= 5 samples... actually probe UNTIL 5 samples
)

// Stats holds the decayed beta posterior for one model+platform pair.
type Stats struct {
	Successes  int64   `json:"successes"`
	Failures   int64   `json:"failures"`
	SpeedSum   float64 `json:"speed_sum"` // sum of normalized inverse latencies
	Samples    int64   `json:"samples"`
	LastUsedMs int64   `json:"last_used_ms"`
}

// Mean returns the beta posterior mean: (a)/(a+b).
func (s Stats) Mean() float64 {
	a := float64(s.Successes) + PriorSuccess
	b := float64(s.Failures) + PriorFailure
	if a+b <= 0 {
		return 0.5
	}
	return a / (a + b)
}

// SpeedScore returns the average normalized speed (0..1).
func (s Stats) SpeedScore() float64 {
	if s.Samples == 0 {
		return 0.5
	}
	return s.SpeedSum / float64(s.Samples)
}

// Score is the routing weight: 0.6*reliability + 0.4*speed.
func (s Stats) Score() float64 {
	return 0.6*s.Mean() + 0.4*s.SpeedScore()
}

// Store keeps stats per "platform:model_id".
type Store struct {
	mu    sync.RWMutex
	stats map[string]*Stats
	// decayHalfLifeMs controls exponential decay applied on read
	decayHalfLifeMs int64
}

func NewStore() *Store {
	return &Store{
		stats:           make(map[string]*Stats),
		decayHalfLifeMs: int64(2 * 24 * time.Hour / time.Millisecond), // 2-day half-life, mirrors router.ts
	}
}

func key(platform, modelID string) string { return platform + ":" + modelID }

// Get returns (copy-of) stats for a pair.
func (st *Store) Get(platform, modelID string) Stats {
	st.mu.RLock()
	defer st.mu.RUnlock()
	if s, ok := st.stats[key(platform, modelID)]; ok {
		return *s
	}
	return Stats{}
}

// RecordSuccess applies decay then increments the posterior.
func (st *Store) RecordSuccess(platform, modelID string, latencyMs int64, speedNorm float64) {
	st.mu.Lock()
	defer st.mu.Unlock()
	k := key(platform, modelID)
	s, ok := st.stats[k]
	if !ok {
		s = &Stats{}
		st.stats[k] = s
	}
	st.applyDecay(s)
	s.Successes++
	s.Samples++
	s.SpeedSum += clamp01(speedNorm)
	s.LastUsedMs = time.Now().UnixMilli()
}

// RecordFailure applies decay then increments failures.
func (st *Store) RecordFailure(platform, modelID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	k := key(platform, modelID)
	s, ok := st.stats[k]
	if !ok {
		s = &Stats{}
		st.stats[k] = s
	}
	st.applyDecay(s)
	s.Failures++
	s.Samples++
	s.LastUsedMs = time.Now().UnixMilli()
}

// applyDecay exponentially decays old evidence so recent behavior dominates.
// Must be called with the lock held.
func (st *Store) applyDecay(s *Stats) {
	now := time.Now().UnixMilli()
	if s.LastUsedMs == 0 || now <= s.LastUsedMs {
		return
	}
	halflifes := float64(now-s.LastUsedMs) / float64(st.decayHalfLifeMs)
	f := 0.5
	for i := 0; i < int(halflifes) && i < 30; i++ { // cap iterations
		f *= 0.5
	}
	if halflifes < 1 {
		f = 1 - (halflifes)*0.5
	}
	s.Successes = int64(float64(s.Successes) * f)
	s.Failures = int64(float64(s.Failures) * f)
	s.Samples = int64(float64(s.Samples) * f)
	s.SpeedSum *= f
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func rand01() float64 {
	return rand.Float64()
}

// Snapshot exports all stats (for /scores endpoints + Redis publishing).
func (st *Store) Snapshot() map[string]Stats {
	st.mu.RLock()
	defer st.mu.RUnlock()
	out := make(map[string]Stats, len(st.stats))
	for k, v := range st.stats {
		out[k] = *v
	}
	return out
}

// PickScore returns the routing weight of the chosen candidate.
func (st *Store) PickScore(cand *Candidate) float64 {
	return st.Get(cand.Platform, cand.ModelID).Score()
}

// MarshalJSON for persistence/Redis.
func (st *Store) MarshalJSON() ([]byte, error) {
	return json.Marshal(st.Snapshot())
}

// Pick implements explore/exploit:
//   - entries with < ExploreMinSamples samples are always probed (cold-start)
//   - otherwise 10% chance to explore the least-sampled entry
//   - else exploit: highest Score()
func (st *Store) Pick(candidates []Candidate) (*Candidate, string) {
	if len(candidates) == 0 {
		return nil, ""
	}
	// cold-start probe
	for i := range candidates {
		s := st.Get(candidates[i].Platform, candidates[i].ModelID)
		if s.Samples < ExploreMinSamples {
			return &candidates[i], "prior"
		}
	}
	// exploration
	if rand01() < ExploreChance {
		least := 0
		leastSamples := int64(1<<62 - 1)
		for i := range candidates {
			s := st.Get(candidates[i].Platform, candidates[i].ModelID)
			if s.Samples < leastSamples {
				leastSamples = s.Samples
				least = i
			}
		}
		return &candidates[least], "explore"
	}
	// exploit
	best := 0
	bestScore := -1.0
	for i := range candidates {
		s := st.Get(candidates[i].Platform, candidates[i].ModelID)
		sc := s.Score()
		if sc > bestScore {
			bestScore = sc
			best = i
		}
	}
	return &candidates[best], "exploit"
}

// Candidate is one routable model entry.
type Candidate struct {
	ModelID    string  `json:"model_id"`
	Platform   string  `json:"platform"`
	ChainID    string  `json:"chain_id,omitempty"`
	Priority   int32   `json:"priority"`
	Vision     bool    `json:"vision"`
	Tools      bool    `json:"tools"`
	InputPerM  float64 `json:"input_per_m"`
	OutputPerM float64 `json:"output_per_m"`
}

func (c Candidate) String() string {
	return fmt.Sprintf("%s@%s(prio=%d)", c.ModelID, c.Platform, c.Priority)
}
