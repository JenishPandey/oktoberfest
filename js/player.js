import * as THREE from "three";
import { collideCircle } from "./world.js";

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

  enableLook(canvas) {
    canvas.addEventListener("click", () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
    });
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
    });
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
  }
}
