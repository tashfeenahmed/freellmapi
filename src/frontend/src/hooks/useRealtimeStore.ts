import { useState, useEffect } from 'react';

/**
 * Smart Real-Time Store
 * Only subscribes to data that's currently visible
 * Uses SSE for real-time updates with automatic reconnection
 */

export interface RoutingScore {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  reliability: number;
  speed: number;
  intelligence: number;
  headroom: number;
  rateLimit: number;
  score: number;
  totalRequests: number;
}

export interface ModelRequest {
  id: number;
  created_at: string;
  platform: string;
  model_id: string;
  status: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
}

export interface Trace {
  id: number;
  created_at: string;
  platform: string;
  model_id: string;
  status: string;
  error_type?: string;
  latency_ms: number;
}

/**
 * SSE Connection Manager
 * Manages EventSource connections based on visibility
 * Only opens connections for visible data
 */
class SSEConnectionManager {
  private connections: Map<string, EventSource> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  /**
   * Open SSE connection if not already open
   */
  connect(
    key: string,
    url: string,
    onMessage: (data: any) => void,
    onStatus: (connected: boolean) => void
  ) {
    if (this.connections.has(key)) {
      return; // Already connected
    }

    try {
      const eventSource = new EventSource(url, { withCredentials: true });

      eventSource.addEventListener('open', () => {
        this.reconnectAttempts.set(key, 0);
        onStatus(true);
      });

      eventSource.addEventListener('error', () => {
        onStatus(false);
        this.handleReconnect(key, url, onMessage, onStatus);
      });

      // Listen for specific events
      eventSource.addEventListener('scores', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onMessage(data);
        } catch (err) {
          // Silent fail
        }
      });

      eventSource.addEventListener('requests', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onMessage(data);
        } catch (err) {
          // Silent fail
        }
      });

      eventSource.addEventListener('traces', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onMessage(data);
        } catch (err) {
          // Silent fail
        }
      });

      this.connections.set(key, eventSource);
    } catch (err) {
      onStatus(false);
    }
  }

  /**
   * Close SSE connection
   */
  disconnect(key: string) {
    const conn = this.connections.get(key);
    if (conn) {
      conn.close();
      this.connections.delete(key);
      this.reconnectAttempts.delete(key);
    }
  }

  /**
   * Handle reconnection with exponential backoff
   */
  private handleReconnect(
    key: string,
    url: string,
    onMessage: (data: any) => void,
    onStatus: (connected: boolean) => void
  ) {
    const attempts = this.reconnectAttempts.get(key) || 0;

    if (attempts >= this.maxReconnectAttempts) {
      return;
    }

    this.reconnectAttempts.set(key, attempts + 1);
    this.disconnect(key);

    setTimeout(() => {
      this.connect(key, url, onMessage, onStatus);
    }, this.reconnectDelay * Math.pow(2, attempts));
  }

  /**
   * Close all connections
   */
  disconnectAll() {
    this.connections.forEach((conn) => {
      conn.close();
    });
    this.connections.clear();
    this.reconnectAttempts.clear();
  }
}

const sseManager = new SSEConnectionManager();

/**
 * Hook for real-time routing scores
 * Only connects when component is mounted
 */
export function useRealtimeScores() {
  const [scores, setScores] = useState<RoutingScore[]>([]);
  const [connected, setConnected] = useState(false);
  const [strategy, setStrategy] = useState<string>('balanced');

  useEffect(() => {
    // Open SSE connection
    sseManager.connect(
      'scores',
      '/api/sse/analytics',
      (data) => {
        if (data.scores) {
          setScores(data.scores);
        }
        if (data.strategy) {
          setStrategy(data.strategy);
        }
      },
      setConnected
    );

    // Cleanup on unmount
    return () => {
      sseManager.disconnect('scores');
    };
  }, []);

  return { scores, connected, strategy };
}

/**
 * Hook for real-time model requests
 * Only connects when component is mounted
 */
export function useRealtimeRequests() {
  const [requests, setRequests] = useState<ModelRequest[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    sseManager.connect(
      'models',
      '/api/sse/models',
      (data) => {
        if (Array.isArray(data)) {
          setRequests(data);
        }
      },
      setConnected
    );

    return () => {
      sseManager.disconnect('models');
    };
  }, []);

  return { requests, connected };
}

/**
 * Hook for real-time traces
 * Only connects when component is mounted
 */
export function useRealtimeTraces() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    sseManager.connect(
      'traces',
      '/api/sse/traces',
      (data) => {
        if (Array.isArray(data)) {
          setTraces(data);
        }
      },
      setConnected
    );

    return () => {
      sseManager.disconnect('traces');
    };
  }, []);

  return { traces, connected };
}
