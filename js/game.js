// Game orchestration: TALK (strategize + alliances) -> BATTLE (LLM actions) -> OVER.
// LLM output is strategy only; damage/movement/death are all resolved locally here.

export class Game {
  constructor(agents, addFeed) {
    this.agents = agents; // {player, nova, rex, vera} each with .pos/.hp/.alive (+NPC .directive)
    this.addFeed = addFeed;
    this.phase = "talk";
    this.talkDuration = 120;
    this.battleDuration = 180;
    this.phaseEndsAt = performance.now() / 1000 + this.talkDuration;
    this.alliances = {}; // npcId -> allied id ("player" allowed)
    this.chatLog = []; // {from, text, t}
    this.winner = null;
    this.chatLocked = false;      // set at 0:03 — talk UI locks, ACTION fires
    this.actionsRequested = false;
    this.pendingActions = {};     // npcId -> resolved Phase-2 AgentAction
    this.shots = [];              // per-frame hit events {from,to,mode} for beam FX (drained by main.js)
    this._pCd = {};               // player attack cooldowns per mode (timestamps)
  }

  setTalkDuration(s) {
    this.talkDuration = s;
    if (this.phase === "talk") this.phaseEndsAt = performance.now() / 1000 + s;
  }

  proposeAlliance(from, to) {
    if (!this.agents[to] || from === to) return;
    if (this.phase !== "talk") return;
    this.alliances[from] = to;
    this.addFeed?.(`🤝 ${this.agents[from].label} offers alliance to ${this.agents[to].label}`);
    this.pushChat(from, `Alliance offered to ${this.agents[to].label}.`);
  }

  playerAlly(npcId) {
    this.alliances["player"] = npcId;
    this.alliances[npcId] = "player";
    this.addFeed?.(`🤝 You allied with ${this.agents[npcId].label}`);
  }

  enemiesOf(id) {
    const out = [];
    for (const other of Object.keys(this.agents)) {
      if (other === id) continue;
      // allied pairs are not enemies
      if (this.alliances[id] === other && this.alliances[other] === id) continue;
      if (this.alliances[id] === other || this.alliances[other] === id) continue;
      out.push(other);
    }
    return out.filter((o) => this.agents[o]?.alive);
  }

  pushChat(from, text) {
    this.chatLog.push({ from, text, t: Date.now() });
    if (this.chatLog.length > 40) this.chatLog.shift();
  }
  recentChat(n) { return this.chatLog.slice(-n); }

  damage(victimId, amount, attackerId) {
    const v = this.agents[victimId];
    if (!v?.alive || this.phase === "over") return;
    v.hp -= amount;
    if (v.hp <= 0) {
      v.hp = 0; v.alive = false;
      this.addFeed?.(`☠️ ${v.label} eliminated by ${this.agents[attackerId]?.label ?? "?"}`);
      this.checkEnd();
    }
  }

  // Attack-mode stats. Player switches with 1/2/3; NPC mode comes from its
  // attack directive (chosen by the LLM ACTION, default melee).
  static PLAYER_MODES = {
    slash: { dmg: 18, range: 3.2, cd: 0.5, label: "Slash" },
    heavy: { dmg: 30, range: 3.8, cd: 1.6, label: "Heavy" },
    bolt:  { dmg: 12, range: 25, cd: 0.8, label: "Bolt" },
  };
  static NPC_MODES = {
    melee:  { dmg: 12, range: 2.0, cd: 0.9 },
    brute:  { dmg: 20, range: 2.2, cd: 1.6 },
    ranged: { dmg: 8, range: 18, minRange: 8, cd: 2.0 },
  };

  now() { return performance.now() / 1000; }

  // NPC attack directives, resolved per attack mode. Ranged NPCs hold a
  // distance band (locomotion in npcs.js) and fire bolts from afar.
  // Every hit is recorded in this.shots for the renderer (beam flashes).
  resolveCombat() {
    if (this.phase !== "battle") return;
    for (const [id, a] of Object.entries(this.agents)) {
      if (!a.alive || !a.directive) continue; // player has no directive
      if (a.directive.type !== "attack" || !a.directive.target) continue;
      const t = this.agents[a.directive.target];
      if (!t?.alive) continue;
      const st = Game.NPC_MODES[a.directive.mode] || Game.NPC_MODES.melee;
      const dist = a.pos.distanceTo(t.pos);
      if (dist > st.range) continue;
      if (st.minRange && dist < st.minRange * 0.5) continue; // too close to shoot
      if ((a._atkCd || 0) > this.now()) continue;
      a._atkCd = this.now() + st.cd;
      this.damage(a.directive.target, st.dmg, id);
      this.shots.push({ from: id, to: a.directive.target, mode: a.directive.mode || "melee" });
    }
  }

