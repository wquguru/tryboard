// Bench scene state, devboard placement, pose and setScene.

import * as THREE from 'three';
import { extModelsOn, loadExt, onExtModels, reportExt } from '../extmodels';
import { SANS, type PickTarget } from '../scene-api';
import { poseToThree } from '../imupose';
import { t } from '../i18n';
import { PITCH, type ExtSlot, disposeTree, canvasTexture, pinHits } from './util';
import { type ChipId, apiId, BOARD_C3, BOARDS, LCD_WIRING, BB, rowZ, breadboard, devboard } from './boards';
import { amoledBoard } from './amoled';
import { m5Shell, groveUnit } from './m5shell';
import { type BoardId, type M5Id, boardDevs } from './boarddevs';
import { roundLcdModule, oledModule, bmeModule, ledGlow } from './modules';
import { type WireRec, wire } from './wires';
import { type PartSpec, type SceneSpec, DEFAULT_VIEW } from './spec';
import type { BenchCtx } from './ctx';
import { AIO_CHIP } from '../chipid';
import { buildTutorialPart, isTutorialPart, resetPartLamps } from './parts3d';
import { tftModule } from './tft3d';
import { TFT_PX } from '../lcdspec.ts';

/** Scene state: rig, breadboard, external-model slots, devboard placement, pick registries and part state. */
export function* mountState(ctx: BenchCtx): Generator<void> {
  const { scene } = ctx;
  ctx.paintStrip = paintStrip;
  // Breadboard and devboard follow the chip (setBoard); add-on parts shift as a whole by partOffset
  const BB_TOP = BB.H;
  ctx.BB_TOP = BB_TOP;
  // The whole bench (breadboard + board + add-ons) hangs under rig so it tilts together when there is an IMU (P2-03).
  // rig must be identity while building: part positions are computed in world coordinates before being attached
  const rig = new THREE.Group();
  ctx.rig = rig;
  scene.add(rig);
  ctx.bbGrp = breadboard();
  rig.add(ctx.bbGrp);
  yield;
  // External models (P1-09): procedural by default; when on, lazy-load glb to replace slot parts, and swap back when off
  let extOn = extModelsOn();
  let slots: ExtSlot[] = [];
  const attached = (o: THREE.Object3D) => {
    while (o.parent) o = o.parent;
    return o === scene;
  };
  const loading = new Set<ExtSlot>();
  function applySlot(sl: ExtSlot) {
    if (!extOn || !sl.model) {
      sl.proc.forEach((p) => (p.visible = true));
      if (sl.model) sl.model.visible = false;
      sl.fit(null);
      if (extOn && sl.model === undefined && !loading.has(sl)) {
        loading.add(sl);
        void loadExt(sl.name).then((m) => {
          loading.delete(sl);
          sl.model = m;
          if (m) sl.root.add(m);
          if (attached(sl.root)) applySlot(sl);
        });
      }
      return;
    }
    sl.proc.forEach((p) => (p.visible = false));
    sl.model.visible = true;
    sl.fit(sl.model);
  }
  const useSlot = (sl: ExtSlot) => {
    slots = slots.filter((x) => attached(x.root));
    slots.push(sl);
    applySlot(sl);
  };
  ctx.useSlot = useSlot;
  const extList = () => slots.filter((x) => attached(x.root) && extOn && x.model && x.model.visible).map((x) => x.name);
  ctx.extList = extList;
  const setExt = (on: boolean) => {
    extOn = on;
    slots = slots.filter((x) => attached(x.root));
    slots.forEach(applySlot);
  };
  ctx.setExt = setExt;
  const offExt = onExtModels(setExt);
  ctx.offExt = offExt;
  const offReport = reportExt(extList);
  ctx.offReport = offReport;
  ctx.board = devboard(ctx.chip0 ? BOARDS[ctx.chip0] : BOARD_C3);
  yield;
  const placeBoard = () => {
    ctx.bbGrp.visible = !('flat' in ctx.board);
    if ('flat' in ctx.board) {
      // All-in-one board lies screen-up on the desk, USB towards the viewer
      ctx.board.grp.rotation.y = 0;
      ctx.board.grp.position.set(0, ctx.board.T / 2 + ctx.board.rest, 0); // AMOLED rests on its 3.2 mm USB-C shell, M5 shells on the desk
      rig.add(ctx.board.grp);
      ctx.board.grp.updateMatrixWorld();
      return;
    }
    // Board long side along x: rotate -90°, USB to the left; header blocks sit on the breadboard surface
    ctx.board.grp.rotation.y = -Math.PI / 2;
    ctx.board.grp.position.set((ctx.board.spec.boardCol - (ctx.board.spec.cols - 1) / 2) * PITCH, BB_TOP + 2.5 + ctx.board.T / 2, ctx.board.spec.rowSpan === 25.4 ? PITCH / 2 : 0);
    rig.add(ctx.board.grp);
    ctx.board.grp.updateMatrixWorld();
    ctx.board.extSlots.forEach(useSlot);
  };
  ctx.placeBoard = placeBoard;
  placeBoard();
  /** Breadboard column for parts (shifted per board; numbering keeps the old half-breadboard base so example cameras stay put) */
  const colX = (c: number) => (c + ctx.board.spec.partOffset - (ctx.board.spec.cols - 1) / 2) * PITCH;
  ctx.colX = colX;
  const pinWorld = (key: string) => ctx.board.pinPositions[key].clone().applyMatrix4(ctx.board.grp.matrixWorld);

  /** World position of a board pin ('IO5', '3V3', 'GND'…); all candidates, callers pick the one nearest */
  const pinCands = (name: string) => {
    const cands: { key: string; p: THREE.Vector3 }[] = [];
    ctx.board.spec.right.forEach((n, i) => n === name && cands.push({ key: 'R' + i, p: pinWorld('R' + i) }));
    ctx.board.spec.left.forEach((n, i) => n === name && cands.push({ key: 'L' + i, p: pinWorld('L' + i) }));
    if (!cands.length) throw new Error(`Board ${ctx.board.spec.title} has no pin ${name}`);
    return cands;
  };
  ctx.pinCands = pinCands;
  /** Jumpers plug into the same column as the board pin, in the outer row (a / j); for duplicate names (GND) prefer a free one */
  ctx.holeUse = new Map<string, number>();
  const boardHole = (name: string, near?: THREE.Vector3) => {
    let cands = pinCands(name);
    if (near) cands = cands.sort((a, b) => a.p.distanceTo(near) - b.p.distanceTo(near));
    const c = cands.find((c) => !ctx.holeUse.get(c.key)) ?? cands[0];
    ctx.holeUse.set(c.key, (ctx.holeUse.get(c.key) ?? 0) + 1);
    // If the pin is already in the outermost row (DevKitC V4 J1 lands on row j) there is no free hole outside: use the pin's own hole
    const z = Math.abs(c.p.z) > -rowZ(0) - 0.5 ? c.p.z : Math.sign(c.p.z) * -rowZ(0);
    return new THREE.Vector3(c.p.x, BB_TOP, z);
  };
  ctx.boardHole = boardHole;

  const lift = (v: THREE.Vector3, y: number) => new THREE.Vector3(v.x, y, v.z);
  ctx.lift = lift;
  const top = BB_TOP;
  ctx.top = top;

  // Pick registries (rebuilt on every setScene / setBoard)
  const partsById = new Map<string, THREE.Object3D>();
  ctx.partsById = partsById;
  ctx.modulePins = [];
  ctx.wires = [];
  /** Rewired wires: id → the original wire (swapped back when rewire reverts) */
  ctx.rewired = new Map<string, WireRec>();
  ctx.roles = new Map<string, string[]>();
  const addRole = (pinId: string, role: string) => {
    const r = ctx.roles.get(pinId) ?? [];
    if (!r.includes(role)) r.push(role);
    ctx.roles.set(pinId, r);
  };
  ctx.addRole = addRole;
  const addWire = (grp: THREE.Group, points: THREE.Vector3[], color: number, boardPin: string, other: string) => {
    const a = apiId(boardPin);
    let id = `wire:${a}~${other}`;
    for (let k = 2; ctx.wires.some((w) => w.id === id); k++) id = `wire:${a}~${other}#${k}`;
    const w = wire(points, color, id, [a, other]);
    grp.add(w.grp);
    ctx.wires.push(w);
    return w;
  };
  ctx.addWire = addWire;
  /** Jumper from a board pin to a breadboard hole, arched in the middle. arc is measured from the breadboard surface: plugs are 11 mm tall,
   *  and an absolute arch height would graze the tops of other plugs */
  const jumper = (grp: THREE.Group, pin: string, to: THREE.Vector3, color: number, other: string, arc = 26, bow = 6) => {
    const a = boardHole(pin, to);
    const b = lift(to, top);
    const h = top + arc;
    addWire(grp, [a, lift(a, h - 4), new THREE.Vector3((a.x + b.x) / 2, h, (a.z + b.z) / 2 + bow), lift(b, h - 6), b], color, pin, other);
  };
  ctx.jumper = jumper;
  const registerPart = (id: string, o: THREE.Object3D) => {
    o.userData.pick = { kind: 'part', id } satisfies PickTarget;
    partsById.set(id, o);
  };
  ctx.registerPart = registerPart;
  const registerModulePins = (partId: string, root: THREE.Group, pins: THREE.Vector3[], labels: string[]) => {
    const recs = labels.map((l, i) => ({ id: `${partId}:${l}`, label: l, anchor: pins[i].clone(), parent: root }));
    // Pick boxes cover only the header plastic and the very bottom of the PCB; taller ones would cover the module and steal clicks
    pinHits(root, recs, pins.map((p) => new THREE.Vector3(p.x, 2, p.z)), [2.3, 4, 2.8], ctx.modulePins);
  };
  ctx.registerModulePins = registerModulePins;

  // Callouts (part notes, light pills)
  const tl = (s?: string) => (s === undefined ? undefined : t(s));
  ctx.tl = tl;
  const label = (grp: THREE.Group, text: string, pos: THREE.Vector3) => {
    const font = `500 38px ${SANS}`;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = font;
    const w = Math.ceil(probe.measureText(text).width) + 64;
    const tex = canvasTexture(w, 128, (g) => {
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.strokeStyle = '#E6E6E6';
      g.lineWidth = 3;
      g.beginPath();
      g.roundRect(4, 4, w - 8, 120, 28);
      g.fill();
      g.stroke();
      g.fillStyle = '#1E1E1E';
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, 66);
    });
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    s.scale.set((5 * w) / 128, 5, 1);
    s.position.copy(pos);
    s.renderOrder = 10;
    s.raycast = () => {};
    grp.add(s);
  };
  ctx.label = label;

  ctx.leds = [];
  ctx.servos = [];
  ctx.pots = [];
  ctx.buzzers = [];
  ctx.keys = [];
  ctx.speakers = [];
  ctx.mics = [];
  /** Current speaker volume (RMS, full scale = 1) and mic input level: cone motion, sound waves / pickup ring */
  ctx.spkLevel = 0;
  ctx.micLevel = 0;
  ctx.potCb = null;
  // Encoder knob (shown position = core position + detents dragged but not yet applied), ultrasonic transducer + obstacle
  ctx.encoder = null;
  ctx.strips = [];
  /** Last strip frame (only sent when new, so a rebuilt scene relights from it) */
  const stripLast = new Map<number, number[][]>();
  ctx.stripLast = stripLast;
  function paintStrip(st: (typeof ctx.strips)[number], leds: number[][]) {
    let sum = [0, 0, 0];
    let peak = 0;
    st.lenses.forEach((mat, i) => {
      const c = leds[i] ?? [0, 0, 0];
      peak = Math.max(peak, ledGlow(mat, c).peak);
      sum = sum.map((v, k) => v + c[k]);
    });
    const m = Math.max(...sum);
    st.light.color.setRGB(m ? sum[0] / m : 0, m ? sum[1] / m : 0, m ? sum[2] / m : 0);
    st.light.intensity = peak * 120;
  }
  ctx.encCb = null;
  ctx.encSwCb = null;
  ctx.sonar = null;
  ctx.distCb = null;
  ctx.parts = new THREE.Group();
  rig.add(ctx.parts);
  /** Touch LCD screen mesh (a ray hitting it = finger on the screen) */
  ctx.touchScreen = null;
  ctx.touchZones = [];
  const oledData = new Uint8Array(128 * 64 * 4);
  ctx.oledData = oledData;
  ctx.oledTex = null;
  ctx.lcdData = new Uint8Array(240 * 240 * 4);
  ctx.lcdTex = null;
  ctx.lcdW = ctx.lcdH = 240;
  ctx.touchHalf = [16.25, 16.25];
}

