// Package keypool implements cost-aware per-key cooldown, ported from
// server/src/services/keyPool.ts. Keys enter cooldown on 429/402; free models
// get short cooldowns, expensive ones longer ones.
package keypool

import (
	"sync"
	"time"
)

// Entry is one API key.
type Entry struct {
	ID            int64     `json:"id"`
	Platform      string    `json:"platform"`
	Label         string    `json:"label"`
	Enabled       bool      `json:"enabled"`
	Status        string    `json:"status"` // ok|cooldown|disabled
	CooldownUntil time.Time `json:"cooldown_until"`
	Successes     int64     `json:"successes"`
	Failures      int64     `json:"failures"`
	TotalRequests int64     `json:"total_requests"`

	// Beta posterior (mirrors orderKeysByScore in router.ts)
	Reliability float64 `json:"reliability"` // 0..1
	Speed       float64 `json:"speed"`       // 0..1
}

// Pool is a concurrent-safe key registry with cost-aware cooldowns.
type Pool struct {
	mu    sync.RWMutex
	keys  map[int64]*Entry // by key id
	byPlat map[string][]int64
}

func New() *Pool {
	return &Pool{keys: map[int64]*Entry{}, byPlat: map[string][]int64{}}
}

// Upsert registers/updates a key.
func (p *Pool) Upsert(e Entry) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if old, ok := p.keys[e.ID]; ok {
		e.Successes = old.Successes
		e.Failures = old.Failures
		e.TotalRequests = old.TotalRequests
		e.Reliability = old.Reliability
		e.Speed = old.Speed
		if e.Label == "" {
			e.Label = old.Label
		}
	}
	if e.Reliability == 0 {
		e.Reliability = 0.5 // uninformative prior
	}
	if e.Speed == 0 {
		e.Speed = 0.5
	}
	e.Status = "ok"
	if !e.Enabled {
		e.Status = "disabled"
	}
	p.keys[e.ID] = &e
	list := p.byPlat[e.Platform]
	for i, id := range list {
		if id == e.ID {
			list[i] = e.ID
			return
		}
	}
	p.byPlat[e.Platform] = append(list, e.ID)
}

// AvailableKeys returns non-cooldown, enabled keys for a platform ordered by
// score (0.6*reliability + 0.4*speed), best first — mirrors orderKeysByScore.
func (p *Pool) AvailableKeys(platform string) []*Entry {
	p.mu.RLock()
	defer p.mu.RUnlock()
	now := time.Now()
	var out []*Entry
	for _, id := range p.byPlat[platform] {
		e := p.keys[id]
		if e == nil || !e.Enabled {
			continue
		}
		if e.CooldownUntil.After(now) {
			continue
		}
		out = append(out, e)
	}
	// sort by score desc (insertion sort; key counts are small)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && score(out[j]) > score(out[j-1]); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func score(e *Entry) float64 { return 0.6*e.Reliability + 0.4*e.Speed }

// RateLimited puts a key into cost-aware cooldown. Free models recover fast,
// expensive ones longer (mirrors keyPool.ts cooldown table).
func (p *Pool) RateLimited(keyID int64, modelCostPerM float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.keys[keyID]
	if !ok {
		return
	}
	d := cooldownFor(modelCostPerM)
	e.CooldownUntil = time.Now().Add(d)
	e.Status = "cooldown"
	e.Failures++
	e.TotalRequests++
}

// QuotaExhausted: long cooldown (402).
func (p *Pool) QuotaExhausted(keyID int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.keys[keyID]
	if !ok {
		return
	}
	e.CooldownUntil = time.Now().Add(10 * time.Minute)
	e.Status = "cooldown"
	e.Failures++
	e.TotalRequests++
}

// Success clears cooldown and nudges the reliability posterior up.
func (p *Pool) Success(keyID int64, latencyMs int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.keys[keyID]
	if !ok {
		return
	}
	e.CooldownUntil = time.Time{}
	e.Status = "ok"
	e.Successes++
	e.TotalRequests++
	// EMA reliability/speed updates
	e.Reliability = ema(e.Reliability, 1.0, 0.1)
	// normalize speed: 1s -> 1.0, 10s+ -> ~0.1
	sp := normSpeed(latencyMs)
	e.Speed = ema(e.Speed, sp, 0.1)
}

func ema(old, v, alpha float64) float64 { return alpha*v + (1-alpha)*old }

func normSpeed(latencyMs int64) float64 {
	s := float64(latencyMs) / 1000.0
	if s < 0.2 {
		s = 0.2
	}
	v := 1.0 / s
	if v > 1 {
		v = 1
	}
	return v
}

// cooldownFor mirrors keyPool.ts: free -> 5s, cheap -> 30s, mid -> 60s, pricey -> 5m.
func cooldownFor(costPerM float64) time.Duration {
	switch {
	case costPerM <= 0: // free
		return 5 * time.Second
	case costPerM < 0.5:
		return 30 * time.Second
	case costPerM < 3.0:
		return 60 * time.Second
	default:
		return 5 * time.Minute
	}
}

// All returns a snapshot of every key.
func (p *Pool) All() []Entry {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]Entry, 0, len(p.keys))
	for _, e := range p.keys {
		out = append(out, *e)
	}
	return out
}
