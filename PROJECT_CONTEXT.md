# PROJECT CONTEXT — Alliance Arena

> Onboarding doc for any model (or human) picking up this project.
> The **model output contract** lives separately in `GEMMA_AGENT_INSTRUCTIONS.md`.
> This file is everything else: architecture, history, decisions, gotchas, roadmap.
> NOTE: tunnel URLs are temporary by design — this doc refers to the tunnel only
> generically as "a `cloudflared` tunnel". Never paste a live URL here.

---

## 1. What this is

A browser-based **3D first-person arena game**: 1 human player + 3 autonomous
NPCs (Nova, Rex, Vera). A match has two phases:

1. **TALK** (default 30 s, changeable 10–600 s in Settings) — the player walks
   around (WASD) and chats with the NPCs to strategize and forge alliances.
2. **BATTLE** (fixed 180 s) — the NPCs execute the actions their LLM brains
   resolved from the conversation (attack / ally / betray / defend / move),
   with all combat resolved locally. Last one alive wins (else draw).

Core architectural rule: **the game is the orchestrator, the LLM is a pure
strategist.** Each NPC periodically sends a snapshot of its surroundings to a
cloud-hosted Gemma model; the model returns high-level directives + dialogue;
the game translates those into pathfinding, movement, animation, and combat
locally. NPCs run natural idle routines while awaiting cloud responses, so
network lag never freezes the game.

## 2. Environment & hosting

- **Stack:** pure vanilla JS (ES modules), Three.js r160 loaded from the
  `unpkg.com` CDN via import map. No build step, no npm, no framework.
- **Server:** `server.py` — a thin static file server (`http.server`,
  `Cache-Control: no-store`). Run `python3 server.py` (or
  `python3 -m http.server <port>`) from the project folder.
- **URL is `http://localhost:9000`, NOT 8000.** Windows (Hyper-V) reserves
  ports 7980–8079, which includes 8000 and 8080 — binding them on Windows
  fails with `PermissionError 10013`, and browsers report "refused to
  connect". Verified via `netsh interface ipv4 show excludedportrange`.
  Port 9000 is outside all excluded ranges and works.
- **WSL quirk (historical):** the project was first served from inside WSL,
  where `127.0.0.1:8000` worked in Linux but was unreachable from the Windows
  browser. Fix was to serve from Windows-side Python. If this ever recurs,
  check with a `GET http://<wsl-ip>:8000/` from PowerShell.
- **Single copy lives at `Desktop/alliance-arena/`.** An older duplicate at
  `C:\Users\Acer\alliance-arena\` was deleted to avoid drift.

## 3. File map (load order matters)

| File | Role |
|---|---|
| `index.html` | Canvas, HUD (timer, HP, phase pill, NPC plates, feed, chat, alliance buttons), entry/Settings card, script tags |
| `css/style.css` | All styling incl. entry card, plates, `#errbox` |
| `js/entry.js` | **Classic script, zero deps, runs first.** Failsafe wiring for Enter/Settings/Test so the buttons work even if the 3D module dies (e.g. CDN blocked). `main.js` overwrites its handlers on successful boot |
| inline `<script>` in `index.html` | `#errbox` watcher: shows startup errors on-screen; after 9 s without `__arenaBooted`, blames the unpkg CDN |
| `js/main.js` | ES module: builds scene, entities, game loop (60 fps), chat/gossip/lock wiring; sets `window.__arenaBooted = true` on boot |
| `js/config.js` | Settings defaults + `localStorage` (`alliance_arena_settings_v2`): `tunnelUrl`, `model`, `pollIntervalSec: 8`, `talkDurationSec: 30`. (`apiKey` field is an unused remnant — UI no longer asks for one) |
| `js/world.js` | Arena build: 52×52 m walls, fountain plaza + lamps, paths, team pads, tower (battlements/window/flag), ruins + fallen column, grove + fireflies, docks + barrels, wall banners, south gate arch, rocks (colliders), grass; exports `tickWorld(t, dt)` for decorative animation |
| `js/pathfinding.js` | Grid A* (`CELL 1.5`, inflated obstacles), `findPath()` returns waypoints for any `Vector3` target |
| `js/player.js` | Pointer-lock FPS: WASD + Shift sprint, mouse look, hidden red body mesh |
| `js/npcs.js` | `NPCAgent`: capsule body + visor + name sprite + 💭 "thinking" ring; `setDirective()` (only cloud input); local locomotion for `goto/hold/follow/attack/ally/moveto`; idle wander + bob/sway while waiting |
| `js/llm.js` | `CloudBrain`: the two-phase Ollama protocol (§5); per-NPC `messages` histories; `resolveActions()`; `applyAction()`; `testConnection()` health probe |
| `js/game.js` | `Game`: phases, alliances, HP/combat (`resolveCombat`, `playerAttack`), 0:03 lock (`tick()` returns `"lock"`), `pendingActions`, win/draw |
| `GEMMA_AGENT_INSTRUCTIONS.md` | Output contract for whoever hosts the model |
| `PROJECT_CONTEXT.md` | This file |
| `server.py` | Static host |

