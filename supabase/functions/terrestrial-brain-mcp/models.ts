// Model IDs are configurable so calls can route through a gateway (e.g. OmniRoute expects
// "openrouter/openai/gpt-4o-mini"). Defaults preserve direct-OpenRouter behavior.
export const CHAT_MODEL = Deno.env.get("TB_CHAT_MODEL") || "openai/gpt-4o-mini";
export const EMBEDDING_MODEL = Deno.env.get("TB_EMBEDDING_MODEL") || "openai/text-embedding-3-small";
