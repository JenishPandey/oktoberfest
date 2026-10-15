import * as THREE from "three";
import { buildWorld, LANDMARKS, tickWorld } from "./world.js";
import { buildNavGrid } from "./pathfinding.js";
import { Player } from "./player.js";
import { NPCAgent } from "./npcs.js";
import { CloudBrain, testConnection } from "./llm.js";
import { Game } from "./game.js";
import { loadSettings } from "./config.js";

const settings = loadSettings();
settings.provider = "gemini"; // fixed: built-in Gemini proxy, no user inputs
settings.model = "gemini-3.5-flash-lite";
settings.talkDurationSec = 30;

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const { colliders, spawns } = buildWorld(scene);
buildNavGrid(colliders);

// --- entities ---
const player = new Player(scene, colliders, spawns.player);
player.enableLook(canvas);
player.label = "You";

const npcs = {
  nova: new NPCAgent(scene, colliders, "nova", "Nova", 0x9ca3af, spawns.npc0),
  rex: new NPCAgent(scene, colliders, "rex", "Rex", 0x9ca3af, spawns.npc1),
  vera: new NPCAgent(scene, colliders, "vera", "Vera", 0x9ca3af, spawns.npc2),
};
const agents = { player, ...npcs };

// --- HUD refs ---
const $ = (id) => document.getElementById(id);
const feedEl = $("feed"), chatEl = $("chat"), timerEl = $("timer"),
  phaseEl = $("phase"), hpEl = $("hp"), statusEl = $("status");

function addFeed(msg) {
  const d = document.createElement("div");
  d.textContent = msg;
  feedEl.prepend(d);
  while (feedEl.children.length > 30) feedEl.lastChild.remove();
}
function addChat(from, text) {
  const d = document.createElement("div");
  d.innerHTML = `<b>${from}:</b> ${text}`;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  while (chatEl.children.length > 60) chatEl.firstChild.remove();
}

const game = new Game(agents, addFeed);
game.npcs = npcs; // Phase-2 ACTION resolution iterates living NPCs
game.setTalkDuration(Math.max(10, Math.min(600, +settings.talkDurationSec || 30)));
const brain = new CloudBrain(() => settings, (id, line) => {
  addChat(agents[id].label, line);
  game.pushChat(id, line);
});
Object.values(npcs).forEach((n) => brain.start(n, game));

// --- entry overlay (no inputs) + API status page (⚙️ reopens it) ---
const overlay = $("entry");
$("saveEntry").onclick = () => {
  overlay.style.display = "none";
  addFeed(`🌐 Gemini brains online (model ${settings.model}) — talk to forge alliances!`);
  canvas.requestPointerLock?.();
};
$("settingsBtn").onclick = () => {
  $("connStatus").textContent = "";
  $("connStatus").className = "conn";
  overlay.style.display = "flex";
};
const skipEntryBtn = $("skipTalkEntry");
if (skipEntryBtn) skipEntryBtn.onclick = () => { overlay.style.display = "none"; canvas.requestPointerLock?.(); skipTalk(); };
const skipBtn = $("skipTalk");
if (skipBtn) skipBtn.onclick = () => skipTalk();
$("testConn").onclick = async () => {
  const st = $("connStatus");
  st.className = "conn";
  st.textContent = "⏳ Testing built-in API key…";
  try {
    const r = await testConnection();
    st.className = "conn ok";
    st.textContent = `✅ API key works (model ${r.useModel})\n✅ Test decision: ${r.decision.directive.type}` +
      (r.decision.directive.target && r.decision.directive.target !== "none" ? ` ${r.decision.directive.target}` : "") +
      (r.decision.directive.location && r.decision.directive.location !== "none" ? ` → ${r.decision.directive.location}` : "") +
      `\n“${r.decision.dialogue}”`;
  } catch (e) {
    st.className = "conn err";
    st.textContent = `❌ ${e.message} — NPCs will use fallback brains until this works.`;
  }
};
$("allyBtns").querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    if (game.phase !== "talk" || game.chatLocked) return addFeed("Alliances lock when battle starts.");
    game.playerAlly(b.dataset.npc);
    addChat("You", `Alliance with ${agents[b.dataset.npc].label} proposed.`);
    game.pushChat("player", `I want to ally with ${b.dataset.npc}.`);
    // nudge that NPC to reconsider immediately (async, non-blocking)
    brain.think(npcs[b.dataset.npc], game, `The player just proposed an alliance with you. Respond.`);
  };
});

