import * as THREE from "three";
import { collideCircle } from "./world.js";
import { buildSwordMesh } from "./npcs.js";

const VIEW_TIP = { slash: 0xfef08a, heavy: 0xfb923c, bolt: 0x38bdf8 };

export class Player {
  constructor(scene, colliders, spawn) {
    this.colliders = colliders;
    this.pos = spawn.clone();
    this.yaw = Math.PI; // face center (-z -> +z? we start south looking north)
    this.pitch = 0;
    this.hp = 100;
    this.alive = true;
    this.speed = 6;
    this.keys = {};
    this.radius = 0.5;

    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 300);
    scene.add(this.camera);

    this.mode = "slash"; // slash | heavy | bolt (keys 1/2/3)

    // first-person viewmodel sword, bottom-right of the camera
    this.sword = buildSwordMesh(0xfef08a);
    this.sword.group.position.set(0.35, -0.32, -0.7);
    this.sword.group.rotation.set(0.15, -0.25, 0.1);
    this.camera.add(this.sword.group);
    this.swingT = 0; this.swingDur = 0.3;

    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 0.9, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xdc2626 })
    );
    this.mesh.visible = false; // first person: hide own body
    scene.add(this.mesh);

    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
    addEventListener("keydown", (e) => (this.keys[e.code] = true));
    addEventListener("keyup", (e) => (this.keys[e.code] = false));
  }

  enableLook(canvas) {    canvas.addEventListener("click", () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
    });
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
    });
  }

  getForward() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  // Swing the viewmodel sword. Called on every click-attack.
  swingSword(mode = "slash") {
    this.sword.setTip(VIEW_TIP[mode] || 0xfef08a);
    this.swingDur = mode === "heavy" ? 0.55 : mode === "bolt" ? 0.28 : 0.3;
    this.swingT = this.swingDur;
  }

  tickSword(dt) {
    const sw = this.sword.group;
    if (this.swingT > 0) {
      this.swingT -= dt;
      const p = 1 - Math.max(0, this.swingT) / this.swingDur;
      const s = Math.sin(Math.min(1, Math.max(0, p)) * Math.PI);
      if (this.mode === "heavy") sw.rotation.set(-1.8 + 2.4 * p, -0.25, 0.1); // overhead chop
      else if (this.mode === "bolt") sw.position.z = -0.7 - 0.35 * s; // thrust
      else sw.rotation.set(0.15, -0.25 - 1.1 * s, 0.1 + 0.35 * s); // horizontal slash
    } else {
      sw.position.set(0.35, -0.32, -0.7);
      sw.rotation.set(0.15, -0.25, 0.1);
    }
  }

  update(dt) {
    if (!this.alive) return;
    const sprint = this.keys["ShiftLeft"] ? 1.5 : 1;
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const move = new THREE.Vector3();
    if (this.keys["KeyW"]) move.add(f);
    if (this.keys["KeyS"]) move.sub(f);
    if (this.keys["KeyD"]) move.add(r);
    if (this.keys["KeyA"]) move.sub(r);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(this.speed * sprint * dt);
      this.pos.add(move);
      collideCircle(this.pos, this.radius, this.colliders);
    }
    this.mesh.position.set(this.pos.x, 0.9, this.pos.z);
    this.camera.position.set(this.pos.x, 1.65, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.tickSword(dt);
  }
}