## 4. Runtime architecture

- The rAF loop always runs locally at full fps: `tickWorld` (decor) →
  `player.update` → `npc.update` (local path following) →
  `game.resolveCombat` → `game.tick` (phase machine) → HUD → render.
- Cloud contact is **fire-and-forget, never stacked** (`inflight` guard per
  NPC), with timeouts (talk 25 s, ACTION 120 s). A 💭 ring shows above an NPC
  while its request is in flight (visual only).
- Every request carries `keep_alive: -1` (pins model weights in GPU VRAM),
  `stream: false`, `num_ctx: 8192`. No auth headers (tunnel has none; a
  `Bearer` header is only sent if a key were ever stored — none is).
- Failure ladder per NPC: retry once with simpler params → local fallback
  brain (wander + canned lines in TALK; `DEFEND`/hold in ACTION). The game
  can therefore never crash or freeze on network failure.

## 5. The two-phase LLM protocol (`POST {tunnel}/api/chat`)

Per-NPC `messages` histories are kept client-side (capped at 24 turns); the
Ollama server is stateless. Map state sent every turn is authoritative:
`{hp, pos:[x,0,z], zone (= nearest landmark), alive}` per character plus the
`alliances` map.

- **Phase 1 — TALK** (`think:false`, no `format`, temp 0.7,
  `num_predict:200`, ~1–2 s). User turn =
  `[PHASE: TALK] [Agent: <label> | Persona: <…>]` + `[3D Map State: {...}]` +
  `Player says: …` + a demand for exactly two reply lines:
  `LINE1: <spoken reply, ≤2 sentences>` (shown in chat) and
  `LINE2: DIRECTIVE: {goto|hold|follow|ally}` (executed locally).
  **Never `attack` in TALK.** Missing/unparseable LINE2 → keep previous
  directive. Personas: Nova = bold shock commander; Rex = ruthless tactician;
  Vera = polite but cunning diplomat.
- **Phase 2 — ACTION** (fired **in parallel for all living NPCs at 0:03
  remaining**, while chat locks with an "orders" banner, so results land by
  0:00). Full Phase-1 history + one ACTION prompt (valid characters, live
  coordinates, `ATTACK/ALLY/BETRAY/DEFEND/MOVE_TO`). Spec-first params
  `think:true, format:"json"`, temp 0.2, `num_predict:1024`, with automatic
  retry at `think:false` (verified live to return complete JSON when think
  mode truncates). Reply needs a **double parse**: outer Ollama JSON →
  `message.content` (a JSON *string*) → inner `AgentAction`
  `{agent, action_type, target, target_coordinates, reasoning, battle_cry}`.
