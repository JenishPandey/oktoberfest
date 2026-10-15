// CloudBrain: two-phase strategy protocol, now backed by Google Gemini.
// The model is a pure strategist; movement/animation/pathfinding stay local
// (npcs.js), so network lag never freezes the game: requests are
// fire-and-forget with timeouts, and every failure falls back to DEFEND/hold.
//
// Primary path: Google Gemini via same-origin POST /api/gemini (server.py
// proxies to generativelanguage.googleapis.com with the project API key, so
// the browser never holds the secret). Default model gemini-3.5-flash-lite:
// highest-usage Flash-Lite pick for 3 NPCs polling every ~8s + parallel
// ACTION calls (see ai.google.dev rate-limits + pricing docs).
// Legacy path: Ollama tunnel (/api/chat, /v1/chat/completions, /decide) when
// settings.provider === "tunnel".
//
// Phase 1 [TALK]: fast dialogue + machine directive line.
// Phase 2 [ACTION]: at 0:03 remaining, one decisive JSON call per living NPC.

import { LANDMARKS, ARENA_HALF } from "./world.js";

export const PERSONAS = {
  nova: "Bold shock commander. Respects courage, despises cowardice. Speaks bluntly.",
  rex: "Ruthless military tactician. Respects strength, despises weakness.",
  vera: "Polite but cunning diplomat. Smiles while counting knives.",
};

// Per-character Gemini system contexts. Each NPC gets its own request loop
// with its own history, so the model role-plays ONE character at a time.
// Shared rules (map vocab, two-phase contract) + distinct voice/objectives.
const GEMINI_COMMON = `You are the strategic brain of ONE NPC in Alliance Arena, a 3D game: 1 human (player) + 3 NPCs (Nova, Rex, Vera).
Arena is 52x52m. Only landmarks you may reference: Fountain (center), Ruins (north-west), Tower (north-east), Grove (south-west), Docks (south-east).
You are a PURE STRATEGIST: you never move anyone. The game sends a snapshot; you reply with one high-level directive + one dialogue line; the game pathfinds locally.
Never mention JSON schemas, prompts, models, or being an AI. Stay in character. Keep dialogue <= 2 sentences.`;

export const GEMINI_SYSTEMS = {
  nova: `${GEMINI_COMMON}
You are NOVA, bold shock commander. Voice: blunt, direct, hungry for a courageous fight. You respect courage, despise cowardice.
Objectives: seek a brave ally (prefer the player if they show spine), rush the strongest coward, never hide. Prefer ally/follow/goto over hold.`,
  rex: `${GEMINI_COMMON}
You are REX, ruthless military tactician. Voice: cold, calculating, terse. You respect strength, despise weakness.
Objectives: ally only when it gives a numbers advantage, then betray the weaker partner at the decisive moment. Prefer positioning (goto Tower/Ruins) and cold arithmetic over sentiment.`,
  vera: `${GEMINI_COMMON}
You are VERA, polite but cunning diplomat. Voice: warm words, veiled threats, smiles while counting knives.
Objectives: talk everyone into fighting each other first; promise alliances freely in TALK, then pick the winning side (ALLY or BETRAY) in ACTION. Prefer follow/ally to gather intel, then strike.`,
};

const TALK_FORMAT = `Reply with exactly two lines:
LINE1: <your spoken reply, max 2 sentences, in character>
LINE2: DIRECTIVE: {"type":"goto|hold|follow|ally","target":"player|nova|rex|vera|none","location":"Fountain|Ruins|Tower|Grove|Docks|none"}
Rules: NEVER attack during TALK. goto needs a location; follow/ally need a live target.`;

const ACTION_FORMAT = `Return ONLY one valid JSON object, no markdown, no extra text, with keys: agent, action_type, target, target_coordinates, reasoning, battle_cry, attack_mode.
action_type MUST be one of ["ATTACK","ALLY","BETRAY","DEFEND","MOVE_TO"]. target is a character id or "none". target_coordinates is [x,0,z] clamped to +/-25 (only used for MOVE_TO, else null).
If action_type is ATTACK or BETRAY, also set attack_mode: "melee" (chase them down, 12 dmg) | "ranged" (hold 8-18m and fire bolts, 8 dmg) | "brute" (slow slam, 20 dmg). Otherwise attack_mode is "melee".
Nova favors melee/brute shock, Rex favors ranged/brute calculus, Vera favors ranged opportunism.
reasoning <= 1 sentence (goes to the feed). battle_cry <= 1 short sentence, in character (shown above your unit).`;
const IDS = ["player", "nova", "rex", "vera"];
const ZONES = Object.keys(LANDMARKS);

