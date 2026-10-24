// Bench picking: pointer interaction and pick target positions.

import * as THREE from 'three';
import type { PickTarget, ScreenPoint } from '../scene-api';
import { threeToPose } from '../imupose';
import { MAT, type PinRec } from './util';
import type { BenchCtx } from './ctx';

/** Pointer input: picking, buttons, keys, pot / encoder / obstacle drag, hover, touch and IMU tilt. */
export function mountPointer(ctx: BenchCtx): void {
  const { renderer, scene, camera, controls, rig, partsById, placeObstacle, rayDistance, applyPose } = ctx;
  // ---------------------------------------------------------------- picking

  const ray = new THREE.Raycaster();
  const toNdc = (ev: { clientX: number; clientY: number }) => {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  };
  const resolveHit = (h: THREE.Intersection): PickTarget | null => {
    const ids = h.object.userData.pinIds as string[] | undefined;
    if (ids && h.instanceId !== undefined) return { kind: 'pin', id: ids[h.instanceId] };
    for (let o: THREE.Object3D | null = h.object; o; o = o.parent) if (o.userData.pick) return o.userData.pick as PickTarget;
    return null;
  };
  const pickAt = (ev: { clientX: number; clientY: number }): PickTarget | null => {
    ray.setFromCamera(toNdc(ev), camera);
    // A Dupont plug stands right beside its pin and hides it from most angles: if the first hit is a wire and a pin
    // or button lies just behind it (within 15 mm), take the pin the user meant
    let first: { t: PickTarget; d: number } | null = null;
    for (const h of ray.intersectObjects([ctx.board.grp, ctx.parts], true)) {
      const t = resolveHit(h);
      if (!t) continue;
      if (!first) {
        if (t.kind !== 'wire') return t;
        first = { t, d: h.distance };
        continue;
      }
      if (h.distance - first.d > 15) break;
      if (t.kind === 'pin' || t.kind === 'button') return t;
    }
    return first?.t ?? null;
  };

  // Board buttons: press / release
  ctx.buttonCb = null;
  ctx.boardBtnCb = null;
  ctx.pickCb = null;
  let pressed: THREE.Mesh | null = null;
  const pick = (ev: PointerEvent) => {
    ray.setFromCamera(toNdc(ev), camera);
    const hit = ray.intersectObject(ctx.board.grp, true)[0];
    const t = hit && resolveHit(hit);
    return t && t.kind === 'button' ? ctx.board.buttons.find((b) => b.name === t.id) : undefined;
  };
  // Breadboard tactile keys: holding the cap = pin to GND
  ctx.keyCb = null;
  let keyDown: { pin: number; key: THREE.Mesh } | null = null;
  const pickKey = (ev: PointerEvent) => {
    if (!ctx.keys.length) return undefined;
    ray.setFromCamera(toNdc(ev), camera);
    const hit = ray.intersectObjects(ctx.keys.map((k) => k.key))[0];
    return hit ? ctx.keys.find((k) => k.key === hit.object) : undefined;
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    const k = pickKey(ev);
    if (!k) return;
    controls.enabled = false;
    keyDown = k;
    k.key.position.y = k.key.userData.baseY - 1.2;
    ctx.keyCb?.(k.pin, true);
  });
  window.addEventListener('pointerup', () => {
    if (!keyDown) return;
    keyDown.key.position.y = keyDown.key.userData.baseY;
    ctx.keyCb?.(keyDown.pin, false);
    keyDown = null;
    controls.enabled = true;
  });
  // Potentiometer: hold the knob and drag sideways to turn (270° travel)
  let dragging: { pot: (typeof ctx.pots)[number]; x0: number; v0: number } | null = null;
  const pickPot = (ev: PointerEvent) => {
    ray.setFromCamera(toNdc(ev), camera);
    const hit = ray.intersectObjects(ctx.pots.map((p) => p.hit))[0];
    return hit ? ctx.pots.find((p) => p.hit === hit.object) : undefined;
  };
  const turnPot = (pot: (typeof ctx.pots)[number], v: number) => {
    pot.v = Math.min(1, Math.max(0, v));
    pot.knob.rotation.y = -(pot.v - 0.5) * 1.5 * Math.PI;
  };
  ctx.turnPot = turnPot;
  let downAt: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY };
    const pot = pickPot(ev);
    if (pot) {
      controls.enabled = false;
      dragging = { pot, x0: ev.clientX, v0: pot.v };
      return;
    }
  });
  window.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    turnPot(dragging.pot, dragging.v0 + (ev.clientX - dragging.x0) / 240);
    ctx.potCb?.(dragging.pot.pin, dragging.pot.v);
  });
  window.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = null;
      controls.enabled = true;
    }
  });
  // Encoder knob: drag sideways (14 px per detent, EC11 has 20 per turn), one wheel notch per detent; hold still 150 ms = press, quick tap = click
  const ENC_PX = 14;
  ctx.encDrag = null;
  const hitEncoder = (ev: { clientX: number; clientY: number }) => {
    if (!ctx.encoder) return false;
    ray.setFromCamera(toNdc(ev), camera);
    const { hit, occl } = ctx.encoder;
    // A ring under a panel (M5Dial) counts only where it is the nearest surface, not through the glass
    return occl ? ray.intersectObject(occl, true)[0]?.object === hit : ray.intersectObject(hit).length > 0;
  };
  const showKnob = () => {
    if (!ctx.encoder) return;
    ctx.encoder.knob.rotation.y = -(ctx.encoder.pos * Math.PI) / 10;
    ctx.encoder.knob.position.y = ctx.encoder.y0 - (ctx.encoder.pushed ? (ctx.encoder.btn !== undefined ? 0.4 : 1.2) : 0);
  };
  ctx.showKnob = showKnob;
  const turnEncoder = (steps: number) => {
    if (!ctx.encoder || !steps) return;
    ctx.encoder.pos += steps;
    showKnob();
    ctx.encCb?.(steps);
  };
  const pushEncoder = (down: boolean) => {
    if (!ctx.encoder) return;
    ctx.encoder.pushed = down;
    showKnob();
    if (ctx.encoder.btn !== undefined) ctx.boardBtnCb?.(ctx.encoder.btn, down);
    else ctx.encSwCb?.(down);
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (!hitEncoder(ev)) return;
    controls.enabled = false;
    const d = { x0: ev.clientX, sent: 0, moved: false, held: false, timer: 0 };
    d.timer = window.setTimeout(() => {
      if (ctx.encDrag === d && !d.moved) {
        d.held = true;
        pushEncoder(true);
      }
    }, 150);
    ctx.encDrag = d;
  });
  window.addEventListener('pointermove', (ev) => {
    if (!ctx.encDrag) return;
    const dx = ev.clientX - ctx.encDrag.x0;
    if (Math.abs(dx) > 4) ctx.encDrag.moved = true;
    const want = Math.trunc(dx / ENC_PX);
    if (want !== ctx.encDrag.sent) {
      turnEncoder(want - ctx.encDrag.sent);
      ctx.encDrag.sent = want;
    }
  });
  window.addEventListener('pointerup', () => {
    const d = ctx.encDrag;
    if (!d) return;
    ctx.encDrag = null;
    clearTimeout(d.timer);
    controls.enabled = true;
    if (d.held) pushEncoder(false);
    else if (!d.moved) {
      pushEncoder(true);
      setTimeout(() => pushEncoder(false), 120);
    }
  });
  // Wheel over the knob turns the encoder instead of zooming (capture phase runs before OrbitControls)
  renderer.domElement.addEventListener(
    'wheel',
    (ev) => {
      if (!hitEncoder(ev)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      turnEncoder(ev.deltaY < 0 ? 1 : -1);
    },
    { capture: true, passive: false },
  );
  // Obstacle: hold and drag along the sensor's facing (projected onto the sensor's horizontal line)
  let obDrag: { last: number } | null = null;
  const hitObstacle = (ev: { clientX: number; clientY: number }) => {
    if (!ctx.sonar || !ctx.sonar.obstacle.visible) return false;
    ray.setFromCamera(toNdc(ev), camera);
    return ray.intersectObject(ctx.sonar.obstacle, true).length > 0;
  };
  const groundAt = (ev: { clientX: number; clientY: number }, y: number) => {
    ray.setFromCamera(toNdc(ev), camera);
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
  };
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (ctx.encDrag || !hitObstacle(ev)) return;
    controls.enabled = false;
    obDrag = { last: performance.now() };
  });
  window.addEventListener('pointermove', (ev) => {
    if (!obDrag || !ctx.sonar) return;
    const p = groundAt(ev, ctx.sonar.origin.y);
    if (!p) return;
    const cm = Math.round(Math.min(100, Math.max(2, (p.x - ctx.sonar.origin.x) / 10)) * 10) / 10;
    placeObstacle(cm);
    const now = performance.now();
    // Report at most every 60 ms while dragging (keeps the input log small), and the final value on release
    if (now - obDrag.last > 60) {
      obDrag.last = now;
      ctx.distCb?.(rayDistance());
    }
  });
  window.addEventListener('pointerup', () => {
    if (!obDrag) return;
    obDrag = null;
    controls.enabled = true;
    ctx.distCb?.(rayDistance());
  });
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    const b = pick(ev);
    if (!b) return;
    controls.enabled = false;
    pressed = b;
    b.position.y = b.userData.baseY - 0.4;
    if (typeof b.userData.gpio === 'number') ctx.boardBtnCb?.(b.userData.gpio, true);
    else ctx.buttonCb?.(b.name as 'BOOT' | 'RST' | 'PWR', true);
  });
  window.addEventListener('pointerup', () => {
    if (!pressed) return;
    pressed.position.y = pressed.userData.baseY;
    if (typeof pressed.userData.gpio === 'number') ctx.boardBtnCb?.(pressed.userData.gpio, false);
    else ctx.buttonCb?.(pressed.name as 'BOOT' | 'RST' | 'PWR', false);
    pressed = null;
    controls.enabled = true;
  });
  // Click (under 5 px between down and up, not an orbit drag) → onPick
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!ctx.pickCb || !downAt || consumed || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ctx.pickCb(pickAt(ev), { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
  });
  let hoverT = 0;
  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (ev.buttons) return;
    // Throttle hover: at most one raycast per 50 ms
    const now = performance.now();
    if (now - hoverT < 50) return;
    hoverT = now;
    const imu = imuRoot();
    const overImu = () => {
      if (!imu) return false;
      ray.setFromCamera(toNdc(ev), camera);
      return ray.intersectObject(imu, true).length > 0;
    };
    const c = pick(ev) ? 'pointer' : pickPot(ev) || dragging || hitEncoder(ev) ? 'ew-resize' : hitObstacle(ev) ? 'grab' : ctx.touchScreen && touchAt(ev) ? 'crosshair' : ctx.touchZones.length && touchZoneAt(ev) ? 'pointer' : overImu() ? 'grab' : ctx.pickCb && pickAt(ev) ? 'pointer' : '';
    renderer.domElement.style.cursor = c;
  });

  // ---------------------------------------------------------------- touch round LCD (P2-02) and drag IMU to tilt the bench (P2-03)
  ctx.touchCb = null;
  ctx.poseCb = null;
  /** This press was used by a key / touch / IMU drag: don't treat the release as a pick */
  let consumed = false;
  let touching: { x: number; y: number; t: number; zone?: boolean } | null = null;
  const finger = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false }));
  finger.renderOrder = 22;
  finger.visible = false;
  finger.raycast = () => {};
  scene.add(finger);
  const touchAt = (ev: { clientX: number; clientY: number }) => {
    if (!ctx.touchScreen) return null;
    ray.setFromCamera(toNdc(ev), camera);
    const h = ray.intersectObject(ctx.touchScreen, false)[0];
    if (!h?.uv) return null;
    finger.position.copy(h.point);
    finger.quaternion.copy(ctx.touchScreen.getWorldQuaternion(new THREE.Quaternion()));
    // Circle / rounded-square UV: u = 0.5 + x/w, v = 0.5 + y/h; texture is flipY, row 0 at the top
    return { x: Math.min(ctx.lcdW - 1, Math.max(0, h.uv.x * ctx.lcdW)), y: Math.min(ctx.lcdH - 1, Math.max(0, (1 - h.uv.y) * ctx.lcdH)) };
  };
  const touchZoneAt = (ev: { clientX: number; clientY: number }) => {
    if (!ctx.touchZones.length) return null;
    ray.setFromCamera(toNdc(ev), camera);
    const h = ray.intersectObjects(ctx.touchZones, false)[0];
    if (!h) return null;
    finger.position.copy(h.point);
    finger.quaternion.copy(h.object.getWorldQuaternion(new THREE.Quaternion()));
    return h.object.userData.zone as { x: number; y: number };
  };
  ctx.rotating = null;
  const imuRoot = () => partsById.get('mpu6050') ?? partsById.get('qmi8658');
  ctx.imuRoot = imuRoot;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    // BOOT / RST presses are actions, not picks: keep the selection (example card, env sliders stay); pressed was set by the earlier listener
    consumed = !!pressed || !!(ctx.encDrag && ctx.encoder?.btn !== undefined);
    const zone = touchZoneAt(ev);
    if (zone) {
      // Off-panel key: one stationary touch until release (M5Unified ignores a touch that starts moving)
      controls.enabled = false;
      consumed = true;
      touching = { x: zone.x, y: zone.y, t: performance.now(), zone: true };
      finger.visible = true;
      ctx.touchCb?.(zone.x, zone.y, true);
      return;
    }
    const tp = touchAt(ev);
    if (tp) {
      controls.enabled = false;
      consumed = true;
      touching = { ...tp, t: performance.now() };
      finger.visible = true;
      ctx.touchCb?.(tp.x, tp.y, true);
      return;
    }
    const imu = imuRoot();
    if (imu && !pickPot(ev) && !pick(ev)) {
      ray.setFromCamera(toNdc(ev), camera);
      if (ray.intersectObject(imu, true).length) {
        controls.enabled = false;
        ctx.rotating = { x: ev.clientX, y: ev.clientY, moved: false, t: 0 };
      }
    }
  });
  const qd = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  window.addEventListener('pointermove', (ev) => {
    if (touching) {
      if (touching.zone) return;
      const tp = touchAt(ev);
      const now = performance.now();
      // Report moves at ~30 Hz (real chips scan ~100 Hz; denser web events would only bloat the input log)
      if (tp && now - touching.t > 33 && (Math.abs(tp.x - touching.x) >= 1 || Math.abs(tp.y - touching.y) >= 1)) {
        touching = { ...tp, t: now };
        ctx.touchCb?.(tp.x, tp.y, true);
      }
      return;
    }
    if (!ctx.rotating) return;
    const dx = ev.clientX - ctx.rotating.x, dy = ev.clientY - ctx.rotating.y;
    if (!ctx.rotating.moved && Math.hypot(dx, dy) < 4) return;
    ctx.rotating.moved = true;
    consumed = true;
    ctx.rotating.x = ev.clientX;
    ctx.rotating.y = ev.clientY;
    // Trackball: horizontal drag = about the camera's vertical axis, vertical drag = about its horizontal axis (0.5°/px)
    const q = rig.quaternion.clone();
    axis.set(0, 1, 0).applyQuaternion(camera.quaternion);
    q.premultiply(qd.setFromAxisAngle(axis, dx * 0.5 * (Math.PI / 180)));
    axis.set(1, 0, 0).applyQuaternion(camera.quaternion);
    q.premultiply(qd.setFromAxisAngle(axis, dy * 0.5 * (Math.PI / 180)));
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    ctx.pose = threeToPose([e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]);
    applyPose();
    const now = performance.now();
    if (now - ctx.rotating.t > 33) {
      ctx.rotating.t = now;
      ctx.poseCb?.({ ...ctx.pose }, 'move');
    }
  });
  window.addEventListener('pointerup', () => {
    if (touching) {
      ctx.touchCb?.(touching.x, touching.y, false);
      touching = null;
      finger.visible = false;
      controls.enabled = true;
    }
    if (ctx.rotating) {
      if (ctx.rotating.moved) ctx.poseCb?.({ ...ctx.pose }, 'end');
      ctx.rotating = null;
      controls.enabled = true;
    }
  });
}