/** Pose, board switching, camera fit and setScene. */
export function mountScene(ctx: BenchCtx): void {
  const {
    camera, controls, setTag, BB_TOP, rig, placeBoard, colX, partsById, addRole, tl, label, oledData, buildLed, buildSpiLcd, buildImu,
    buildI2c, buildServo, buildPot, buildKey, buildBuzzer, buildEncoder, buildStrip, buildDht, buildSonar, buildAmp, buildMic,
  } = ctx;
  ctx.applyPose = applyPose;
  ctx.setBoard = setBoard;
  ctx.fitView = fitView;
  ctx.setScene = setScene;
  ctx.buildScene = buildScene;
  ctx.lastScene = { parts: [] };

  // ---------------------------------------------------------------- bench pose (P2-03)
  ctx.pose = { pitch: 0, roll: 0, yaw: 0 };
  /** Rotation centre: the IMU module (so it stays put while dragged); breadboard centre without an IMU */
  const pivot = new THREE.Vector3(0, BB_TOP, 0);
  /** Level the bench before building (part positions are computed in world coordinates) */
  function levelRig() {
    rig.position.set(0, 0, 0);
    rig.quaternion.identity();
    rig.updateMatrixWorld(true);
  }
  const m4 = new THREE.Matrix4();
  /** Rotate the bench by pose about pivot (the IMU module), like tilting the breadboard in your hands */
  function applyPose() {
    levelRig();
    const imu = partsById.get('mpu6050') ?? partsById.get('qmi8658');
    if (imu) imu.getWorldPosition(pivot);
    else pivot.set(0, BB_TOP, 0);
    const flat = !ctx.pose.pitch && !ctx.pose.roll && !ctx.pose.yaw;
    if (!flat) {
      const r = poseToThree(ctx.pose);
      m4.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
      rig.quaternion.setFromRotationMatrix(m4);
      // No lift: the ground is only a transparent shadow catcher, so a corner sinking below it stays visible; the IMU stays in view while dragged
      rig.position.copy(pivot).sub(pivot.clone().applyQuaternion(rig.quaternion));
      rig.updateMatrixWorld(true);
    }
    ctx.highlight(ctx.hl);
    ctx.setHeat(ctx.heatId);
    if (ctx.measured) ctx.measure(ctx.measured[0], ctx.measured[1]);
  }

  /** Switch board (ESP32 / C3 / S3): rebuild the board and rewire add-on parts to the new board's pins */
  function setBoard(chip: ChipId) {
    if (swapBoard(chip, ctx.lastScene?.board)) setScene(ctx.lastScene);
  }

  /** Rebuild the board when the chip or the all-in-one board id (E-03, fixes the chip) changes; true if it did */
  function swapBoard(chip: ChipId, board: BoardId | undefined) {
    const cur = 'boardId' in ctx.board ? ctx.board.boardId : undefined;
    if (board) chip = AIO_CHIP[board];
    // M5 presets get their procedural enclosure (M5-09c)
    const id = board && boardDevs(board) ? board : undefined;
    if (cur === id && ctx.board.spec.chip === chip) return false;
    levelRig();
    rig.remove(ctx.board.grp);
    disposeTree(ctx.board.grp);
    ctx.board = !id ? devboard(BOARDS[chip]) : id === 'ws-amoled216' ? amoledBoard(id) : m5Shell(id);
    placeBoard();
    return true;
  }

  /** Fresh DataTexture for a w×h screen (row 0 at the top), black with opaque alpha */
  function lcdTexture(w: number, h: number) {
    if (ctx.lcdData.length !== w * h * 4) ctx.lcdData = new Uint8Array(w * h * 4);
    const d = ctx.lcdData;
    d.fill(0);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    ctx.lcdW = w;
    ctx.lcdH = h;
    const tex = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
    tex.flipY = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    ctx.lcdTex = tex;
    return tex;
  }

  // Without a set camera, frame the board + parts bounding box: at real size S3 plus a servo is twice as wide as C3, a fixed camera would crop.
  // Wires arch high, so cap the box at 40 mm to avoid shrinking parts just to fit wire tops
  function fitView(v: Required<SceneSpec>['view']) {
    const box = new THREE.Box3().setFromObject(ctx.board.grp);
    for (const c of ctx.parts.children) if (!ctx.wires.some((w) => w.grp === c)) box.expandByObject(c);
    box.max.y = Math.min(box.max.y, 40);
    const center = box.getCenter(new THREE.Vector3());
    // A lone M5 shell gets head room (floor 40 mm, ×1.4) so a 24 mm Atom doesn't fill the view and the toolbar doesn't cover it
    const shell = 'flat' in ctx.board && !!boardDevs(ctx.board.boardId)?.preset;
    const r0 = box.getSize(new THREE.Vector3()).length() / 2;
    const r = shell ? Math.max(40, r0 * 1.4) : r0;
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(camera.aspect, 0.5));
    const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 0.82;
    const dir = new THREE.Vector3(...v.position).sub(new THREE.Vector3(...v.target)).normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
  }

  function setScene(spec: SceneSpec) {
    const g = buildScene(spec);
    while (!g.next().done);
  }

  function* buildScene(spec: SceneSpec): Generator<void> {
    ctx.lastScene = spec;
    levelRig();
    rig.remove(ctx.parts);
    disposeTree(ctx.parts);
    ctx.parts = new THREE.Group();
    rig.add(ctx.parts);
    ctx.touchScreen = null;
    ctx.touchZones = [];
    ctx.leds = [];
    resetPartLamps();
    ctx.servos = [];
    ctx.pots = [];
    ctx.buzzers = [];
    ctx.keys = [];
    ctx.encoder = null;
    ctx.strips = [];
    ctx.sonar = null;
    ctx.speakers = [];
    ctx.mics = [];
    ctx.oledTex = null;
    ctx.lcdTex = null;
    swapBoard(ctx.board.spec.chip, spec.board);
    // Grove ENV unit on the shell's Port A (G-14): redrawn on every scene so clearing spec.grove removes it
    const oldUnit = ctx.board.grp.getObjectByName('grove-unit');
    if (oldUnit) {
      ctx.board.grp.remove(oldUnit);
      disposeTree(oldUnit);
    }
    if (spec.grove && spec.board && 'flat' in ctx.board && spec.board !== 'ws-amoled216' && spec.board !== 'cyd') {
      const unit = groveUnit(spec.board as M5Id, spec.grove);
      if (unit) ctx.board.grp.add(unit);
    }
    if ('flat' in ctx.board && ctx.board.screen && ctx.board.lcdPx) {
      // On-board panel: frame-sized texture (must equal tb_lcd_w / h or setLcd drops frames); touch panels take the finger ray
      const mat = ctx.board.screen.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.map = lcdTexture(...ctx.board.lcdPx);
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
      if (ctx.board.touch) {
        ctx.touchScreen = ctx.board.screen;
        ctx.touchHalf = [ctx.board.screenMm[0] / 2, ctx.board.screenMm[1] / 2];
        ctx.touchZones = ctx.board.zones;
      }
    }
    if ('flat' in ctx.board && ctx.board.encoder) {
      const enc = ctx.board.encoder;
      ctx.encoder = { knob: enc.knob, hit: enc.hit, pos: 0, pushed: false, y0: enc.y0, btn: enc.btn, grab: enc.grab, occl: ctx.board.grp };
    }
    if ('flat' in ctx.board) ctx.leds.push(...ctx.board.gpioLeds);
    ctx.holeUse = new Map();
    partsById.clear();
    partsById.set('board', ctx.board.grp);
    ctx.modulePins = [];
    ctx.wires = [];
    ctx.rewired = new Map();
    ctx.roles = new Map();
    if (ctx.board.spec.rgbPin >= 0) addRole(apiId('IO' + ctx.board.spec.rgbPin), t('Onboard WS2812 LED'));
    addRole(apiId('IO' + ctx.board.spec.bootPin), t('BOOT button'));
    // Several parts of one kind line up leftward so they don't stack in one column
    let ledN = 0;
    let keyN = 0;
    let i2cCol = 21;
    // All-in-one / M5 boards have no header to wire breadboard parts to: they stay in the sim but aren't drawn (Grove units: M5-09d)
    for (const p of 'flat' in ctx.board ? [] : spec.parts) {
      if (p.type === 'led') buildLed(ctx.parts, { ...p, col: p.col ?? 24 - 4 * ledN++ });
      if (p.type === 'servo') buildServo(ctx.parts, p);
      if (p.type === 'pot') buildPot(ctx.parts, p);
      if (p.type === 'buzzer') buildBuzzer(ctx.parts, p);
      // Keys go right of the board (it reaches about column 22), one per 5 columns so 9 mm caps don't crowd
      if (p.type === 'key') buildKey(ctx.parts, p, 26 + 5 * keyN++);
      if (p.type === 'encoder') buildEncoder(ctx.parts, p);
      if (p.type === 'ws2812') buildStrip(ctx.parts, p);
      if (p.type === 'hcsr04') buildSonar(ctx.parts, p);
      if (p.type === 'dht11') buildDht(ctx.parts, p);
      if (isTutorialPart(p)) buildTutorialPart(ctx, ctx.parts, p);
      if (p.type === 'max98357a') buildAmp(ctx.parts, p);
      if (p.type === 'inmp441') buildMic(ctx.parts, p);
      if (p.type === 'oled') {
        oledData.fill(0);
        for (let i = 3; i < oledData.length; i += 4) oledData[i] = 255;
        ctx.oledTex = new THREE.DataTexture(oledData, 128, 64, THREE.RGBAFormat);
        ctx.oledTex.magFilter = THREE.NearestFilter;
        ctx.oledTex.minFilter = THREE.LinearFilter;
        ctx.oledTex.colorSpace = THREE.SRGBColorSpace;
        ctx.oledTex.needsUpdate = true;
        buildI2c(ctx.parts, 'oled', 'OLED', oledModule(ctx.oledTex), i2cCol, p.sda, p.scl, 40);
        label(ctx.parts, tl(p.label) ?? `${p.ctl === 'sh1106' ? 'SH1106' : 'SSD1306'} · I2C 0x${p.addr.toString(16).toUpperCase()} · SDA IO${p.sda} SCL IO${p.scl}`, new THREE.Vector3(colX(i2cCol + 1.5), 46, rowZ(0) - 10));
        i2cCol -= 9;
      }
      if (p.type === 'gc9a01') {
        lcdTexture(240, 240);
        ctx.touchHalf = [16.25, 16.25];
        const tp = spec.parts.find((x): x is Extract<PartSpec, { type: 'cst816s' }> => x.type === 'cst816s');
        const lm = roundLcdModule(ctx.lcdTex!, !!tp);
        if (tp) ctx.touchScreen = lm.screen;
        buildSpiLcd(ctx.parts, lm, 16, tp);
        const w = LCD_WIRING[ctx.board.spec.chip];
        label(ctx.parts, tl(p.label) ?? t('GC9A01 round LCD · SPI2 · SCLK IO{sclk} MOSI IO{mosi} CS IO{cs} DC IO{dc}', { sclk: w.sclk, mosi: w.mosi, cs: w.cs, dc: w.dc }), new THREE.Vector3(colX(19.5), 52, rowZ(0) - 10));
      }
      if (p.type === 'tft') {
        const [w, h] = TFT_PX[p.panel];
        lcdTexture(w, h);
        const tm = tftModule(ctx.lcdTex!, p.panel);
        ctx.buildSpiTft(ctx.parts, tm, 16, p);
        const ctl = p.panel === 'ili9341' ? 'ILI9341' : 'ST7789';
        label(ctx.parts, tl(p.label) ?? t('{ctl} {w}×{h} TFT · SPI2 · SCLK IO{sclk} MOSI IO{mosi} CS IO{cs} DC IO{dc}', { ctl, w, h, sclk: p.sclk, mosi: p.mosi, cs: p.cs, dc: p.dc }), new THREE.Vector3(colX(20), tm.height + 12, rowZ(0) - 10));
      }
      if (p.type === 'mpu6050' || p.type === 'qmi8658') {
        // Sharing the bench with the round LCD (motion figure): the LCD takes column 16 onward, so the IMU moves right of it or it's hidden and undraggable
        const col = spec.parts.some((x) => x.type === 'gc9a01' || x.type === 'tft') ? 27 : i2cCol - 4;
        buildImu(ctx.parts, p, col);
        const imuText = t('{part} · I2C 0x{addr} · SDA IO{sda} SCL IO{scl} · drag to tilt the bench', { part: p.type === 'mpu6050' ? 'MPU6050' : 'QMI8658', addr: p.addr.toString(16), sda: p.sda, scl: p.scl });
        label(ctx.parts, tl(p.label) ?? imuText, new THREE.Vector3(colX(col + 3.5), 30, rowZ(0) - 10));
        i2cCol -= 10;
      }
      if (p.type === 'bme280') {
        buildI2c(ctx.parts, 'bme280', 'BME280', bmeModule(), i2cCol, p.sda, p.scl, 22);
        label(ctx.parts, tl(p.label) ?? `BME280 · I2C 0x${p.addr.toString(16)} · SDA IO${p.sda} SCL IO${p.scl}`, new THREE.Vector3(colX(i2cCol + 1.5), 34, rowZ(0) - 8));
        i2cCol -= 9;
      }
      yield;
    }
    ctx.parts.updateMatrixWorld(true);
    // An example may set the camera (e.g. close up on a screen), otherwise use the default. Cameras are written for the C3 board
    // and shift with the parts on longer boards
    const v = spec.view ?? DEFAULT_VIEW;
    // M5 shells always frame themselves: an example's camera was written for the breadboard it came with
    if (spec.view && !('flat' in ctx.board && boardDevs(ctx.board.boardId)?.preset)) {
      const dx = colX(0) + ((BOARD_C3.cols - 1) / 2) * PITCH;
      camera.position.set(v.position[0] + dx, v.position[1], v.position[2]);
      controls.target.set(v.target[0] + dx, v.target[1], v.target[2]);
    } else {
      fitView(v);
    }
    controls.update();
    // After rebuild, restore fault tags set by the shell (kept while their target still exists)
    for (const [id, msg] of ctx.faults) if (ctx.wires.some((w) => w.id === id)) ctx.applyFault(id, msg);
    else setTag('fault:' + id, null, '', () => null);
    applyPose();
    ctx.sw.warm();
  }
}