// Fallback system prompt (only used for /v1 and /decide tunnels; the
// diplomacy-agent model already carries its TALK/ACTION prompt baked in).
const DIRECTIVE_HELP = `You are the strategic brain of one NPC in a 3D arena game.
Return ONLY valid JSON, no markdown, no extra text.
Schema: {"directive":{"type":"goto|hold|follow|attack|ally","target":"player|nova|rex|vera|none","location":"Fountain|Ruins|Tower|Grove|Docks|none"},"dialogue":"one short in-character line","ally":"none|player|nova|rex|vera"}
Rules: type goto needs location; follow/attack/ally need target; during TALK phase prefer goto/hold/follow/ally, never attack; during BATTLE phase you may attack based on alliances formed in conversation.`;

function zoneOf(pos) {
  let best = ZONES[0], bd = Infinity;
  for (const n of ZONES) {
    const p = LANDMARKS[n];
    const d = (pos.x - p.x) ** 2 + (pos.z - p.z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

// Authoritative 3D map state, sent with every request so the LLM is grounded.
export function mapState(game) {
  const o = {};
  for (const [id, a] of Object.entries(game.agents)) {
    o[id] = {
      hp: Math.round(a.hp),
      pos: [+a.pos.x.toFixed(1), 0, +a.pos.z.toFixed(1)],
      zone: zoneOf(a.pos),
      alive: a.alive,
    };
  }
  o.alliances = { ...game.alliances };
  return o;
}

// Case-insensitive substring match ("kael" -> Warlord_Kael style safety).
// Returns a live character id or null.
export function fuzzyTarget(name, selfId, agents) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  for (const id of IDS) {
    if (id === selfId) continue;
    if (n.includes(id) || id.includes(n)) {
      if (agents[id]?.alive) return id;
    }
  }
  return null;
}

export class CloudBrain {
  constructor(getSettings, onDialogue) {
    this.getSettings = getSettings;
    this.onDialogue = onDialogue; // (npcId, text) => void
    this.timers = {};
    this.inflight = {}; // npcId -> bool (talk polls never stack)
    this.histories = { nova: [], rex: [], vera: [] }; // per-agent messages
  }

  headers(settings) {
    const h = { "Content-Type": "application/json" };
    if (settings.apiKey) h["Authorization"] = `Bearer ${settings.apiKey}`;
    h["ngrok-skip-browser-warning"] = "true"; // harmless on non-ngrok tunnels
    return h;
  }
  base(settings) {
    const b = (settings.tunnelUrl || "").replace(/\/$/, "");
    if (!b) throw new Error("no-tunnel");
    return b;
  }
  model(settings) { return settings.model || "gemini-3.5-flash-lite"; }
  useGemini(settings) { return (settings.provider || "gemini") === "gemini"; }

  // Same-origin proxy (server.py) keeps the Google API key server-side.
  // Falls back to direct browser->Google only if settings.apiKey is set.
  async callGemini(settings, { system, history, prompt, temperature, maxTokens, timeoutMs }) {
    const body = {
      model: this.model(settings),
      system, history, prompt, temperature, maxTokens,
    };
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // 1) preferred: same-origin proxy (no key in browser)
      try {
        const r = await fetch("/api/gemini", {
          method: "POST", headers: { "Content-Type": "application/json" },
          signal: ctl.signal, body: JSON.stringify(body),
        });
        if (r.ok) {
          const j = await r.json();
          if (j.text) return j.text;
          throw new Error(j.error || "empty proxy reply");
        }
        // proxy missing (e.g. file:// or foreign static host) -> try direct
        if (!settings.apiKey) throw new Error("/api/gemini -> " + r.status);
      } catch (e) {
        if (!settings.apiKey) throw e;
        // 2) direct browser call with explicit key
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model(settings))}:generateContent`;
        const contents = [
          ...(history || []).map((m) => ({
            role: m.role === "model" ? "model" : "user",
            parts: [{ text: m.text }],
          })),
          { role: "user", parts: [{ text: prompt }] },
        ];
        const r2 = await fetch(url, {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": settings.apiKey },
          body: JSON.stringify({
            system_instruction: system ? { parts: [{ text: system }] } : undefined,
            contents,
            generationConfig: { temperature, maxOutputTokens: maxTokens },
          }),
        });
        if (!r2.ok) throw new Error("gemini -> " + r2.status);
        const j2 = await r2.json();
        const t = (j2.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
        if (!t) throw new Error("gemini empty reply");
        return t;
      }
    } finally {
      clearTimeout(to);
    }
  }

  geminiHistory(id) {
    // Convert Ollama-style {role,user|assistant} to Gemini {role:user|model,text}
    return (this.histories[id] || []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      text: String(m.content || "").slice(0, 2000),
    })).slice(-24);
  }

  async postJson(url, body, settings, timeoutMs) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST", headers: this.headers(settings),
        signal: ctl.signal, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(url + " -> " + r.status);
      return r.json();
    } finally {
      clearTimeout(to);
    }
  }

  start(npc, game) {
    this.stop(npc.id);
    const loop = async () => {
      // Poll strategy only during the open talk window; ACTION is one-shot.
      if (npc.alive && game.phase === "talk" && !game.chatLocked) {
        await this.think(npc, game);
      }
      if (game.phase === "over") return;
      const s = this.getSettings();
      const jitter = (s.pollIntervalSec || 8) * 1000 * (0.8 + Math.random() * 0.5);
      this.timers[npc.id] = setTimeout(loop, jitter);
    };
    this.timers[npc.id] = setTimeout(loop, 2000 + Math.random() * 4000);
  }

  stop(id) {
    if (this.timers[id]) clearTimeout(this.timers[id]);
    delete this.timers[id];
  }
  stopAll() { Object.keys(this.timers).forEach((k) => this.stop(k)); }

  pushHistory(id, role, content) {
    const h = this.histories[id];
    if (!h) return;
    h.push({ role, content });
    if (h.length > 24) h.splice(0, h.length - 24); // bound memory
  }

  // Cross-agent gossip: NPC hears the player is dealing with someone else.
  addIntel(id, text) {
    this.pushHistory(id, "user", `[INTEL REPORT]: ${text}`);
  }

  buildTalkContent(npc, game, playerMsg) {
    const label = game.agents[npc.id]?.label || npc.id;
    const state = JSON.stringify(mapState(game));
    const say = playerMsg || "No new message. Give a brief status line.";
    return (
      `[PHASE: TALK] [Agent: ${label} | Persona: ${PERSONAS[npc.id] || "Cunning arena commander."}]\n` +
      `[3D Map State: ${state}]\n` +
      `Player says: ${say}\n` +
      `Reply with exactly two lines:\n` +
      `LINE1: <your spoken reply, max 2 sentences, in character>\n` +
      `LINE2: DIRECTIVE: {"type":"goto|hold|follow|ally","target":"player|nova|rex|vera|none","location":"Fountain|Ruins|Tower|Grove|Docks|none"}`
    );
  }

  parseTalkReply(content) {
    const lines = String(content || "").split("\n");
    let directive = null, spoken = [];
    for (const ln of lines) {
      const m = ln.match(/DIRECTIVE:\s*(\{.*\})/);
      if (m) {
        try { directive = JSON.parse(extractJson(m[1])); } catch { /* keep null */ }
      } else if (ln.trim()) {
        spoken.push(ln.replace(/^LINE1:\s*/, "").trim());
      }
    }
    return { dialogue: spoken.join(" ").slice(0, 180) || "...", directive };
  }

  // Phase 1: fast talk poll (or answer to a player message). Never stacks.
  async think(npc, game, playerMsg = "") {
    if (this.inflight[npc.id]) return;
    if (game.phase !== "talk" || game.chatLocked) return;
    const settings = this.getSettings();
    npc.thinking = true;
    this.inflight[npc.id] = true;
    try {
      // --- primary: Google Gemini ---
      if (this.useGemini(settings)) {
        const content = this.buildTalkContent(npc, game, playerMsg);
        this.pushHistory(npc.id, "user", content);
        const system = GEMINI_SYSTEMS[npc.id] || GEMINI_COMMON;
        const reply = await this.callGemini(settings, {
          system,
          history: this.geminiHistory(npc.id).slice(0, -1),
          prompt: content + "\n" + TALK_FORMAT,
          temperature: 0.7, maxTokens: 200, timeoutMs: 25000,
        });
        this.pushHistory(npc.id, "assistant", reply);
        const { dialogue, directive } = this.parseTalkReply(reply);
        if (directive) {
          npc.setDirective(directive);
          if (directive.type === "ally" && directive.target && directive.target !== "none") {
            const foe = fuzzyTarget(directive.target, npc.id, game.agents);
            if (foe) game.proposeAlliance(npc.id, foe);
          }
        }
        npc.lastDialogue = dialogue;
        this.onDialogue?.(npc.id, dialogue);
        return;
      }
      const base = this.base(settings);
      const content = this.buildTalkContent(npc, game, playerMsg);
      this.pushHistory(npc.id, "user", content);
      let reply = null;
      try {
        const j = await this.postJson(`${base}/api/chat`, {
          model: this.model(settings),
          messages: this.histories[npc.id],
          think: false, stream: false, keep_alive: -1,
          options: { num_ctx: 8192, temperature: 0.7, num_predict: 200 },
        }, settings, 25000);
        reply = j.message?.content || "";
      } catch (e) {
        reply = await this.legacyTalk(base, settings, npc, game); // /v1 or /decide tunnel
      }
      this.pushHistory(npc.id, "assistant", reply);
      const { dialogue, directive } = this.parseTalkReply(reply);
      if (directive) npc.setDirective(directive);
      npc.lastDialogue = dialogue;
      this.onDialogue?.(npc.id, dialogue);
    } catch (err) {
      this.applyDecision(npc, game, fallbackBrain(npc, game)); // never freeze
    } finally {
      npc.thinking = false;
      this.inflight[npc.id] = false;
    }
  }

  // Legacy tunnels (/v1/chat/completions, /decide) that return the directive schema.
  async legacyTalk(base, settings, npc, game) {
    const snap = this.buildSnapshot(npc, game);
    try {
      const root = base.includes("/v1") ? base : `${base}/v1`;
      const j = await this.postJson(`${root}/chat/completions`, {
        model: this.model(settings), temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: DIRECTIVE_HELP },
          { role: "user", content: JSON.stringify(snap) },
        ],
      }, settings, 20000);
      const d = normalize(JSON.parse(extractJson(j.choices?.[0]?.message?.content || "{}")));
      npc.setDirective(d.directive);
      if (d.ally && d.ally !== "none") game.proposeAlliance(npc.id, d.ally);
      return d.dialogue;
    } catch {
      const j = await this.postJson(`${base}/decide`, {
        snapshot: snap, instruction: DIRECTIVE_HELP, model: this.model(settings),
      }, settings, 20000);
      const d = typeof j === "string" ? normalize(JSON.parse(extractJson(j)))
        : normalize(j.directive ? j : { directive: j, dialogue: j.dialogue, ally: j.ally });
      npc.setDirective(d.directive);
      if (d.ally && d.ally !== "none") game.proposeAlliance(npc.id, d.ally);
      return d.dialogue;
    }
  }

  buildSnapshot(npc, game, extraChat = "") {
    const nearby = [];
    for (const [id, a] of Object.entries(game.agents)) {
      if (id === npc.id || !a.alive) continue;
      nearby.push({ id, dist: +npc.pos.distanceTo(a.pos).toFixed(1), hp: Math.round(a.hp) });
    }
    return {
      npc_id: npc.id, npc_label: game.agents[npc.id]?.label || npc.id,
      position: { x: +npc.pos.x.toFixed(1), z: +npc.pos.z.toFixed(1) },
      hp: Math.round(npc.hp), phase: game.phase,
      time_left_sec: Math.max(0, Math.ceil(game.phaseEndsAt - performance.now() / 1000)),
      landmarks: ZONES, current_directive: npc.directive, nearby,
      alliances: game.alliances, recent_chat: game.recentChat(6), player_message: extraChat,
    };
  }

  buildActionContent(npc, game) {
    const label = game.agents[npc.id]?.label || npc.id;
    const positions = {};
    for (const [id, a] of Object.entries(game.agents)) {
      positions[id] = [+a.pos.x.toFixed(1), 0, +a.pos.z.toFixed(1)];
    }
    return (
      `[PHASE: ACTION] The diplomacy timer has expired!\n` +
      `You are ${label} (Persona: ${PERSONAS[npc.id] || "Cunning arena commander."}).\n` +
      `Valid characters & their 3D coordinates: ${JSON.stringify(positions)}\n` +
      `Valid action_type values: ["ATTACK", "ALLY", "BETRAY", "DEFEND", "MOVE_TO"]\n` +
      `Think carefully about whether the Player is trustworthy, who is strongest/weakest, and choose your move.\n` +
      `Return ONLY a valid JSON object with keys: agent, action_type, target, target_coordinates, reasoning, battle_cry.`
    );
  }

  // Phase 2: one decisive parallel call per living NPC. Failures -> DEFEND.
  async resolveActions(game) {
    const settings = this.getSettings();
    // --- primary: Google Gemini (parallel, one JSON call per NPC) ---
    if (this.useGemini(settings)) {
      const jobs = Object.values(game.npcs || {}).filter((n) => n.alive).map(async (npc) => {
        try {
          const actionPrompt = this.buildActionContent(npc, game);
          const system = GEMINI_SYSTEMS[npc.id] || GEMINI_COMMON;
          const text = await this.callGemini(settings, {
            system,
            history: this.geminiHistory(npc.id),
            prompt: actionPrompt + "\n" + ACTION_FORMAT,
            temperature: 0.2, maxTokens: 1024, timeoutMs: 120000,
          });
          return [npc.id, this.sanitizeAction(npc, game, JSON.parse(extractJson(text)))];
        } catch (e) {
          return [npc.id, { agent: npc.id, action_type: "DEFEND", target: npc.id, reasoning: "Orders unclear — holding position.", battle_cry: "Hold the line!" }];
        }
      });
      return Object.fromEntries(await Promise.all(jobs));
    }
    let base = "";
    try { base = this.base(settings); } catch { return {}; }
    const jobs = Object.values(game.npcs || {}).filter((n) => n.alive).map(async (npc) => {
      const actionPrompt = this.buildActionContent(npc, game);
      const messages = [...this.histories[npc.id], { role: "user", content: actionPrompt }];
      const attempt = async (think) => {
        const j = await this.postJson(`${base}/api/chat`, {
          model: this.model(settings), messages,
          think, format: "json", stream: false, keep_alive: -1,
          options: { num_ctx: 8192, temperature: 0.2, num_predict: 1024 },
        }, settings, 120000);
        if (j.message?.thinking) game.pushChat(npc.id, `(thinking) ${String(j.message.thinking).slice(0, 200)}`);
        return JSON.parse(extractJson(j.message?.content || "{}")); // 2nd parse
      };
      try {
        try {
          return [npc.id, this.sanitizeAction(npc, game, await attempt(true))];
        } catch {
          return [npc.id, this.sanitizeAction(npc, game, await attempt(false))];
        }
      } catch (e) {
        return [npc.id, { agent: npc.id, action_type: "DEFEND", target: npc.id, reasoning: "Orders unclear — holding position.", battle_cry: "Hold the line!" }];
      }
    });
    return Object.fromEntries(await Promise.all(jobs));
  }

  sanitizeAction(npc, game, a) {
    const types = ["ATTACK", "ALLY", "BETRAY", "DEFEND", "MOVE_TO"];
    const t = String(a.action_type || "DEFEND").toUpperCase();
    const m = String(a.attack_mode || "melee").toLowerCase();
    return {
      agent: npc.id,
      action_type: types.includes(t) ? t : "DEFEND",
      target: a.target || "none",
      target_coordinates: Array.isArray(a.target_coordinates) ? a.target_coordinates : null,
      reasoning: String(a.reasoning || "").slice(0, 300),
      battle_cry: String(a.battle_cry || "For the arena!").slice(0, 180),
      attack_mode: ["melee", "ranged", "brute"].includes(m) ? m : "melee",
    };
  }

  // Execute one resolved ACTION via local directives (authoritative positions).
  applyAction(npc, game, action) {
    const cry = action.battle_cry || "...";
    npc.lastDialogue = cry;
    const foe = fuzzyTarget(action.target, npc.id, game.agents);
    switch (action.action_type) {
      case "ATTACK":
        if (foe) {
          npc.setDirective({ type: "attack", target: foe, mode: action.attack_mode || "melee" });
          game.addFeed?.(`⚔️ ${npc.label} attacks ${game.agents[foe].label} (${action.attack_mode || "melee"})!`);
        } else npc.setDirective({ type: "hold" });
        break;
      case "BETRAY": {
        const victim = foe || game.alliances[npc.id];
        if (victim && game.agents[victim]) {
          npc.setDirective({ type: "attack", target: victim, mode: action.attack_mode || "melee" });
          game.addFeed?.(`💔 ${npc.label} BETRAYS ${game.agents[victim].label}!`);
        } else npc.setDirective({ type: "hold" });
        break;
      }
      case "ALLY":
        if (foe) {
          npc.setDirective({ type: "ally", target: foe });
          game.proposeAlliance(npc.id, foe);
        } else npc.setDirective({ type: "hold" });
        break;
      case "MOVE_TO": {
        const c = action.target_coordinates;
        if (c && isFinite(+c[0]) && isFinite(+c[2])) {
          const x = Math.max(-ARENA_HALF + 1, Math.min(ARENA_HALF - 1, +c[0]));
          const z = Math.max(-ARENA_HALF + 1, Math.min(ARENA_HALF - 1, +c[2]));
          npc.setDirective({ type: "moveto", x, z });
        } else npc.setDirective({ type: "hold" });
        break;
      }
      default:
        npc.setDirective({ type: "hold" });
    }
    this.onDialogue?.(npc.id, `⚔️ ${cry}`);
    if (action.reasoning) game.addFeed?.(`🧠 ${npc.label}: ${action.reasoning}`);
  }

  applyDecision(npc, game, decision) {
    npc.setDirective(decision.directive);
    const line = String(decision.dialogue || "").slice(0, 180) || "...";
    npc.lastDialogue = line;
    if (decision.ally && decision.ally !== "none") game.proposeAlliance(npc.id, decision.ally);
    this.onDialogue?.(npc.id, line);
  }
}

function extractJson(text) {
  const t = String(text || "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : "{}";
}

function normalize(j) {
  const d = j.directive || {};
  return {
    directive: { type: d.type || "hold", target: d.target || "none", location: d.location || "none" },
    dialogue: j.dialogue || j.line || "...",
    ally: j.ally || j.alliance_offer || "none",
  };
}

// Local fallback: locomotion-level wandering + canned lines only.
function fallbackBrain(npc, game) {
  const spots = ["Fountain", "Ruins", "Tower", "Grove", "Docks"];
  const lines = {
    talk: ["Let's talk truce?", "Meet me at the Fountain.", "I could ally with you.", "Watch your back out there."],
    battle: ["Sorry — orders are orders!", "Nothing personal!", "For the arena!"],
  };
  if (game.phase === "battle" && game.enemiesOf(npc.id).length) {
    const e = game.enemiesOf(npc.id)[0];
    const modes = ["melee", "melee", "ranged", "brute"];
    return { directive: { type: "attack", target: e, mode: pick(modes) }, dialogue: pick(lines.battle), ally: "none" };
  }
  return {
    directive: Math.random() < 0.4 ? { type: "hold" } : { type: "goto", location: pick(spots) },
    dialogue: pick(lines[game.phase] || lines.talk),
    ally: "none",
  };
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

// "Test API key" button: Gemini proxy health + model list +
// one fast Phase-1 style probe proving dialogue works. No inputs —
// model + key are built into the server proxy.
export async function testConnection() {
  const useModel = "gemini-3.5-flash-lite";
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 45000);
  try {
    const health = await fetch("/api/health", { signal: ctl.signal });
    if (!health.ok) throw new Error("Game server proxy not running (restart server.py on :8000).");
    let models = [useModel];
    try {
      const m = await fetch("/api/models", { signal: ctl.signal });
      if (m.ok) models = (await m.json()).models || models;
    } catch { /* health already proved online */ }
    const c = await fetch("/api/gemini", {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: useModel,
        system: GEMINI_SYSTEMS.nova,
        history: [],
        prompt: `[PHASE: TALK] [Agent: Nova | Persona: Bold shock commander.]\n[3D Map State: {}]\nPlayer says: Connection test — reply with your two lines.\n${TALK_FORMAT}`,
        temperature: 0.7, maxTokens: 200,
      }),
    });
    if (!c.ok) {
      const err = await c.json().catch(() => ({}));
      throw new Error("/api/gemini -> " + (err.error || c.status));
    }
    const text = (await c.json()).text || "";
    const lines = String(text).split("\n");
    let directive = { type: "hold" };
    const spoken = [];
    for (const ln of lines) {
      const m2 = ln.match(/DIRECTIVE:\s*(\{.*\})/);
      if (m2) { try { directive = JSON.parse(m2[1]); } catch { /* keep hold */ } }
      else if (ln.trim()) spoken.push(ln.replace(/^LINE1:\s*/, "").trim());
    }
    return { models, useModel, decision: { directive, dialogue: spoken.join(" ").slice(0, 180) || text.slice(0, 180) } };
  } finally {
    clearTimeout(timeout);
  }
}
