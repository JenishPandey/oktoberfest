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

  // melee resolution: NPC attack directives + player click attack
  resolveCombat(dt) {
    if (this.phase !== "battle") return;
    for (const [id, a] of Object.entries(this.agents)) {
      if (!a.alive || !a.directive) continue; // player has no directive
      if (a.directive.type !== "attack" || !a.directive.target) continue;
      const t = this.agents[a.directive.target];
      if (!t?.alive) continue;
      if (a.pos.distanceTo(t.pos) < 2.0) {
        a._dmgTick = (a._dmgTick || 0) + dt;
        if (a._dmgTick > 0.9) {
          a._dmgTick = 0;
          this.damage(a.directive.target, 12, id);
        }
      }
    }
  }

  playerAttack() {
    if (this.phase !== "battle") return "Talk phase — no combat yet.";
    let best = null, bd = 3.2;
    for (const [id, a] of Object.entries(this.agents)) {
      if (id === "player" || !a.alive) continue;
      const d = this.agents.player.pos.distanceTo(a.pos);
      if (d < bd) { bd = d; best = id; }
    }
    if (!best) return "No one in range.";
    this.damage(best, 18, "player");
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