- **Execution mapping** (all against authoritative engine positions, fuzzy
  case-insensitive name match; model coordinates trusted ONLY for `MOVE_TO`,
  clamped to the arena): `ATTACK` = chase + melee; `BETRAY` = attack recorded
  ally, announced with 💔; `ALLY` = approach + alliance record; `DEFEND` =
  hold (also the timeout fallback); `MOVE_TO` = pathfind to coordinates.
  `battle_cry` is shown as the NPC's line; `reasoning` goes to the feed;
  `message.thinking` (when present) is kept for a future post-match inspector.
- **Orchestration extras:** chat locks at 0:03; player messages naming an NPC
  are appended as `[INTEL REPORT]` gossip into the other NPCs' histories;
  alliance proposals via the chat buttons nudge that NPC immediately.
- **Legacy tunnels** still supported as fallback inside `queryCloud`:
  OpenAI-compatible `/v1/chat/completions` (`response_format: json_object`),
  then custom `/decide`.
- **Test button** (`testConnection`): `GET /api/tags` health ping → model
  list (`/v1/models`, else `/api/tags`) → one fast TALK-style `/api/chat`
  probe, and reports models + a sample decision on the card.

## 6. Gameplay rules & numbers

- Cast: `player` (human, **red** — body, spawn pad, gate banner, wall banner)
  + `nova` / `rex` / `vera` (Gemma brains, **neutral gray placeholders** —
  NPC colors TBD later).
- Landmarks (shared model vocabulary): `Fountain` center, `Ruins` NW,
  `Tower` NE, `Grove` SW, `Docks` SE. Player spawns south (0,22); NPCs at
  (-20,-20), (20,-20), (0,-8).
- Talk 30 s (Settings: 10–600, applies live if still in talk).
  Battle 180 s. `tick()` emits `"lock"` at ≤3 s, `"battle"` at 0:00.
- Combat (battle only): NPC `attack` directive deals **12 hp per ~0.9 s**
  within 2.0 m; player click deals **18 hp** within 3.2 m. All start at
  100 HP. Death → elimination feed; ≤1 alive → game over (1 = winner,
  0 = draw). Alliances: mutual `X→Y, Y→X` pairs are excluded from
  `enemiesOf()` targeting.
- Entry flow is deliberately minimal: paste tunnel URL → (optional Test) →
  Enter Arena. No API key is ever asked for. Model + talk time live under
  an "Advanced" collapsible.

## 7. Known discrepancies / tech debt (do not "fix" blindly)

1. **`js/entry.js` Test button is legacy.** Its standalone probe still uses
   `/v1/models` + `/v1/chat/completions` (old directive schema), while
   `main.js` → `testConnection()` uses `/api/tags` + `/api/chat`. Harmless
   today because `main.js` overwrites the handler on boot — but if the module
   ever fails, the failsafe Test speaks the old protocol. Unify when touched.
2. **Unused `apiKey` remnants** in `config.js` defaults and `llm.js` header
   builder. UI never sets it. Leave (tolerates future auth) or remove.
3. **`game.js` constructor still says `talkDuration = 120`**; `main.js`
   immediately overrides to the Settings value (30). Update the default if
   it confuses.
4. **CDN dependency:** black canvas + `#errbox` message if `unpkg.com`
   (three.js r160) is unreachable. No vendored fallback exists.
5. **Twin-folder hazard (resolved):** home copy deleted; Desktop copy is the
   single source of truth. Do not re-create a second copy.
6. **Tunnel volatility:** the `cloudflared` URL is temporary by nature; when
   it dies, paste the fresh URL into Settings → Test → save. No restart.

## 8. Interaction log (condensed, chronological)

1. **Initial build** — user asked for a 3D FPS (WASD) + 3 cloud-brained NPCs:
   LLM as strategist returning JSON directives (`goto/hold/follow`),
   local pathfinding/movement/animation, 2-min talk → battle with
   attack/ally actions, hosted on localhost:8000 with an API-code option.
   Built modular vanilla-JS + Three.js app (`world/player/npcs/
   pathfinding/llm/chat/game/main`), starting with the 3D architecture.