// --- chat input: talk to NPCs during TALK phase ---
$("chatForm").onsubmit = (e) => {
  e.preventDefault();
  const inp = $("chatInput");
  const text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  addChat("You", text);
  game.pushChat("player", text);
  if (game.phase === "talk" && !game.chatLocked) {
    // broadcast: each NPC hears it (staggered, non-blocking) and keeps it in memory
    Object.values(npcs).forEach((n, i) =>
      setTimeout(() => brain.think(n, game, `Player says: "${text}"`), i * 700));
    // gossip: NPCs named in the message become intel in everyone else's memory
    const low = text.toLowerCase();
    for (const n of Object.values(npcs)) {
      for (const o of Object.values(npcs)) {
        if (o.id !== n.id && (low.includes(o.id) || low.includes(o.label.toLowerCase()))) {
          brain.addIntel(n.id, `scouts observed the Player making plans with ${o.label}.`);
        }
      }
    }
  } else if (game.chatLocked) addFeed("📜 Orders are being issued — chat locked.");
  else addFeed("Battle phase — words are wind. Click to attack!");
};

// attack modes: 1 slash · 2 heavy · 3 bolt | click = attack in battle
const MODE_NAMES = { slash: "Slash", heavy: "Heavy", bolt: "Bolt" };
addEventListener("keydown", (e) => {
  const m = { Digit1: "slash", Digit2: "heavy", Digit3: "bolt" }[e.code];
  if (m && player.mode !== m) {
    player.mode = m;
    addFeed(`🗡️ Attack mode: ${MODE_NAMES[m]}`);
  }
});
addEventListener("mousedown", () => {
  if (document.pointerLockElement !== canvas) return;
  player.swingSword(player.mode);
  const msg = game.playerAttack(player.mode, player.getForward());
  if (msg) addFeed("🗡️ " + msg);
});

// talk skip: lock chat, resolve orders now, jump straight to battle
async function skipTalk() {
  if (game.phase !== "talk" || game.actionsRequested) return;
  game.actionsRequested = true;
  game.chatLocked = true;
  addChat("System", "Talk skipped — commanders are issuing orders…");
  addFeed("⏩ Talk phase skipped.");
  try {
    game.pendingActions = await brain.resolveActions(game);
    addFeed(`📜 Orders received for ${Object.keys(game.pendingActions).length} commanders.`);
  } catch {
    game.pendingActions = {};
  }
  game.phaseEndsAt = performance.now() / 1000; // next tick fires "battle", applying orders
}

// beam flashes for every recorded hit (player + NPC bolts, cleaves, strikes)
const beams = [];
const BEAM_COLORS = { bolt: 0x38bdf8, heavy: 0xfb923c, slash: 0xfef08a, melee: 0xf87171, brute: 0xef4444, ranged: 0x38bdf8 };
function spawnBeams() {
  for (const s of game.shots.splice(0)) {
    const a = game.agents[s.from], b = game.agents[s.to];
    if (!a || !b) continue;
    if (s.from !== "player" && typeof a.swing === "function") a.swing(s.mode); // NPC sword swing on hit
    const from = new THREE.Vector3(a.pos.x, 1.2, a.pos.z);
    const to = new THREE.Vector3(b.pos.x, 1.1, b.pos.z);
    const len = from.distanceTo(to);
    if (len < 0.1) continue;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, len),
      new THREE.MeshBasicMaterial({ color: BEAM_COLORS[s.mode] || 0xffffff, transparent: true, opacity: 0.9 })
    );
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.lookAt(to);
    scene.add(mesh);
    beams.push({ mesh, ttl: 0.14 });
  }
}
function tickBeams(dt) {
  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i];
    b.ttl -= dt;
    b.mesh.material.opacity = Math.max(0, b.ttl / 0.14);
    if (b.ttl <= 0) { scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); beams.splice(i, 1); }
  }
}

