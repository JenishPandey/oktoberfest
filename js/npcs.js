import * as THREE from "three";
import { findPath } from "./pathfinding.js";
import { collideCircle, LANDMARKS } from "./world.js";

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
    scene.add(this.group);
  }

  setDirective(d) {
    if (!d || typeof d !== "object") return;
    const t = String(d.type || "hold").toLowerCase();
    const allowed = ["goto", "hold", "follow", "attack", "ally", "moveto"];
    this.directive = {
      type: allowed.includes(t) ? t : "hold",
      target: d.target, location: d.location, x: d.x, z: d.z,
    };
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
      if (this.repathTimer <= 0 || this.path.length === 0) {
        this.repathTimer = this.directive.type === "hold" ? 2 : 0.8;
        this.path = findPath(this.pos, targetPos);
      }
      dest = this.path.length ? this.path[0] : null;
      this.moving = !!dest;
      // attack: strike when close (damage applied by game.js)
      if (this.directive.type === "attack" && targetPos) {
        if (this.pos.distanceTo(targetPos) < 1.6) { this.moving = false; dest = null; }
      }
      if (this.directive.type === "follow" && targetPos) {
        if (this.pos.distanceTo(targetPos) < 2.5) { this.moving = false; dest = null; }
      }
    }

    if (dest) {
      const dir = dest.clone().sub(this.pos); dir.y = 0;
      const dist = dir.length();
      if (dist < 0.35) this.path.shift();
      else {
        dir.normalize();
        this.pos.addScaledVector(dir, Math.min(this.speed * dt, dist));
        collideCircle(this.pos, this.radius, this.colliders);
        this.group.rotation.y = Math.atan2(dir.x, dir.z);
      }
    } else {
      // idle sway + slow look-around
      this.group.rotation.y += Math.sin(this.bob * 0.4) * dt * 0.4;
    }

    const hop = this.moving ? Math.abs(Math.sin(this.bob)) * 0.08 : Math.sin(this.bob) * 0.02;
    this.group.position.set(this.pos.x, hop, this.pos.z);
    this.body.scale.y = 1 + (this.moving ? Math.sin(this.bob) * 0.03 : 0);
    this.ring.visible = this.thinking;
    if (this.thinking) this.ring.rotation.y += dt * 3;
  }
}
