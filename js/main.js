import * as THREE from "three";
import { buildWorld, LANDMARKS, tickWorld } from "./world.js";
import { buildNavGrid } from "./pathfinding.js";
import { Player } from "./player.js";
import { NPCAgent } from "./npcs.js";
import { CloudBrain, testConnection } from "./llm.js";
import { Game } from "./game.js";
import { loadSettings, saveSettings } from "./config.js";

const settings = loadSettings();

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

// --- settings / entry overlay ---
const overlay = $("entry"), tUrl = $("tunnelUrl"), model = $("modelName"), talkSecs = $("talkSecs");
tUrl.value = settings.tunnelUrl || "";
model.value = settings.model || "diplomacy-agent:latest";
talkSecs.value = settings.talkDurationSec ?? 30;
$("saveEntry").onclick = () => {
  settings.tunnelUrl = tUrl.value.trim();
  settings.model = model.value.trim() || "diplomacy-agent:latest";
  settings.talkDurationSec = Math.max(10, Math.min(600, +talkSecs.value || 30));
  talkSecs.value = settings.talkDurationSec;
  saveSettings(settings);
  game.setTalkDuration(settings.talkDurationSec); // applies immediately if still in talk phase
  overlay.style.display = "none";
  addFeed(settings.tunnelUrl
    ? `🌐 Cloud Gemma linked: ${settings.tunnelUrl} (model ${settings.model})`
    : "⚠️ No tunnel URL — NPCs run on local fallback brains until you add one in Settings.");
  canvas.requestPointerLock?.();
};
$("skipEntry").onclick = () => { $("saveEntry").onclick(); };
$("settingsBtn").onclick = () => {
  // refresh fields (link is temporary — always show what's currently stored)
  tUrl.value = settings.tunnelUrl || "";
  model.value = settings.model || "";
  talkSecs.value = settings.talkDurationSec ?? 30;
  $("connStatus").textContent = "";
  $("connStatus").className = "conn";
  overlay.style.display = "flex";
};
$("testConn").onclick = async () => {
  const st = $("connStatus");
  st.className = "conn";
  st.textContent = "⏳ Contacting tunnel…";
  try {
    const r = await testConnection(tUrl.value.trim(), model.value.trim());
    st.className = "conn ok";
    st.textContent = `✅ Models: ${r.models.join(", ")}\n✅ Test decision (${r.useModel}): ${r.decision.directive.type}` +
      (r.decision.directive.target !== "none" ? ` ${r.decision.directive.target}` : "") +
      (r.decision.directive.location !== "none" ? ` → ${r.decision.directive.location}` : "") +
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

// click = attack in battle
addEventListener("mousedown", () => {
  if (document.pointerLockElement !== canvas) return;
  const msg = game.playerAttack();
  if (msg) addFeed("🗡️ " + msg);
});

// --- HUD loop ---
function fmt(s) {
  s = Math.ceil(s);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function hud() {
  timerEl.textContent = fmt(game.timeLeft());
  phaseEl.textContent = game.phase.toUpperCase();
  phaseEl.className = "pill " + game.phase;
  hpEl.textContent = `HP ${Math.max(0, Math.round(player.hp))}`;
  const alive = Object.values(agents).filter((a) => a.alive).length;
  statusEl.textContent = game.phase === "over"
    ? `Game over — winner: ${game.winner}`
    : `${alive}/4 alive · Alliances: ${Object.entries(game.alliances).map(([k, v]) => `${k}→${v}`).join(", ") || "none"}`;
  // npc plates
  $("npcPlates").innerHTML = Object.values(npcs).map((n) =>
    `<div class="plate" style="border-color:#${n.color.toString(16).padStart(6, "0")}">
      <b>${n.label}</b> HP ${Math.round(n.hp)} · <i>${n.directive.type}${n.directive.target && n.directive.target !== "none" ? " " + n.directive.target : ""}${n.directive.location && n.directive.location !== "none" ? " → " + n.directive.location : ""}</i>${n.thinking ? " · 💭" : ""}<br><span>“${n.lastDialogue}”</span>
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
addChat("System", "Talk phase started. NPCs consult cloud Gemma every ~8s; movement stays local.");
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
