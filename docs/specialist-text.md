# Specialist text API

OVH translation and summarization are explicit tasks. They are not general chat models and do not take part in automatic chat fallback. Availability follows your signed catalog tier.

Use your local inference key as a Bearer token. GET /v1/text/models lists the enabled specialists and their task. POST /v1/text/translate with JSON containing model, input, source_language and target_language (for example en and fr). POST /v1/text/summarize takes model and input. Use the exact model ID from the list. Both return model, task and output; set stream to true to receive upstream chat-completion SSE instead. Profiles requiring a system prompt cannot call these fixed-task endpoints.
