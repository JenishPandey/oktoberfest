import * as THREE from "three";

// Landmark positions — shared vocabulary between game + LLM directives.
export const LANDMARKS = {
  Fountain: new THREE.Vector3(0, 0, 0),
  Ruins: new THREE.Vector3(-18, 0, -14),
  Tower: new THREE.Vector3(18, 0, -12),
  Grove: new THREE.Vector3(-16, 0, 16),
  Docks: new THREE.Vector3(17, 0, 15),
};

export const ARENA_HALF = 26; // playable half-extent

// Registry of per-frame world animations. Filled by buildWorld, driven by tickWorld.
const worldAnim = [];

export function buildWorld(scene) {
  worldAnim.length = 0;
  const anim = worldAnim; // per-frame world animations: fn(t, dt)
  // NOTE: buildWorld runs once; tickWorld() below drives everything in `anim`.
  // --- renderer-agnostic lights / sky ---
  scene.background = new THREE.Color(0x87a5c9);
  scene.fog = new THREE.Fog(0x87a5c9, 55, 130);

  const hemi = new THREE.HemisphereLight(0xcfe5ff, 0x3a5f3a, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.6);
  sun.position.set(30, 45, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -40; sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40;
  scene.add(sun);

  // --- sky detail: visible sun disc + drifting clouds ---
  const sunDisc = new THREE.Mesh(
    new THREE.SphereGeometry(4, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff7cc, fog: false })
  );
  sunDisc.position.set(70, 55, -60);
  scene.add(sunDisc);
  const sunGlow = new THREE.Mesh(
    new THREE.SphereGeometry(6.5, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffedb5, transparent: true, opacity: 0.35, fog: false })
  );
  sunGlow.position.copy(sunDisc.position);
  scene.add(sunGlow);

  const clouds = [];
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.9 });
  for (let i = 0; i < 5; i++) {
    const g = new THREE.Group();
    for (let j = 0; j < 3; j++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(2.2 - j * 0.4, 10, 8), cloudMat);
      puff.position.set(j * 2.6 - 2.4, (j % 2) * 0.7, (j - 1) * 1.2);
      puff.scale.y = 0.55;
      g.add(puff);
    }
    g.position.set(-60 + i * 26, 24 + (i % 3) * 3, -35 + (i % 2) * 30);
    scene.add(g);
    clouds.push({ g, speed: 0.5 + (i % 3) * 0.3 });
  }
  anim.push((_t, dt) => {
    for (const c of clouds) {
      c.g.position.x += c.speed * dt;
      if (c.g.position.x > 70) c.g.position.x = -70;
    }
  });

  // --- ground ---
  const groundGeo = new THREE.PlaneGeometry(ARENA_HALF * 2 + 14, ARENA_HALF * 2 + 14);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x5d8a5a, roughness: 1 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // subtle grid
  const grid = new THREE.GridHelper(ARENA_HALF * 2, 26, 0xffffff, 0xffffff);
  grid.material.transparent = true;
  grid.material.opacity = 0.08;
  grid.position.y = 0.02;
  scene.add(grid);

  const colliders = []; // {min:Vector3, max:Vector3} AABBs for collision + pathfinding

  function addBox(x, z, w, h, d, color, name) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
    );
    m.position.set(x, h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    colliders.push({
      name: name || "",
      min: new THREE.Vector3(x - w / 2, 0, z - d / 2),
      max: new THREE.Vector3(x + w / 2, h, z + d / 2),
    });
    return m;
  }

  function addCylinder(x, z, r, h, color) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r * 1.15, h, 20),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8 })
    );
    m.position.set(x, h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    colliders.push({
      name: "",
      min: new THREE.Vector3(x - r, 0, z - r),
      max: new THREE.Vector3(x + r, h, z + r),
    });
    return m;
  }

  // --- perimeter walls ---
  const wallColor = 0x6b7280;
  const H = 3, T = 1;
  addBox(0, -ARENA_HALF - 0.5, ARENA_HALF * 2 + 2, H, T, wallColor);
  addBox(0, ARENA_HALF + 0.5, ARENA_HALF * 2 + 2, H, T, wallColor);
  addBox(-ARENA_HALF - 0.5, 0, T, H, ARENA_HALF * 2 + 2, wallColor);
  addBox(ARENA_HALF + 0.5, 0, T, H, ARENA_HALF * 2 + 2, wallColor);

  // --- central fountain (landmark) ---
  addCylinder(0, 0, 3.2, 1.0, 0x9ca3af);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 2.6, 0.3, 24),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.2, metalness: 0.3 })
  );
  water.position.set(0, 1.05, 0);
  scene.add(water);
  const obelisk = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, 3.4, 6),
    new THREE.MeshStandardMaterial({ color: 0xe5e7eb })
  );
  obelisk.position.set(0, 2.8, 0);
  obelisk.castShadow = true;
  scene.add(obelisk);
  // fountain life: shimmering water + slowly turning obelisk
  anim.push((t, dt) => {
    water.position.y = 1.05 + Math.sin(t * 2.1) * 0.05;
    water.rotation.y += dt * 0.4;
    obelisk.rotation.y += dt * 0.35;
  });

  // --- stone cross-paths + fountain plaza ---
  const pathMat = new THREE.MeshStandardMaterial({ color: 0xb8a888, roughness: 1 });
  for (const [w, d, x, z] of [[3, ARENA_HALF * 2, 0, 0], [ARENA_HALF * 2, 3, 0, 0]]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d), pathMat);
    p.rotation.x = -Math.PI / 2;
    p.position.set(x, 0.015, z);
    p.receiveShadow = true;
    scene.add(p);
  }
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(5.6, 28),
    new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 1 })
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.012;
  plaza.receiveShadow = true;
  scene.add(plaza);

  // --- quadrant landmarks ---
  // Ruins: broken pillars
  for (let i = 0; i < 5; i++) {
    const px = LANDMARKS.Ruins.x + (i - 2) * 2.2;
    const h = 1.5 + (i % 3);
    addBox(px, LANDMARKS.Ruins.z + (i % 2) * 2, 1.2, h, 1.2, 0xd6c39a, "ruin");
  }
  // Tower: tall block + roof
  addBox(LANDMARKS.Tower.x, LANDMARKS.Tower.z, 4, 7, 4, 0x8b5a2b, "tower");
  // Grove: trees (cylinders + spheres)
  for (let i = 0; i < 6; i++) {
    const tx = LANDMARKS.Grove.x + Math.cos(i * 1.05) * 4;
    const tz = LANDMARKS.Grove.z + Math.sin(i * 1.05) * 4;
    addCylinder(tx, tz, 0.35, 2.2, 0x5b3a1e);
    const leaves = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x2f7a3d, roughness: 1 })
    );
    leaves.position.set(tx, 3.1, tz);
    leaves.castShadow = true;
    scene.add(leaves);
  }
  // Docks: crates
  addBox(15, 13, 3, 1.4, 3, 0xa16207, "crate");
  addBox(19, 16.5, 2.2, 1.0, 2.2, 0x92400e, "crate");
  addBox(17, 12, 1.6, 0.8, 1.6, 0xb45309, "crate");

  // --- scattered cover blocks ---
  addBox(-6, -6, 2, 1.2, 2, 0x9ca3af);
  addBox(7, -4, 2, 1.2, 4, 0x9ca3af);
  addBox(-7, 6, 4, 1.2, 2, 0x9ca3af);
  addBox(6, 7, 2.5, 1.2, 2.5, 0x9ca3af);
  addBox(0, -14, 6, 1.1, 1.2, 0x9ca3af);
  addBox(0, 12, 6, 1.1, 1.2, 0x9ca3af);

  // --- spawn pads (red = you, gray = NPCs, colors TBD) ---
  const padDefs = [
    [0, 22, 0xdc2626],     // player (red, south)
    [-20, -20, 0x9ca3af],  // Nova (TBD)
    [20, -20, 0x9ca3af],   // Rex (TBD)
    [0, -8, 0x9ca3af],     // Vera (TBD)
  ];
  for (const [x, z, color] of padDefs) {
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 24),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8 })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(x, 0.02, z);
    pad.receiveShadow = true;
    scene.add(pad);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.07, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(x, 0.04, z);
    scene.add(rim);
  }

  // --- lamp posts around the fountain (flickering amber heads) ---
  const lampHeads = [];
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 4) + i * (Math.PI / 2);
    const lx = Math.cos(a) * 7.2, lz = Math.sin(a) * 7.2;
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.12, 3.0, 8),
      new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.6, metalness: 0.5 })
    );
    post.position.set(lx, 1.5, lz);
    post.castShadow = true;
    scene.add(post);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffb300, emissive: 0xff9d00, emissiveIntensity: 1.4, roughness: 0.4,
    });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), headMat);
    head.position.set(lx, 3.2, lz);
    scene.add(head);
    lampHeads.push({ mat: headMat, seed: i * 1.7 });
    colliders.push({
      name: "lamp",
      min: new THREE.Vector3(lx - 0.15, 0, lz - 0.15),
      max: new THREE.Vector3(lx + 0.15, 3, lz + 0.15),
    });
  }
  anim.push((t) => {
    for (const l of lampHeads) l.mat.emissiveIntensity = 1.3 + Math.sin(t * 7 + l.seed) * 0.25;
  });

  // --- tower extras: battlements, glowing window, war flag ---
  const TW = LANDMARKS.Tower;
  for (const [ox, oz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) {
    const merlon = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.7, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 })
    );
    merlon.position.set(TW.x + ox, 7.35, TW.z + oz);
    merlon.castShadow = true;
    scene.add(merlon);
  }
  const towerWin = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 1.2),
    new THREE.MeshStandardMaterial({ color: 0xffc53d, emissive: 0xff9d00, emissiveIntensity: 1.2 })
  );
  towerWin.position.set(TW.x, 4.6, TW.z + 2.01);
  scene.add(towerWin);
  const flagPole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 2.4, 8),
    new THREE.MeshStandardMaterial({ color: 0x374151 })
  );
  flagPole.position.set(TW.x, 8.2, TW.z);
  scene.add(flagPole);
  const warFlag = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 1.0),
    new THREE.MeshStandardMaterial({ color: 0xdc2626, side: THREE.DoubleSide })
  );
  warFlag.position.set(TW.x + 0.85, 8.9, TW.z);
  scene.add(warFlag);
  anim.push((t) => { warFlag.rotation.y = Math.sin(t * 3.2) * 0.35; });

  // --- ruins: a toppled column + tilted slab ---
  const fallen = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 3.6, 12),
    new THREE.MeshStandardMaterial({ color: 0xcbbf9a, roughness: 1 })
  );
  fallen.rotation.z = Math.PI / 2;
  fallen.rotation.y = 0.35;
  fallen.position.set(LANDMARKS.Ruins.x + 1, 0.55, LANDMARKS.Ruins.z + 5.5);
  fallen.castShadow = true; fallen.receiveShadow = true;
  scene.add(fallen);
  addBox(LANDMARKS.Ruins.x + 1, LANDMARKS.Ruins.z + 5.5, 3.4, 0.9, 1.1, 0xcbbf9a, "fallen-column");

  // --- grove extras: bushes + drifting fireflies ---
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x3d8a4c, roughness: 1 });
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.6 + (i % 2) * 0.25, 10, 8), bushMat);
    b.position.set(LANDMARKS.Grove.x - 3 + i * 1.7, 0.5, LANDMARKS.Grove.z + 5.2 - (i % 3));
    b.castShadow = true;
    scene.add(b);
  }
  const fireflies = [];
  const flyMat = new THREE.MeshBasicMaterial({ color: 0xfef9a });
  for (let i = 0; i < 7; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), flyMat);
    scene.add(f);
    fireflies.push({ m: f, a: (i / 7) * Math.PI * 2, r: 2.5 + (i % 3), h: 1 + (i % 4) * 0.5, sp: 0.5 + (i % 3) * 0.25 });
  }
  anim.push((t) => {
    for (const f of fireflies) {
      const a = f.a + t * f.sp;
      f.m.position.set(
        LANDMARKS.Grove.x + Math.cos(a) * f.r,
        f.h + Math.sin(t * 2 + f.a) * 0.3,
        LANDMARKS.Grove.z + Math.sin(a) * f.r
      );
    }
  });

  // --- docks extras: barrels + stacked planks ---
  for (const [bx, bz] of [[13.2, 16.2], [14.1, 16.6], [13.6, 15.4]]) {
    addCylinder(bx, bz, 0.55, 1.1, 0x6b4226);
  }
  const planks = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 0.35, 1.0),
    new THREE.MeshStandardMaterial({ color: 0x9a6a3b, roughness: 1 })
  );
  planks.position.set(20.5, 0.18, 13.2);
  planks.rotation.y = 0.4;
  planks.castShadow = true; planks.receiveShadow = true;
  scene.add(planks);

  // --- wall banners: red = player, gray = unassigned ---
  const bannerDefs = [
    [-9, 0xdc2626], [-3, 0x64748b], [3, 0xcbd5e1], [9, 0x64748b],
  ];
  for (const [bx, color] of bannerDefs) {
    const b = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 3.0),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide })
    );
    b.position.set(bx, 2.2, -ARENA_HALF + 0.55);
    scene.add(b);
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(2.3, 0.18, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.6 })
    );
    trim.position.set(bx, 3.8, -ARENA_HALF + 0.55);
    scene.add(trim);
  }

  // --- south gate arch (player entrance) ---
  addBox(-2.6, 22, 0.8, 4.2, 0.8, 0x4b5563, "arch");
  addBox(2.6, 22, 0.8, 4.2, 0.8, 0x4b5563, "arch");
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(6.0, 0.7, 0.9),
    new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.8 })
  );
  beam.position.set(0, 4.5, 22);
  beam.castShadow = true;
  scene.add(beam);
  const gateBanner = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 1.6),
    new THREE.MeshStandardMaterial({ color: 0xdc2626, side: THREE.DoubleSide })
  );
  gateBanner.position.set(0, 3.5, 22);
  scene.add(gateBanner);
  anim.push((t) => { gateBanner.rotation.y = Math.sin(t * 2.4) * 0.18; });

  // --- scattered rocks (with colliders) + grass tufts (visual only) ---
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8d8d99, roughness: 1 });
  for (const [rx, rz, s] of [[-10, 2, 0.7], [10, -8, 0.9], [-3, 10, 0.55], [12, 4, 0.65], [-12, -4, 0.8], [4, -19, 0.6]]) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
    rock.position.set(rx, s * 0.6, rz);
    rock.rotation.set(rx, rz, s * 3);
    rock.castShadow = true; rock.receiveShadow = true;
    scene.add(rock);
    addBox(rx, rz, s * 1.4, s, s * 1.4, 0x8d8d99, "rock"); // hidden inside the dodecahedron
  }
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const tuftMat = new THREE.MeshStandardMaterial({ color: 0x4d9a52, roughness: 1 });
  for (let i = 0; i < 26; i++) {
    const gx = (rand() * 2 - 1) * (ARENA_HALF - 2);
    const gz = (rand() * 2 - 1) * (ARENA_HALF - 2);
    if (Math.hypot(gx, gz) < 7) continue; // keep plaza clear
    const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.55, 5), tuftMat);
    tuft.position.set(gx, 0.27, gz);
    scene.add(tuft);
  }

  // --- landmark beacons (floating labels handled in main via sprites) ---
  const beaconOrbs = [];
  for (const [name, pos] of Object.entries(LANDMARKS)) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 4.5, 8),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
    );
    pole.position.set(pos.x + 4.5, 2.25, pos.z);
    scene.add(pole);
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
    );
    orb.position.set(pos.x + 4.5, 4.7, pos.z);
    scene.add(orb);
    beaconOrbs.push({ m: orb, baseY: 4.7, seed: pos.x + pos.z });
  }
  anim.push((t) => {
    for (const o of beaconOrbs) {
      o.m.position.y = o.baseY + Math.sin(t * 1.6 + o.seed) * 0.25;
      const s = 1 + Math.sin(t * 3 + o.seed) * 0.12;
      o.m.scale.set(s, s, s);
    }
  });

  // spawn points: player south, NPCs other corners
  const spawns = {
    player: new THREE.Vector3(0, 0, 22),
    npc0: new THREE.Vector3(-20, 0, -20),
    npc1: new THREE.Vector3(20, 0, -20),
    npc2: new THREE.Vector3(0, 0, -8),
  };

  return { colliders, spawns };
}

// Advance all decorative world animations (clouds, water, flags, fireflies…).
// Called every frame from main.js — purely visual, never affects gameplay.
export function tickWorld(t, dt) {
  for (const fn of worldAnim) fn(t, dt);
}

// Simple AABB collision resolve on XZ plane.
export function collideCircle(pos, radius, colliders) {
  // clamp inside arena
  pos.x = Math.max(-ARENA_HALF + radius, Math.min(ARENA_HALF - radius, pos.x));
  pos.z = Math.max(-ARENA_HALF + radius, Math.min(ARENA_HALF - radius, pos.z));
  for (const c of colliders) {
    const nx = Math.max(c.min.x, Math.min(pos.x, c.max.x));
    const nz = Math.max(c.min.z, Math.min(pos.z, c.max.z));
    const dx = pos.x - nx, dz = pos.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        pos.x = nx + (dx / d) * radius;
        pos.z = nz + (dz / d) * radius;
      } else {
        pos.x = c.max.x + radius; // inside: push out
      }
    }
  }
  return pos;
}
