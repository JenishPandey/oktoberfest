import * as THREE from "three";
import { findPath } from "./pathfinding.js";
import { collideCircle, LANDMARKS } from "./world.js";

// Shared sword mesh: guard + blade + glowing tip. Returns {group, setTip(color)}.
// Used by NPCs (hip-carried) and the first-person player viewmodel.
export function buildSwordMesh(tipColor = 0xfef08a) {
  const group = new THREE.Group();
  const guard = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.05, 0.07),
    new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.6 })
  );
  group.add(guard);
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.85, 0.035),
    new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.3, metalness: 0.7 })
  );
  blade.position.y = 0.45;
  group.add(blade);
  const tipMat = new THREE.MeshBasicMaterial({ color: tipColor });
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.12, 0.04), tipMat);
  tip.position.y = 0.9;
  group.add(tip);
  return { group, setTip(c) { tipMat.color.setHex(c); } };
}

const MODE_TIP = { melee: 0xf87171, brute: 0xef4444, ranged: 0x38bdf8, slash: 0xfef08a, heavy: 0xfb923c, bolt: 0x38bdf8 };

function nameSprite(name, color) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(0, 8, 256, 48);
  g.fillStyle = color;
  g.font = "bold 26px sans-serif";
  g.textAlign = "center";
  g.fillText(name, 128, 42);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set(2.4, 0.6, 1);
  return sp;
}

