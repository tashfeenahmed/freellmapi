import { describe, expect, it } from 'vitest';
import { endpointHost, providerDisplayName, providerIdFor } from '../../lib/provider-identity.js';
import { endpointScopeForBaseUrl } from '../../lib/endpoint-scope.js';

describe('provider-identity', () => {
  describe('endpointHost', () => {
    it('returns the host (and port) of a base_url', () => {
      expect(endpointHost('https://relay.example.com/v1')).toBe('relay.example.com');
      expect(endpointHost('http://192.168.1.10:11434/v1')).toBe('192.168.1.10:11434');
      expect(endpointHost('https://api.openrouter.ai')).toBe('api.openrouter.ai');
    });

    it('returns null for empty or unparseable input', () => {
      expect(endpointHost(null)).toBeNull();
      expect(endpointHost(undefined)).toBeNull();
      expect(endpointHost('')).toBeNull();
      expect(endpointHost('not a url')).toBeNull();
    });
  });

  describe('providerIdFor', () => {
    it('keeps the bare platform slug for catalog providers', () => {
      expect(providerIdFor('groq', null)).toBe('groq');
      expect(providerIdFor('openai', null)).toBe('openai');
    });

    it('names a custom endpoint by its base_url so relays never collide', () => {
      expect(providerIdFor('custom', 'https://relay-a.example.com/v1')).toBe('custom:https://relay-a.example.com/v1');
      expect(providerIdFor('custom', 'https://relay-b.example.com/v1')).toBe('custom:https://relay-b.example.com/v1');
      // Two distinct relays → two distinct ids (the #889 collision).
      expect(providerIdFor('custom', 'https://relay-a.example.com/v1'))
        .not.toBe(providerIdFor('custom', 'https://relay-b.example.com/v1'));
    });

    it('falls back to the plain "custom" id when the key is gone', () => {
      expect(providerIdFor('custom', null)).toBe('custom');
      expect(providerIdFor('custom', undefined)).toBe('custom');
      expect(providerIdFor('custom', '')).toBe('custom');
    });

    it('is the endpoint-scope token verbatim', () => {
      // The caller hands in the NORMALIZED base_url (keys.ts on write, the SQL
      // in routes/analytics.ts for older rows), so the id matches
      // `models.endpoint_scope` for the same endpoint and this module needs no
      // second definition of "same endpoint" of its own.
      expect(providerIdFor('custom', endpointScopeForBaseUrl('https://relay-a.example.com/v1/')))
        .toBe('custom:https://relay-a.example.com/v1');
    });
  });

  describe('providerDisplayName', () => {
    it('shows the endpoint host for custom rows', () => {
      expect(providerDisplayName('custom', 'https://relay-a.example.com/v1')).toBe('relay-a.example.com');
      expect(providerDisplayName('custom', 'http://192.168.1.10:11434/v1')).toBe('192.168.1.10:11434');
    });

    it('falls back to the platform when the host cannot be derived', () => {
      expect(providerDisplayName('custom', null)).toBe('custom');
      expect(providerDisplayName('custom', 'garbage')).toBe('custom');
    });

    it('shows the platform slug for catalog providers', () => {
      expect(providerDisplayName('groq', null)).toBe('groq');
    });

    it('keeps the path when it, not the host, is what tells endpoints apart', () => {
      // One gateway fronting two tenants: the host is identical, so a
      // host-only name would collide and the operator could not tell the rows
      // apart — #889 all over again, one level down.
      const a = providerDisplayName('custom', 'https://gw.example.com/tenant-a/v1');
      const b = providerDisplayName('custom', 'https://gw.example.com/tenant-b/v1');
      expect(a).toBe('gw.example.com/tenant-a/v1');
      expect(b).toBe('gw.example.com/tenant-b/v1');
      expect(a).not.toBe(b);
    });

    it('drops only a trivial path, so the common case still reads as a host', () => {
      // '/', '/v1', '/v1beta' say nothing a second endpoint on the host would
      // not also say, so they are noise in the single-endpoint-per-host case.
      expect(providerDisplayName('custom', 'https://relay.example.com')).toBe('relay.example.com');
      expect(providerDisplayName('custom', 'https://relay.example.com/')).toBe('relay.example.com');
      expect(providerDisplayName('custom', 'https://relay.example.com/v1')).toBe('relay.example.com');
      expect(providerDisplayName('custom', 'https://relay.example.com/v1beta')).toBe('relay.example.com');
      expect(providerDisplayName('custom', 'http://192.168.1.10:11434/v1')).toBe('192.168.1.10:11434');
    });

    it('does not collapse a kept path onto its own versioned form', () => {
      // Trimming the '/v1' off a KEPT path would make these two endpoints
      // display the same name, which is the collision this exists to prevent.
      expect(providerDisplayName('custom', 'https://gw.example.com/tenant-a'))
        .not.toBe(providerDisplayName('custom', 'https://gw.example.com/tenant-a/v1'));
    });

    it('names an endpoint the same way no matter which other endpoints exist', () => {
      // Purely a function of this row's base_url (like endpoint-scope's
      // handles), so /by-platform, /by-model and /errors agree on the name
      // even though each sees a different subset of endpoints.
      expect(providerDisplayName('custom', 'https://relay-a.example.com/v1/'))
        .toBe(providerDisplayName('custom', 'https://relay-a.example.com/v1'));
    });
  });
});