// --- HUD loop ---
function fmt(s) {
  s = Math.ceil(s);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function hud() {
  timerEl.textContent = fmt(game.timeLeft());
  phaseEl.textContent = game.phase.toUpperCase();
  phaseEl.className = "pill " + game.phase;
  hpEl.textContent = `HP ${Math.max(0, Math.round(player.hp))} · ${MODE_NAMES[player.mode]} [1/2/3]`;
  const skipBtn = $("skipTalk");
  if (skipBtn) skipBtn.style.display = game.phase === "talk" && !game.chatLocked ? "" : "none";
  const alive = Object.values(agents).filter((a) => a.alive).length;
  statusEl.textContent = game.phase === "over"
    ? `Game over — winner: ${game.winner}`
    : `${alive}/4 alive · Alliances: ${Object.entries(game.alliances).map(([k, v]) => `${k}→${v}`).join(", ") || "none"}`;
  // npc plates
  $("npcPlates").innerHTML = Object.values(npcs).map((n) =>
    `<div class="plate" style="border-color:#${n.color.toString(16).padStart(6, "0")}">
      <b>${n.label}</b> HP ${Math.round(n.hp)} · <i>${n.directive.type}${n.directive.type === "attack" ? ":" + (n.directive.mode || "melee") : ""}${n.directive.target && n.directive.target !== "none" ? " " + n.directive.target : ""}${n.directive.location && n.directive.location !== "none" ? " → " + n.directive.location : ""}</i>${n.thinking ? " · 💭" : ""}<br><span>“${n.lastDialogue}”</span>
    </div>`).join("");
}

// --- landmark labels ---
function labelSprite(text) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(0,0,0,0.5)"; g.fillRect(0, 8, 256, 48);
  g.fillStyle = "#fbbf24"; g.font = "bold 26px sans-serif"; g.textAlign = "center";
  g.fillText(text, 128, 42);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  sp.scale.set(3, 0.75, 1);
  return sp;
}
for (const [name, pos] of Object.entries(LANDMARKS)) {
  const s = labelSprite(name);
  s.position.set(pos.x + 4.5, 5.6, pos.z);
  scene.add(s);
}

// --- main loop: local sim always runs at full fps; cloud only injects directives ---
addFeed(`🎙️ TALK phase: ${settings.talkDurationSec}s to strategize. Walk up (WASD), type below, forge alliances.`);
addChat("System", "Talk phase started. NPCs consult Google Gemini every ~8s; movement stays local.");
let last = performance.now();
let elapsed = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;
  tickWorld(elapsed, dt); // decorative world animation (visual only)
  player.update(dt);
  Object.values(npcs).forEach((n) => n.update(dt, agents));
  game.resolveCombat(dt);
  spawnBeams();
  tickBeams(dt);
  const ev = game.tick();
  if (ev === "lock") {
    // 0:03 remaining: fire all Phase-2 ACTION calls in parallel so orders
    // land before the clock hits zero. Local sim keeps running meanwhile.
    addChat("System", "Commanders are issuing orders… Chat locked.");
    brain.resolveActions(game).then((actions) => {
      game.pendingActions = actions;
      addFeed(`📜 Orders received for ${Object.keys(actions).length} commanders.`);
    });
  }
  if (ev === "battle") {
    // Execute the resolved ACTIONs through local directives (authoritative).
    for (const n of Object.values(npcs)) {
      const a = game.pendingActions[n.id];
      if (a) brain.applyAction(n, game, a);
      else if (n.alive) n.setDirective({ type: "hold" });
    }
    addChat("System", "Battle begins! Commanders execute their resolved actions.");
  }
  if (ev === "over") addChat("System", `Game over. Winner: ${game.winner}`);
  hud();
  renderer.render(scene, player.camera);
}
window.__arenaBooted = true; // entry.js failsafe stands down; error box stays silent
requestAnimationFrame(loop);
