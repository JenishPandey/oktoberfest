export const DEFAULT_SETTINGS = {
  tunnelUrl: "https://requests-reality-geometry-middle.trycloudflare.com", // temporary link — replace anytime in Settings
  apiKey: "",      // option for api code — pasted on entry or in Settings
  model: "diplomacy-agent:latest", // purpose-built Gemma-12B brain; alt: "gemma4:12b-it-qat"
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
