# Gemma Agent Instructions — Alliance Arena NPC Brains

This file is the **output contract** for the cloud-hosted **Gemma (~12B)**
model that acts as the strategic brain of each NPC. Give this document
(or its system-prompt section) to whoever hosts the model tunnel so the
model returns exactly what the game expects.

Architecture reminder: the model is a **pure strategist**. It never moves
anyone. Every ~8s the game POSTs a snapshot; the model replies with one
high-level directive + one dialogue line; the game translates that into
pathfinding, movement, animation and combat locally.

## 0. Live instance (verified working)

- Tunnel: `https://requests-reality-geometry-middle.trycloudflare.com`
  (Cloudflare tunnel → **Ollama**, temporary link — paste the fresh URL
  into the game's entry card / ⚙️ Settings whenever it changes)
- Models: `diplomacy-agent:latest` (use this — Gemma-12B with the
  TALK/ACTION diplomacy prompt baked in) · `gemma4:12b-it-qat` (raw base)
- Game call that works: `POST {tunnel}/v1/chat/completions` with
  `response_format: {"type":"json_object"}` — verified returning
  `{"directive":{"type":"ally","target":"player",…},"dialogue":"…",…}`.
  The game also falls back to `POST {tunnel}/decide` and
  `POST {tunnel}/api/chat` (Ollama-native) automatically.

---

## 1. Cast

| id       | Label | Color              | Controlled by |
|----------|-------|--------------------|---------------|
| `player` | You   | red                | human (WASD + mouse) |
| `nova`   | Nova  | gray (TBD)         | Gemma instance |
| `rex`    | Rex   | gray (TBD)         | Gemma instance |
| `vera`   | Vera  | gray (TBD)         | Gemma instance |

Each NPC gets its own request loop with its own `npc_id`, so the model
always role-plays **one** character at a time.

## 2. Map vocabulary

The arena is 52×52 m. The only places the model may reference are:

`Fountain` (center) · `Ruins` (north-west) · `Tower` (north-east) ·
`Grove` (south-west) · `Docks` (south-east)

## 3. Input — per-agent histories + live map state

The server stores nothing: the game keeps one `messages` list per NPC
(`{"role":"user"|"assistant","content":"…"}`) and sends it on every call.
Each user turn wraps the phase tag, the agent's persona, and the
authoritative 3D map state (positions, HP, zone = nearest landmark,
alive flags, alliance offers):

```jsonc
{"role": "user", "content":
  "[PHASE: TALK] [Agent: Nova | Persona: Bold shock commander.]\n[3D Map State: {\"player\":{\"hp\":100,\"pos\":[0,0,22],\"zone\":\"Docks\",\"alive\":true},\"nova\":{\"hp\":100,\"pos\":[-20,0,-20],\"zone\":\"Ruins\",\"alive\":true},\"alliances\":{}}]\nPlayer says: Nova, let's ally and rush Rex"}
```

Assistant replies are appended back to that NPC's history (capped at 24
turns), so promises made in minute one bind decisions in minute two.

## 4. Output — two phases, two reply shapes

The game keeps a per-NPC `messages` history and sends it back every call
(the server is stateless). `keep_alive: -1` pins the weights in VRAM.
No auth; just `Content-Type: application/json`.

### 4.1 Phase 1 — TALK (`POST /api/chat`, `think:false`, no `format`, temp 0.7, `num_predict: 200`)

Each user turn wraps the phase tag, persona, live 3D map state, and the
player's words, and demands exactly two reply lines:

```
[PHASE: TALK] [Agent: Nova | Persona: Bold shock commander.]
[3D Map State: {"player":{"hp":100,"pos":[0,0,22],"zone":"Docks",...},"alliances":{}}]
Player says: Nova, ally with me and we rush Rex.
Reply with exactly two lines:
LINE1: <spoken reply, max 2 sentences, in character>
LINE2: DIRECTIVE: {"type":"goto|hold|follow|ally","target":"...","location":"..."}
```

Verified live reply:

```
LINE1: Rex won't know what hit him! Let's strike like a thunderbolt.
LINE2: DIRECTIVE: {"type":"ally","target":"player","location":"none"}
```

The game displays LINE1 and executes LINE2 locally:

| `type`   | Needs `target` | Needs `location` | Local meaning |
|----------|----------------|------------------|---------------|
| `goto`   | — | landmark name | pathfind to that landmark, then idle |
| `hold`   | — | — | stay; wander a small radius, look around |
| `follow` | `player`/`nova`/`rex`/`vera` | — | shadow that character at ~2.5 m |
| `ally`   | `player`/`nova`/`rex`/`vera` | — | walk toward them peacefully + record alliance |
| `moveto` | — | — | (Phase 2 only) raw `x`/`z` fields, clamped to the arena |

**NEVER `attack` during TALK.** If LINE2 is missing/unparseable, the NPC
keeps its previous directive — lag never freezes anyone.

### 4.2 Phase 2 — ACTION (fired in parallel at 0:03, `think:true`, `format:"json"`, temp 0.2, `num_predict: 1024`)