  playerAttack(mode = "slash", dir = null) {
    if (this.phase !== "battle") return "Talk phase — no combat yet.";
    const st = Game.PLAYER_MODES[mode] || Game.PLAYER_MODES.slash;
    const me = this.agents.player;
    if ((this._pCd?.[mode] || 0) > this.now()) return `${st.label} recharging…`;
    const aliveNpcs = Object.entries(this.agents).filter(([id, a]) => id !== "player" && a.alive);
    if (mode === "bolt") {
      // hitscan: nearest NPC roughly in the crosshair direction
      if (!dir) return "No target in sights.";
      let best = null, bd = st.range;
      for (const [id, a] of aliveNpcs) {
        const dx = a.pos.x - me.pos.x, dz = a.pos.z - me.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > st.range || d < 0.5) continue;
        const dot = (dx * dir.x + dz * dir.z) / (d * Math.hypot(dir.x, dir.z));
        if (dot > 0.978 && d < bd) { bd = d; best = id; }
      }
      if (!best) return "No target in sights.";
      this._pCd = { ...this._pCd, [mode]: this.now() + st.cd };
      this.damage(best, st.dmg, "player");
      this.shots.push({ from: "player", to: best, mode: "bolt" });
      return `You bolt ${this.agents[best].label}!`;
    }
    if (mode === "heavy") {
      // cleave: every NPC in range
      const hit = aliveNpcs.filter(([, a]) => me.pos.distanceTo(a.pos) < st.range);
      if (!hit.length) return "No one in range.";
      this._pCd = { ...this._pCd, [mode]: this.now() + st.cd };
      for (const [id] of hit) {
        this.damage(id, st.dmg, "player");
        this.shots.push({ from: "player", to: id, mode: "heavy" });
      }
      return `You cleave ${hit.map(([id]) => this.agents[id].label).join(", ")}!`;
    }
    // slash: nearest NPC in range
    let best = null, bd = st.range;
    for (const [id, a] of aliveNpcs) {
      const d = me.pos.distanceTo(a.pos);
      if (d < bd) { bd = d; best = id; }
    }
    if (!best) return "No one in range.";
    this._pCd = { ...this._pCd, [mode]: this.now() + st.cd };
    this.damage(best, st.dmg, "player");
    this.shots.push({ from: "player", to: best, mode: "slash" });
    return `You strike ${this.agents[best].label}!`;
  }

  timeLeft() { return Math.max(0, this.phaseEndsAt - performance.now() / 1000); }

  tick() {
    if (this.phase === "over") return null;
    // Fire the parallel Phase-2 ACTION calls at 0:03 so orders land by 0:00.
    if (this.phase === "talk" && !this.actionsRequested && this.timeLeft() <= 3) {
      this.actionsRequested = true;
      this.chatLocked = true;
      this.addFeed?.("📜 Commanders are issuing orders… (chat locked)");
      return "lock";
    }
    if (this.timeLeft() <= 0) {
      if (this.phase === "talk") {
        this.phase = "battle";
        this.phaseEndsAt = performance.now() / 1000 + this.battleDuration;
        this.addFeed?.("⚔️ Talk time over — BATTLE begins! Alliances locked, directives turn hostile.");
        return "battle";
      } else {
        this.phase = "over";
        const alive = Object.entries(this.agents).filter(([, a]) => a.alive);
        this.winner = alive.length === 1 ? alive[0][1].label : "No one (draw)";
        return "over";
      }
    }
    return null;
  }

  checkEnd() {
    const alive = Object.entries(this.agents).filter(([, a]) => a.alive);
    if (alive.length <= 1) {
      this.phase = "over";
      this.winner = alive.length ? alive[0][1].label : "No one";
      this.addFeed?.(`🏆 Game over — winner: ${this.winner}`);
    }
  }
}
