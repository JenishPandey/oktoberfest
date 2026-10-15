export const DEFAULT_SETTINGS = {
  provider: "gemini", // "gemini" (Google via same-origin /api/gemini proxy) | "tunnel" (legacy Ollama)
  tunnelUrl: "", // legacy Ollama tunnel — only used when provider === "tunnel"
  apiKey: "",      // optional: direct-browser Gemini key. Blank = use server proxy (recommended, key stays server-side)
  model: "gemini-3.5-flash-lite", // high-usage pick: fastest/cheapest Flash-Lite, 15 RPM / 500 RPD free tier. Alt: "gemini-3.8-flash" (smarter, 5 RPM / 20 RPD)
  pollIntervalSec: 8,
  talkDurationSec: 30,
};

const KEY = "alliance_arena_settings_v2";

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
