// Package streams implements Redis Streams-backed pub/sub for the mesh.
// Producers XADD into `jimesh:{topic}`; gRPC server-streaming RPCs tail the
// streams with consumer groups. Unlike plain Pub/Sub, Streams persist events
// and allow replay / multiple consumer groups.
package streams

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	TopicEvents   = "jimesh:events"   // RouteEvent JSON
	TopicScores   = "jimesh:scores"   // ScoreSnapshot JSON
	TopicHealth   = "jimesh:health"   // ProviderHealth JSON
	TopicRequests = "jimesh:requests" // completed request summaries
)

// Hub wraps a redis client and offers typed Publish/Tail helpers.
type Hub struct {
	rdb *redis.Client
	mu  sync.Mutex
	maxLen int64
}

// New connects to REDIS_URL (default redis://localhost:6379).
func New() (*Hub, error) {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		url = "redis://localhost:6379"
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	rdb := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	log.Printf("[streams] connected to %s", url)
	return &Hub{rdb: rdb, maxLen: 100_000}, nil
}

// Ping reports connectivity for /health.
func (h *Hub) Ping(ctx context.Context) error {
	return h.rdb.Ping(ctx).Err()
}

// Close closes the Redis client connection.
func (h *Hub) Close() error {
	return h.rdb.Close()
}

// Publish marshals v to JSON and XADDs it onto topic (capped stream).
// Best-effort: returns error but never panics; callers log & continue.
func (h *Hub) Publish(ctx context.Context, topic string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	h.mu.Lock()
	maxLen := h.maxLen
	h.mu.Unlock()
	return h.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: topic,
		MaxLen: maxLen,
		Approx: true,
		Values: map[string]any{"data": b},
	}).Err()
}

// Tail follows a stream from `start` ("" = new-only) and calls fn for every
// event until ctx is cancelled. Uses XREAD in a poll loop (simple + adequate:
// one read per ~50ms per active gRPC stream; consumer groups used by
// durable consumers via TailGroup).
func (h *Hub) Tail(ctx context.Context, topic, start string, fn func(id string, payload []byte)) {
	last := start
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		args := &redis.XReadArgs{
			Streams: []string{topic, blockOr(last, "$")},
			Count:   100,
			Block:   5 * time.Second,
		}
		if last != "" {
			args.Streams = []string{topic, last}
		}
		res, err := h.rdb.XRead(ctx, args).Result()
		if err != nil {
			if err == redis.Nil || ctx.Err() != nil {
				continue
			}
			// connection hiccup: back off
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}
		for _, s := range res {
			for _, msg := range s.Messages {
				last = msg.ID
				raw, _ := msg.Values["data"].(string)
				if raw == "" {
					if b, ok := msg.Values["data"].([]byte); ok {
						raw = string(b)
					}
				}
				if raw != "" {
					fn(msg.ID, []byte(raw))
				}
			}
		}
	}
}

// TailGroup consumes a stream via a consumer group (durable, replayable).
// group/consumer identify the subscriber; startID "0" replays history.
func (h *Hub) TailGroup(ctx context.Context, topic, group, consumer, startID string, fn func(id string, payload []byte)) {
	// create group if missing (MKSTREAM)
	if err := h.rdb.XGroupCreateMkStream(ctx, topic, group, startID).Err(); err != nil {
		if !strings.Contains(err.Error(), "BUSYGROUP") {
			log.Printf("[streams] group create %s/%s: %v", topic, group, err)
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		res, err := h.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    group,
			Consumer: consumer,
			Streams:  []string{topic, ">"},
			Count:    100,
			Block:    5 * time.Second,
		}).Result()
		if err != nil {
			if err == redis.Nil || ctx.Err() != nil {
				continue
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}
		for _, s := range res {
			for _, msg := range s.Messages {
				raw, _ := msg.Values["data"].(string)
				if raw == "" {
					if b, ok := msg.Values["data"].([]byte); ok {
						raw = string(b)
					}
				}
				if raw != "" {
					fn(msg.ID, []byte(raw))
				}
				_ = h.rdb.XAck(ctx, topic, group, msg.ID).Err()
			}
		}
	}
}

// Trim caps a stream length (called periodically).
func (h *Hub) Trim(ctx context.Context, topic string, maxLen int64) {
	_ = h.rdb.XTrimMaxLen(ctx, topic, maxLen).Err()
}

// Enqueue pushes a job onto a Redis list (used for provider health checks).
func (h *Hub) Enqueue(ctx context.Context, queue string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return h.rdb.LPush(ctx, queue, b).Err()
}

// Dequeue blocks popping a job (BRPOP with 5s timeout).
func (h *Hub) Dequeue(ctx context.Context, queue string) ([]byte, bool) {
	res, err := h.rdb.BRPop(ctx, 5*time.Second, queue).Result()
	if err != nil || len(res) < 2 {
		return nil, false
	}
	return []byte(res[1]), true
}

func blockOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func envInt(name string, def int64) int64 {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}