/** Pick targets and their projected screen positions. */
export function mountTargets(ctx: BenchCtx): void {
  const { container, camera, partsById } = ctx;
  // ---------------------------------------------------------------- highlight / faults / heat glow / ruler

  const allPins = () => [...ctx.board.pinRecs, ...ctx.modulePins];
  const pinsById = (id: string) => allPins().filter((p) => p.id === id);
  ctx.pinsById = pinsById;
  const pinWorldPos = (p: PinRec) => p.anchor.clone().applyMatrix4(p.parent.matrixWorld);
  ctx.pinWorldPos = pinWorldPos;

  const targetPos = (t: PickTarget): THREE.Vector3 | null => {
    if (t.kind === 'pin') {
      const p = pinsById(t.id)[0];
      return p ? pinWorldPos(p) : null;
    }
    if (t.kind === 'wire') {
      const w = ctx.wires.find((w) => w.id === t.id);
      return w ? w.curve.getPoint(t.anchor ? Number(t.anchor) : 0.5) : null;
    }
    if (t.kind === 'button') {
      const b = ctx.board.buttons.find((b) => b.name === t.id);
      return b ? b.getWorldPosition(new THREE.Vector3()) : null;
    }
    let o = partsById.get(t.id);
    if (!o) return null;
    if (t.id === 'board' && t.anchor === 'usb') return ctx.board.usbPort.clone().applyMatrix4(ctx.board.grp.matrixWorld);
    if (t.anchor) {
      const sub = o.getObjectByName(t.anchor);
      if (!sub) return null;
      o = sub;
    }
    // The board measures to the chip (shield can centre)
    if (t.id === 'board' && !t.anchor) return new THREE.Vector3(0, ctx.board.T / 2 + 3, ctx.board.L / 2 - ctx.board.spec.module.L / 2).applyMatrix4(ctx.board.grp.matrixWorld);
    // Other parts use the box of the visible body, excluding pick boxes, gold pins and contact shadows, so the centre isn't on the header pins
    const box = new THREE.Box3();
    o.updateMatrixWorld(true);
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || m.material === MAT.hit || m.material === MAT.gold || m.renderOrder < 0) return;
      box.union(new THREE.Box3().setFromObject(m));
    });
    return (box.isEmpty() ? new THREE.Box3().setFromObject(o) : box).getCenter(new THREE.Vector3());
  };
  ctx.targetPos = targetPos;

  const project = (t: PickTarget): ScreenPoint | null => {
    const p = targetPos(t);
    if (!p) return null;
    const v = p.project(camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { x: ((v.x + 1) / 2) * container.clientWidth, y: ((1 - v.y) / 2) * container.clientHeight };
  };
  ctx.project = project;
}