// NPC: mesh + local locomotion. NEVER blocks on network.
// setDirective() is the only input from the cloud; everything else runs locally.
export class NPCAgent {
  constructor(scene, colliders, id, label, color, spawn, visorColor = 0x111827) {
    this.id = id; this.label = label; this.color = color;
    this.colliders = colliders;
    this.pos = spawn.clone();
    this.hp = 100; this.alive = true;
    this.speed = 3.2;
    this.radius = 0.5;
    this.directive = { type: "hold" }; // high-level only
    this.path = [];
    this.repathTimer = 0;
    this.idleTimer = Math.random() * 2;
    this.wanderTarget = null;
    this.bob = Math.random() * 10;
    this.thinking = false; // true while cloud request in flight (visual only)
    this.lastDialogue = "...";
    this.attackCd = 0;

    this.group = new THREE.Group();
    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.38, 1.0, 6, 14),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7 })
    );
    this.body.position.y = 1.0;
    this.body.castShadow = true;
    this.group.add(this.body);
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.16, 0.1),
      new THREE.MeshBasicMaterial({ color: visorColor })
    );
    visor.position.set(0, 1.5, 0.35);
    this.group.add(visor);
    this.tag = nameSprite(label, "#ffffff");
    this.tag.position.y = 2.5;
    this.group.add(this.tag);
    // "thinking" ring: visible while awaiting cloud response
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.05, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
    );
    this.ring.position.y = 2.1;
    this.ring.visible = false;
    this.group.add(this.ring);
    // sword: carried at the side, swung on every landed hit (swing() called
    // by main.js when a shot event names this NPC as attacker)
    this.sword = buildSwordMesh(0xf87171);
    this.sword.group.position.set(0.5, 0.9, 0.15);
    this.sword.group.rotation.set(0, 0, -0.25); // rest angle
    this.group.add(this.sword.group);
    this.swingT = 0; this.swingDur = 0.35;
    scene.add(this.group);
  }

  // Start a swing scaled to the attack mode. Called on landed hits.
  swing(mode = "melee") {
    this.swingDur = mode === "brute" ? 0.6 : mode === "ranged" ? 0.3 : 0.35;
    this.swingT = this.swingDur;
  }

  poseSword(p) {
    const sw = this.sword.group, mode = this.directive.mode || "melee";
    const s = Math.sin(Math.min(1, Math.max(0, p)) * Math.PI);
    if (mode === "brute") sw.rotation.set(-2.4 + 3.0 * p, 0, -0.1); // overhead smash
    else if (mode === "ranged") { sw.rotation.set(-1.4, 0, 0); sw.position.z = 0.15 + 0.45 * s; } // forward jab
    else sw.rotation.set(0, -1.3 + 2.4 * p, -0.25 + 0.25 * s); // horizontal sweep
  }

  setDirective(d) {
    if (!d || typeof d !== "object") return;
    const t = String(d.type || "hold").toLowerCase();
    const allowed = ["goto", "hold", "follow", "attack", "ally", "moveto"];
    const m = String(d.mode || "melee").toLowerCase();
    this.directive = {
      type: allowed.includes(t) ? t : "hold",
      target: d.target, location: d.location, x: d.x, z: d.z,
      mode: ["melee", "brute", "ranged"].includes(m) ? m : "melee",
    };
    if (t === "attack" && this.sword) this.sword.setTip(MODE_TIP[this.directive.mode] || 0xf87171);
    this.path = []; // force repath
    this.repathTimer = 0;
  }

  resolveTargetPos(agents) {
    const d = this.directive;
    if (d.type === "goto" && d.location && LANDMARKS[d.location]) {
      const p = LANDMARKS[d.location].clone();
      p.x += 1.5; p.z += 1.5;
      return p;
    }
    // MOVE_TO from Phase-2 ACTION: raw arena coordinates, clamped locally.
    if (d.type === "moveto" && isFinite(d.x) && isFinite(d.z)) {
      const H = 26;
      return new THREE.Vector3(
        Math.max(-H + 1, Math.min(H - 1, +d.x)), 0,
        Math.max(-H + 1, Math.min(H - 1, +d.z)));
    }
    if ((d.type === "follow" || d.type === "attack" || d.type === "ally") && d.target) {
      const t = agents[d.target];
      if (t && t.alive) return t.pos.clone();
    }
    return null;
  }

  update(dt, agents) {
    if (!this.alive) {
      this.group.rotation.x = Math.min(Math.PI / 2, this.group.rotation.x + dt * 2);
      this.group.position.set(this.pos.x, 0, this.pos.z);
      return;
    }
    this.bob += dt * (this.moving ? 9 : 2.5);
    this.attackCd = Math.max(0, this.attackCd - dt);

    const targetPos = this.resolveTargetPos(agents);
    let dest = null;

    if (this.directive.type === "hold" || !targetPos) {
      // natural idle: wander in a small radius so lag never looks frozen
      this.idleTimer -= dt;
      if (this.idleTimer <= 0 || !this.wanderTarget) {
        this.idleTimer = 2 + Math.random() * 3;
        this.wanderTarget = this.pos.clone();
        this.wanderTarget.x += (Math.random() - 0.5) * 6;
        this.wanderTarget.z += (Math.random() - 0.5) * 6;
        this.path = findPath(this.pos, this.wanderTarget);
      }
      dest = this.path.length ? this.path[0] : null;
      this.moving = !!dest;
    } else {
      // goto / follow / attack / ally: repath periodically (targets move)
      this.repathTimer -= dt;
      if (this.directive.type === "attack" && this.directive.mode === "ranged" && targetPos) {
        // ranged: hold an 8–16 m band — back off when crowded, close in when far,
        // strafe in place when the shot is lined up.
        const dist = this.pos.distanceTo(targetPos);
        if (dist < 8) {
          const away = this.pos.clone().sub(targetPos).normalize().multiplyScalar(5).add(this.pos);
          away.y = 0;
          this.path = findPath(this.pos, away);
          this.repathTimer = 0.8;
        } else if (dist > 16) {
          if (this.repathTimer <= 0 || this.path.length === 0) {
            this.repathTimer = 0.8;
            this.path = findPath(this.pos, targetPos);
          }
        } else {
          this.path = []; // in the pocket: stand ground, keep the shot lined up
        }
      } else if (this.repathTimer <= 0 || this.path.length === 0) {
        this.repathTimer = this.directive.type === "hold" ? 2 : 0.8;
        this.path = findPath(this.pos, targetPos);
      }
      dest = this.path.length ? this.path[0] : null;
      this.moving = !!dest;
      if (this.directive.type === "attack" && targetPos) {
        if (this.directive.mode === "ranged") {
          // stand ground in the pocket and face the target (damage by game.js)
          if (!this.path.length) { this.moving = false; dest = null; }
        } else if (this.pos.distanceTo(targetPos) < 1.6) {
          this.moving = false; dest = null; // in striking range: plant feet
        }
        // face the target while engaged (stationary case re-applied after idle sway below)
        this._faceTarget = targetPos;
      }
      if (this.directive.type === "follow" && targetPos) {
        if (this.pos.distanceTo(targetPos) < 2.5) { this.moving = false; dest = null; }
      }
    }

    if (dest) {
      this._faceTarget = null; // moving: face travel direction instead
      const dir = dest.clone().sub(this.pos); dir.y = 0;
      const dist = dir.length();
      if (dist < 0.35) this.path.shift();
      else {
        dir.normalize();
        this.pos.addScaledVector(dir, Math.min(this.speed * dt, dist));
        collideCircle(this.pos, this.radius, this.colliders);
        this.group.rotation.y = Math.atan2(dir.x, dir.z);
      }
    } else if (this._faceTarget) {
      // engaged but stationary (strike range / firing pocket): face the target
      this.group.rotation.y = Math.atan2(this._faceTarget.x - this.pos.x, this._faceTarget.z - this.pos.z);
      this._faceTarget = null;
    } else {
      // idle sway + slow look-around
      this.group.rotation.y += Math.sin(this.bob * 0.4) * dt * 0.4;
    }

    const hop = this.moving ? Math.abs(Math.sin(this.bob)) * 0.08 : Math.sin(this.bob) * 0.02;
    this.group.position.set(this.pos.x, hop, this.pos.z);
    this.body.scale.y = 1 + (this.moving ? Math.sin(this.bob) * 0.03 : 0);
    this.ring.visible = this.thinking;
    if (this.thinking) this.ring.rotation.y += dt * 3;
    // sword swing: progress 0→1 while swingT burns, else rest pose with walk bob
    if (this.swingT > 0) {
      this.swingT -= dt;
      this.poseSword(1 - Math.max(0, this.swingT) / this.swingDur);
    } else {
      this.sword.group.rotation.set(0.08 * Math.sin(this.bob), 0, -0.25);
      this.sword.group.position.set(0.5, 0.9, 0.15);
    }
  }
}
