package gateway

import (
	"strconv"
	"strings"
)

// providerChatURL maps a platform to its chat/completions endpoint.
// Sprint 6 fix: preset platforms (groq, mistral, opencode, …) previously fell
// through to the OpenAI default in the chat proxy and 401'd — only openai,
// gemini, deepseek, openrouter and custom had cases. One table, used by the
// REST chat proxy, the WS variant and the probe.
func providerChatURL(platform string) string {
	switch platform {
	case "openai":
		return "https://api.openai.com/v1/chat/completions"
	case "gemini", "google":
		return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
	case "deepseek":
		return "https://api.deepseek.com/v1/chat/completions"
	case "openrouter":
		return "https://openrouter.ai/api/v1/chat/completions"
	case "groq":
		return "https://api.groq.com/openai/v1/chat/completions"
	case "mistral":
		return "https://api.mistral.ai/v1/chat/completions"
	case "nvidia":
		return "https://integrate.api.nvidia.com/v1/chat/completions"
	case "github":
		return "https://models.inference.ai.azure.com/chat/completions"
	case "cerebras":
		return "https://api.cerebras.ai/v1/chat/completions"
	case "cohere":
		return "https://api.cohere.ai/v1/chat/completions"
	case "opencode":
		return "https://api.opencode.ai/v1/chat/completions"
	case "routeway":
		return "https://api.routeway.ai/v1/chat/completions"
	case "unorouter":
		return "https://api.unorouter.ai/v1/chat/completions"
	case "orcarouter":
		return "https://api.orcarouter.ai/v1/chat/completions"
	case "bai":
		return "https://api.b.ai/v1/chat/completions"
	case "pollinations":
		return "https://text.pollinations.ai/openai/v1/chat/completions"
	}
	return ""
}

// fallbackBaseURLForPlatform maps a platform to its default base API URL (Sprint 6/7 helper).
func fallbackBaseURLForPlatform(platform string) string {
	chatURL := providerChatURL(platform)
	if chatURL == "" {
		return ""
	}
	return strings.TrimSuffix(chatURL, "/chat/completions")
}

// providerEmbeddingsURL maps a platform to its embeddings endpoint.
func providerEmbeddingsURL(platform string) string {
	switch platform {
	case "openai":
		return "https://api.openai.com/v1/embeddings"
	case "gemini", "google":
		return "https://generativelanguage.googleapis.com/v1beta/openai/embeddings"
	case "deepseek":
		return "https://api.deepseek.com/v1/embeddings"
	case "mistral":
		return "https://api.mistral.ai/v1/embeddings"
	}
	return ""
}

// resolveChatTargetURL picks the upstream chat URL for a routing decision:
//  1. known platform table
//  2. the key's stored custom_base_url (named custom providers, "custom")
//  3. legacy defaults: "custom" → local Ollama, anything else → OpenAI
func (s *Server) resolveChatTargetURL(platform string, keyID int64) string {
	if u := providerChatURL(platform); u != "" {
		return u
	}
	if u := s.customBaseURLPath(keyID, "/chat/completions"); u != "" {
		return u
	}
	if platform == "custom" {
		return "http://localhost:11434/v1/chat/completions"
	}
	return "https://api.openai.com/v1/chat/completions"
}

// resolveEmbeddingsTargetURL is the embeddings sibling of resolveChatTargetURL.
func (s *Server) resolveEmbeddingsTargetURL(platform string, keyID int64) string {
	if u := providerEmbeddingsURL(platform); u != "" {
		return u
	}
	if u := s.customBaseURLPath(keyID, "/embeddings"); u != "" {
		return u
	}
	return "https://api.openai.com/v1/embeddings"
}

// customBaseURLPath resolves a key-scoped custom base URL and appends a path.
// Named providers (Sprint 6) live here: any platform not in the preset table
// with a stored custom_base_url routes to that endpoint.
func (s *Server) customBaseURLPath(keyID int64, path string) string {
	if keyID == 0 {
		return ""
	}
	base, err := s.svc.Store.GetSetting("custom_base_url:" + strconv.FormatInt(keyID, 10))
	if err != nil || base == "" {
		return ""
	}
	return strings.TrimSuffix(base, "/") + path
}