2. **"Not live"** — server bound to WSL `127.0.0.1` was invisible to the
   Windows browser. Rebound to `0.0.0.0`, then discovered Windows itself
   forbids ports 8000/8080 (Hyper-V exclusions 7980–8079/8080–8179,
   `PermissionError 10013`). Moved to **port 9000** on Windows Python +
   a Desktop `Start-Alliance-Arena.bat`.
3. **Talk time 30 s + Settings control** — default `talkDurationSec` 120→30,
   new Settings field (clamped 10–600, applies live mid-talk).
4. **Cast colors + 3D detail + model doc** — NPCs red/black/white, player
   blue (later reversed, §5); added sky/clouds, fountain plaza + lamps,
   tower battlements/flag, fallen column, fireflies, barrels, banners, gate
   arch, rocks, grass, `tickWorld()` animation loop; wrote
   `GEMMA_AGENT_INSTRUCTIONS.md` (directive/dialogue JSON contract + sample
   Flask+Ollama tunnel server).
5. **Live tunnel provided** — probed it: Ollama behind a `cloudflared`
   tunnel with `diplomacy-agent:latest` (Gemma-12B, TALK/ACTION prompt baked
   in) + `gemma4:12b-it-qat` base. Verified `/v1/chat/completions` +
   `json_object` end-to-end (returned a valid `ally` directive). Prefilled
   URL + model in defaults (settings key bumped v1→v2), added endpoint
   fallbacks (`/v1` → `/decide` → `/api/chat`) and a **Test connection**
   button proving models + a live decision.
6. **Simplified entry + player-red** — removed the API-key field (tunnel has
   no auth; "just enter and play"); model/talk-time collapsed under
   Advanced. Player became the only red character; NPCs reverted to neutral
   gray placeholders (labels, pads, buttons, banners, docs updated).
7. **Dead buttons** — Enter + Test did nothing: the module was dying before
   wiring handlers (CDN import). Added `js/entry.js` zero-dependency
   failsafe wiring + on-screen `#errbox` reporting the real error; `main.js`
   sets `__arenaBooted` and overwrites handlers on success.
8. **Kaggle contact spec adopted** — user supplied the orchestrator contract
   (per-agent histories, `keep_alive:-1`, health ping, TALK vs ACTION
   payloads, double-parse, 0:03 parallel fire, gossip, memory reset,
   DEFEND fallback). Rebuilt `llm.js` around it; added `moveto` directive +
   authoritative targeting; `game.js`/`main.js` got the 0:03 lock and ACTION
   application. Live probes: TALK two-line format perfect; `think:true`
   truncated twice → implemented think→no-think retry ladder, then DEFEND.
   Rewrote the instructions doc to the two-phase protocol.
9. **Codespaces handoff** — zipped the folder (Desktop) with run/port-forward
   instructions.
10. **This doc** — requested as full-context onboarding "with our
    interactions", written to the Desktop folder only; home duplicate
    deleted afterward.

## 9. How to run / continue

- `cd Desktop/alliance-arena && python3 server.py` (or any static server),
  open the printed localhost URL. In Codespaces: forward the port (Public
  if the tunnel/model must reach it, else Private).
- First load needs internet (unpkg CDN for three.js).
- Paste the current `cloudflared` tunnel URL into the entry card →
  **Test connection** (expect model list + sample decision) → **Enter Arena**.
- Talk (chat box + alliance buttons; naming NPCs creates cross-gossip) →
  at 0:03 chat locks and ACTIONs resolve → battle executes them → winner.

## 10. Roadmap / open items

- NPC colors still gray/TBD (player is red); re-apply a scheme when decided.
- Unify `entry.js` legacy Test probe with `testConnection()` (§7.1).
- Post-match "thinking" inspector screen (traces are already captured).
- Multi-round support: strip ACTION turns + append round-outcome summary
  (spec §4.3 pattern) instead of single-match game-over.
- Optional: player HP regen / pickups; battle-duration setting; vendored
  three.js fallback for offline play.