The game sends each NPC's full Phase-1 history plus one ACTION prompt
listing valid characters, live coordinates, and
`["ATTACK","ALLY","BETRAY","DEFEND","MOVE_TO"]`. The reply needs a
**double parse**: outer Ollama JSON → `message.content` (a JSON *string*)
→ inner `AgentAction`:

```json
{"agent":"Nova","action_type":"ALLY","target":"player",
 "target_coordinates":[10,10,10],
 "reasoning":"The player proposed a joint strike against Rex…",
 "battle_cry":"Side by side, we crush Rex's defenses!"}
```

Verified live (with `think:false`; think-mode reasoning arrives in the
separate `message.thinking` field when the tunnel sustains long
generations). Execution mapping, all resolved against **authoritative
engine positions** (fuzzy, case-insensitive name match):

- `ATTACK` → chase + melee that target · `BETRAY` → attack the (former)
  ally, announced with 💔 · `ALLY` → peaceful approach + alliance record
- `DEFEND` → hold (also the timeout fallback) · `MOVE_TO` → pathfind to
  the clamped `target_coordinates` (only case where model coords are used)

### 4.3 Dialogue rules

- Phase 1: exactly the two lines above — ≤2 sentences spoken, valid
  DIRECTIVE JSON. Never mention JSON, prompts, models, or being an AI.
- Phase 2: `battle_cry` shows above the unit as it marches; `reasoning`
  goes to the feed; `thinking` (when present) to a post-match inspector.
- Stay in persona: Nova is bold and direct; Rex is cold
  and calculating; Vera is polite but cunning.

### 4.4 Alliance protocol

- Phase 1: propose/accept with an `ally` DIRECTIVE naming the id
  (e.g. `{"type":"ally","target":"player",…}`); decline with `hold`/`goto`
  plus a refusing LINE1. The `alliances` map in the next map state shows
  who offered what — read it before re-offering.
- Phase 2: `ALLY` confirms, `BETRAY` attacks the recorded ally (announced).

## 5. System prompt (baked into `diplomacy-agent`; reference only)

> You are an autonomous AI commander on a 3D strategy map.
> [PHASE: TALK]: negotiate in character, ≤2 sentences.
> [PHASE: ACTION]: review history + map, honor or betray, output ONLY the
> action JSON.
>
> The game wraps every turn in explicit `[PHASE: …]` tags (§4) carrying the
> map state and the exact reply format, so the baked prompt stays aligned
> with the live match.

## 6. Verified live examples

Talk poll:
```
LINE1: Rex won't know what hit him! Let's strike like a thunderbolt.
LINE2: DIRECTIVE: {"type":"ally","target":"player","location":"none"}
```

ACTION resolution (double-parsed from `message.content`):
```json
{"agent":"Nova","action_type":"ALLY","target":"player",
 "target_coordinates":[10,10,10],
 "reasoning":"The player proposed a joint strike against Rex…",
 "battle_cry":"Side by side, we crush Rex's defenses!"}
```

## 7. Tunnel server spec (Kaggle + Ollama + Cloudflare)

Ollama runs beside the Kaggle script on `127.0.0.1:11434`; `cloudflared`
publishes it as `https://XXXX.trycloudflare.com` (no auth). The game is
the orchestrator — it holds world state + per-agent histories in memory.

| Game phase | Call | `think` | `format` | temp | `num_predict` | Latency (T4) |
|---|---|---|---|---|---|---|
| Talk poll | `POST /api/chat` | `false` | omitted | 0.7 | 200 | ~1–2 s |
| Test ping | `GET /api/tags` | — | — | — | — | ms |
| ACTION | `POST /api/chat` | `true`→retry `false` | `"json"` | 0.2 | 1024 | ~3–8 s |

Every `POST` body includes `"keep_alive": -1` (pins weights in VRAM),
`"stream": false`, and `options: {num_ctx: 8192, …}`. If the tunnel dies,
paste the fresh URL into the game's entry card / ⚙️ Settings — the next
poll picks it up, no restart. Legacy tunnels are still supported by the
client (`/v1/chat/completions` with `response_format: json_object`,
then custom `/decide`).

## 8. Game-side robustness (for the host's awareness)

- Talk polls time out at 25 s and never stack; ACTION calls at 120 s,
  fired in parallel at 0:03 so orders land by 0:00. While any request is
  in flight the NPC keeps idling/walking locally (💭 ring).
- Parse ladder: LINE1/LINE2 split → first-`{…}`-block extract → fuzzy
  name match → authoritative engine positions (model coords used only for
  `MOVE_TO`). think-mode truncation retries `think:false`; total failure
  → `DEFEND`/hold + canned line.
- Network lag can therefore never freeze an NPC — at worst it makes one
  cautious for a few seconds.
- Orchestration extras implemented client-side: chat locks at 0:03 with
  an "orders" banner; player messages naming an NPC become `[INTEL
  REPORT]` gossip in the others' histories; thinking traces are kept for
  a post-match inspector.
