import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinnedModel } from 'three/addons/utils/SkeletonUtils.js';

const TRACK_WIDTH = 10;
const LANE_WIDTH = 2.2;
const LANE_OFFSET = 1.5;
const SEGMENT_LENGTH = 20;
const SEGMENT_COUNT = 4;
const RUN_SPEED = 10;
const CHARACTER_SCALE = 4;

const HURDLE_WIDTH = 2.4;
const HURDLE_HEIGHT = 0.6;
const HURDLE_BOARD_HEIGHT = 0.16;
const JUMP_LIFT = 0.25;
const MAX_HURDLE_POOL = 6;
const HURDLE_SPACING = 40;
const HURDLE_HIT_DEPTH = 0.35;
const JUMP_ACTION_DISTANCE = 4.5;
const LANE_SWITCH_ACTION_DISTANCE = 3.5;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 15, 50);

const roadMaterial = new THREE.MeshStandardMaterial({
  color: 0x8d8d8d,
  roughness: 1,
})

const groundTexture = createGroundTexture();
const groundMaterial = new THREE.MeshStandardMaterial({
  map: groundTexture,
  roughness: 1,
});

const hurdleMetalMaterial = new THREE.MeshStandardMaterial({
  color: 0xf4f4f5,
  metalness: 0.62,
  roughness: 0.32,
});
const hurdleBoardMaterial = new THREE.MeshStandardMaterial({
  map: createHurdleBoardTexture(),
  roughness: 0.58,
  metalness: 0.04,
});
const laneArrowMaterial = new THREE.MeshBasicMaterial({
  map: createLaneArrowTexture(),
  transparent: true,
  depthWrite: false,
});
const hurdleFootGeometry = new THREE.BoxGeometry(0.16, 0.05, 0.62);
const hurdlePostGeometry = new THREE.BoxGeometry(0.05, HURDLE_HEIGHT, 0.05);
const hurdleRailGeometry = new THREE.BoxGeometry(HURDLE_WIDTH - 0.12, 0.03, 0.03);
const hurdleBoardGeometry = new THREE.BoxGeometry(HURDLE_WIDTH, HURDLE_BOARD_HEIGHT, 0.04);

const groundSegments = [];

// Initialize ground path
for (let i = 0; i < SEGMENT_COUNT; i++) {
  const segment = createGroundSegment();
  // Forward for the runner is -z
  segment.position.z = -i * SEGMENT_LENGTH;
  scene.add(segment);
  // Segments are stored for cycling
  groundSegments.push(segment);
}

const hurdles = [];

const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
let activeRenderer = null;
let activeGameOptions = {};
let lastCueUpdate = 0;
let completeUntil = 0;
let lastObstacleResult = null;
let lastObstacleTarget = 'Jump';
let lastEncounterId = '';
let lastExpectedAction = 'jump';
let pendingGestureAction = null;
const DEFAULT_OBSTACLE_COUNT = 20;
const DEFAULT_STARTING_LIVES = 3;
let obstacleLimit = DEFAULT_OBSTACLE_COUNT;
let startingLives = DEFAULT_STARTING_LIVES;
let obstaclesSpawned = 0;
let obstaclesResolved = 0;
let lastObstacleIndex = 1;
let lives = startingLives;
let runOver = false;
const previousHurdleZ = new WeakMap();

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
hemiLight.position.set(0, 20, 0);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(3, 10, 5);
scene.add(dirLight);

// Camera framing for a forefront runner
camera.position.set(0, 2, 3);
camera.lookAt(0, 2, 0);

let mixer = null;
let runAction = null;
let jumpAction = null;
let slideAction = null;
// prevents jumping while mid-jump
let isJumping = false;

const clock = new THREE.Clock()
const loader = new GLTFLoader();

let characterModel = null;
let loadId = 0;
let auburnGltf = null;
let defenderRunClip = null;
const defenderMixers = [];
const pendingDefenderGates = [];

let characterRoot = null;
let laneIndex = 0;
let isSwitching = false;
let switchFrom = -LANE_OFFSET;
let switchTo = -LANE_OFFSET;
let switchElapsed = 0;

const LANE_SWITCH_TIME = 0.3;

loader.load(
  '/models/Auburn_Player.glb',
  (gltf) => {
    auburnGltf = gltf;
    attachPendingDefenders();
  },
  undefined,
  (error) => {
    console.error('Failed to load Auburn player:', error);
  }
);

loader.load(
  '/models/Football_Player.glb',
  (gltf) => {
    const model = gltf.scene;
    model.position.set(0, 0, 0);
    model.rotation.y = Math.PI;
    model.scale.setScalar(CHARACTER_SCALE);

    const root = new THREE.Group();
    root.position.set(-LANE_OFFSET, 0, 0);
    root.add(model);
    scene.add(root);
    characterRoot = root;
    characterModel = model;

    // Animation
    mixer = new THREE.AnimationMixer(model);

    const runClip =
      THREE.AnimationClip.findByName(gltf.animations, 'Running') || gltf.animations[0];

    runAction = mixer.clipAction(runClip);
    runAction.play();

    mixer.addEventListener('finished', (event) => {
      if (event.action == jumpAction) {
        isJumping = false;
        jumpAction.fadeOut(0.15);
        runAction.reset().fadeIn(0.15).play();
      }
    });

    loader.load(
      '/models/Jump.glb',
      (jumpGltf) => {
        const jumpClip =
          THREE.AnimationClip.findByName(jumpGltf.animations, 'Running Jump') || jumpGltf.animations[0];

        lockRootXZ(jumpClip)

        jumpAction = mixer.clipAction(jumpClip);
        jumpAction.setLoop(THREE.LoopOnce, 1);
        jumpAction.clampWhenFinished = true;
      },
      undefined,
      (error) => {
        console.error('Failed to load jump:', error);
      }
    );
  },
  undefined,
  (error) => {
    console.error('Failed to load model:', error);
  }
);

export function mountGame(container, options = {}) {
  const resizeRenderer = () => {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    activeRenderer?.setSize(width, height);
  };

  activeGameOptions = options;
  obstacleLimit = wholeNumber(options.obstacleCount, DEFAULT_OBSTACLE_COUNT, 1, 200);
  startingLives = wholeNumber(options.startingLives, DEFAULT_STARTING_LIVES, 1, 10);
  resetGame();
  activeGameOptions.onLivesChange?.(lives, startingLives);

  const renderer = new THREE.WebGLRenderer();
  renderer.domElement.style.display = 'block';
  activeRenderer = renderer;
  container.appendChild(renderer.domElement);
  resizeRenderer();
  renderer.setAnimationLoop(animate);
  clock.getDelta();

  const onKeyDown = (event) => {
    if (event.repeat) return;
    if (event.code == 'ArrowUp') startJump();
    if (event.code == 'ArrowLeft') startLaneSwitch(-1);
    if (event.code == 'ArrowRight') startLaneSwitch(1);
  };
  window.addEventListener('keydown', onKeyDown);

  const resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(container);

  return () => {
    renderer.setAnimationLoop(null);
    window.removeEventListener('keydown', onKeyDown);
    resizeObserver.disconnect();
    renderer.domElement.remove();
    renderer.dispose();
    if (activeRenderer === renderer) activeRenderer = null;
    if (activeGameOptions === options) activeGameOptions = {};
  };
}

// Removes horizontal movement from jump animations.
function lockRootXZ(clip) {
  for (const track of clip.tracks) {
    if (!track.name.endsWith('Hips.position')) continue;

    const values = track.values;
    const baseX = values[0];
    const baseY = values[1];

    for (let i = 0; i < values.length; i += 3) {
      values[i] = baseX;
      values[i + 1] = baseY;
    }
  }
}

export function startJump() {
  if (isJumping || isSwitching || !jumpAction || !runAction) return;

  isJumping = true;
  jumpAction.reset();
  jumpAction.crossFadeFrom(runAction, 0.1, false);
  jumpAction.play()
}

export function startLaneSwitch(direction) {
  if (isSwitching || isJumping || !characterRoot) return;

  const next = laneIndex + direction;
  if (next < 0 || next > 1) return;

  laneIndex = next;
  switchFrom = characterRoot.position.x;
  switchTo = next === 0 ? -LANE_OFFSET : LANE_OFFSET;
  switchElapsed = 0;
  isSwitching = true;
}

export function queueGestureAction(action, direction, encounterId) {
  pendingGestureAction = { action, direction, encounterId };
}

function createHurdleBoardTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(0, 0, 42, canvas.height);
  ctx.fillRect(canvas.width - 42, 0, 42, canvas.height);
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(0, 0, canvas.width, 5);
  ctx.fillRect(0, canvas.height - 5, canvas.width, 5);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createLaneArrowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#67e8f9';
  ctx.fillRect(48, 78, 32, 150);
  ctx.beginPath();
  ctx.moveTo(64, 18);
  ctx.lineTo(114, 96);
  ctx.lineTo(14, 96);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createGroundTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#4a7c3a';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#3d6b32';
  ctx.fillRect(0, 0, size, size/2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 4);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createGroundSegment() {
  const segment = new THREE.Group();

  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(TRACK_WIDTH, SEGMENT_LENGTH),
    groundMaterial,
  );
  grass.rotation.x = -Math.PI/2
  segment.add(grass);

  for (const x of [-LANE_OFFSET, LANE_OFFSET]) {
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(LANE_WIDTH, SEGMENT_LENGTH),
      roadMaterial,
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(x, 0.02, 0);
    segment.add(road);
  }

  return segment;
}

function addLaneHurdle(group, centerX) {
  const postX = HURDLE_WIDTH / 2 - 0.08;

  for (const side of [-1, 1]) {
    const foot = new THREE.Mesh(hurdleFootGeometry, hurdleMetalMaterial);
    foot.position.set(centerX + side * postX, 0.03, 0.2);

    const post = new THREE.Mesh(hurdlePostGeometry, hurdleMetalMaterial);
    post.position.set(centerX + side * postX, HURDLE_HEIGHT / 2, 0);
    group.add(foot, post);
  }

  const rail = new THREE.Mesh(hurdleRailGeometry, hurdleMetalMaterial);
  rail.position.set(centerX, HURDLE_HEIGHT * 0.42, 0);

  const board = new THREE.Mesh(hurdleBoardGeometry, hurdleBoardMaterial);
  board.position.set(centerX, HURDLE_HEIGHT + HURDLE_BOARD_HEIGHT / 2, 0);
  group.add(rail, board);
}

function createHurdle() {
  const group = new THREE.Group();
  addLaneHurdle(group, -LANE_OFFSET);
  addLaneHurdle(group, LANE_OFFSET);
  return group;
}

function laneX(lane) {
  return lane === 0 ? -LANE_OFFSET : LANE_OFFSET;
}

function createLaneGate(openLane) {
  const group = new THREE.Group();
  const defender = new THREE.Group();
  const stripe = new THREE.Mesh(
    new THREE.PlaneGeometry(LANE_WIDTH * 0.72, 3.4),
    laneArrowMaterial,
  );
  stripe.rotation.x = -Math.PI / 2;
  stripe.renderOrder = 1;
  group.add(defender, stripe);
  group.userData.parts = { defender, stripe };
  group.userData.defenderMixer = null;
  placeLaneGate(group, openLane);

  if (auburnGltf) attachDefender(group);
  else pendingDefenderGates.push(group);

  return group;
}

function sourceRunClip(gltf) {
  return THREE.AnimationClip.findByName(gltf.animations, 'Running') || gltf.animations[0];
}

function attachDefender(group) {
  if (!auburnGltf || group.userData.defenderMixer) return;
  const clip = sourceRunClip(auburnGltf);
  if (!clip) return;
  if (!defenderRunClip) {
    defenderRunClip = clip.clone();
    lockRootXZ(defenderRunClip);
  }

  const model = cloneSkinnedModel(auburnGltf.scene);
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.setScalar(CHARACTER_SCALE);
  group.userData.parts.defender.add(model);

  const defenderMixer = new THREE.AnimationMixer(model);
  const action = defenderMixer.clipAction(defenderRunClip);
  action.play();
  action.time = Math.random() * defenderRunClip.duration;
  group.userData.defenderMixer = defenderMixer;
  defenderMixers.push(defenderMixer);
}

function attachPendingDefenders() {
  for (const group of pendingDefenderGates) attachDefender(group);
  pendingDefenderGates.length = 0;
}

// Moves the oncoming player onto the closed lane and the arrow onto the open one.
function placeLaneGate(group, openLane) {
  const closedX = laneX(openLane === 0 ? 1 : 0);
  const openX = laneX(openLane);
  const { defender, stripe } = group.userData.parts;
  defender.position.set(closedX, 0, 0);
  stripe.position.set(openX, 0.045, 0);
  group.userData.openLane = openLane;
}

// Nearest unresolved oncoming player first. Passed and already-hit gates are left alone.
function upcomingLaneGates() {
  return hurdles
    .filter((hurdle) => (
      hurdle.userData.active
      && hurdle.userData.obstacleType === 'switch'
      && !hurdle.userData.resolved
      && hurdle.position.z < 0
    ))
    .sort((left, right) => right.position.z - left.position.z);
}

function wholeNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function createObstacle(index) {
  const isLaneGate = index % 2 === 1;
  const openLane = Math.floor(index / 2) % 2 === 0 ? 1 : 0;
  const hurdle = isLaneGate ? createLaneGate(openLane) : createHurdle();
  hurdle.userData.obstacleType = isLaneGate ? 'switch' : 'jump';
  hurdle.userData.openLane = isLaneGate ? openLane : null;
  hurdle.userData.obstacleId = index;
  hurdle.userData.resolved = false;
  hurdle.userData.encounter = 0;
  hurdle.userData.spawnIndex = index;
  hurdle.userData.active = false;
  scene.add(hurdle);
  return hurdle;
}

function ensureObstacle(index) {
  if (!hurdles[index]) hurdles[index] = createObstacle(index);
  return hurdles[index];
}

function farthestActiveZ(except) {
  let farthest = -HURDLE_SPACING;
  let found = false;
  for (const hurdle of hurdles) {
    if (!hurdle.userData.active || hurdle === except) continue;
    if (!found || hurdle.position.z < farthest) {
      farthest = hurdle.position.z;
      found = true;
    }
  }
  return farthest;
}

function retireHurdle(hurdle) {
  hurdle.userData.active = false;
  hurdle.visible = false;
  hurdle.position.z = SEGMENT_LENGTH + HURDLE_SPACING;
  previousHurdleZ.delete(hurdle);
}

function resolveObstacle(hurdle, correct) {
  const isLaneGate = hurdle.userData.obstacleType === 'switch';
  hurdle.userData.resolved = true;
  obstaclesResolved += 1;
  lastObstacleIndex = (hurdle.userData.spawnIndex ?? 0) + 1;
  completeUntil = performance.now() + 700;
  lastObstacleResult = correct;
  lastObstacleTarget = isLaneGate ? 'Switch Lane' : 'Jump';
  lastExpectedAction = isLaneGate ? 'switch-lane' : 'jump';
  lastEncounterId = `${hurdle.userData.obstacleId}:${hurdle.userData.encounter}`;
  if (!correct) {
    lives = Math.max(0, lives - 1);
    activeGameOptions.onLivesChange?.(lives, startingLives);
    if (isLaneGate) retargetUpcomingGates(laneIndex);
  }
  activeGameOptions.onObstacleResult?.({
    correct,
    encounterId: lastEncounterId,
    expectedAction: lastExpectedAction,
  });
  if (lives === 0) {
    runOver = true;
    activeGameOptions.onGameOver?.();
    return true;
  }
  if (obstaclesResolved >= obstacleLimit) {
    runOver = true;
    activeGameOptions.onRunComplete?.();
    return true;
  }
  return false;
}

// Rebuild the walls still ahead so each one requires a switch action
function retargetUpcomingGates(blockedLane) {
  let laneToBlock = blockedLane;
  for (const gate of upcomingLaneGates()) {
    const openLane = laneToBlock === 0 ? 1 : 0;
    placeLaneGate(gate, openLane);
    laneToBlock = openLane;
  }
}

// A wall that wraps behind the camera becomes the farthest obstacle. Continue
// the lane pattern from the wall in front of it instead of restoring its old side.
function continueGateSequence(hurdle) {
  const gates = upcomingLaneGates();
  const previous = gates[gates.indexOf(hurdle) - 1];
  const blockedLane = previous ? previous.userData.openLane : laneIndex;
  placeLaneGate(hurdle, blockedLane === 0 ? 1 : 0);
}

function resetGame() {
  pendingGestureAction = null;
  lives = startingLives;
  runOver = false;
  obstaclesResolved = 0;
  lastObstacleIndex = 1;
  laneIndex = 0;
  isSwitching = false;
  if (characterRoot) {
    characterRoot.position.set(-LANE_OFFSET, 0, 0);
    characterRoot.rotation.set(0, 0, 0);
  }

  isJumping = false;

  if (jumpAction) {
    jumpAction.stop();
    jumpAction.reset();
  }
  if (runAction) {
    runAction.reset().fadeIn(0.1).play();
  }

  for (let i = 0; i < groundSegments.length; i++) {
    groundSegments[i].position.z = -i * SEGMENT_LENGTH;
  }

  const poolSize = Math.min(obstacleLimit, MAX_HURDLE_POOL);
  obstaclesSpawned = poolSize;
  for (let i = 0; i < Math.max(hurdles.length, poolSize); i += 1) {
    if (i >= poolSize) {
      if (hurdles[i]) retireHurdle(hurdles[i]);
      continue;
    }
    const hurdle = ensureObstacle(i);
    hurdle.visible = true;
    hurdle.userData.active = true;
    hurdle.userData.resolved = false;
    hurdle.userData.spawnIndex = i;
    hurdle.userData.encounter = 0;
    hurdle.position.z = -(i + 1) * HURDLE_SPACING;
    previousHurdleZ.set(hurdle, hurdle.position.z);
  }
  retargetUpcomingGates(laneIndex);
}

function animate() {
  const delta = clock.getDelta();
  if (runOver) {
    activeRenderer?.render(scene, camera);
    return;
  }
  if (mixer) mixer.update(delta);
  for (const defenderMixer of defenderMixers) defenderMixer.update(delta);

  // Ease lane switch animation
  if (isSwitching && characterRoot) {
    switchElapsed += delta;
    const t = Math.min(switchElapsed / LANE_SWITCH_TIME, 1);
    const eased = t * t * (3-2 * t);
   
    characterRoot.position.x = switchFrom + (switchTo - switchFrom) * eased;
    characterRoot.position.y = Math.sin(t * Math.PI) * 0.15;

    const direction = Math.sign(switchTo - switchFrom);
    const lean = Math.sin(t * Math.PI);

    characterRoot.rotation.z = -direction * lean * 0.35;
    characterRoot.rotation.y = direction * lean * 0.2;

    if (t === 1) {
      isSwitching = false;
      characterRoot.position.set(switchTo, 0, 0);
    }
  }

  if (isJumping && characterRoot && jumpAction) {
    const duration = jumpAction.getClip().duration || 1;
    const jumpTime = Math.min(jumpAction.time / duration, 1);
    characterRoot.position.y = Math.sin(jumpTime * Math.PI) * JUMP_LIFT;
  } else if (!isSwitching && characterRoot) {
    characterRoot.position.y = 0;
  }

  // Recycle ground segments
  for (const segment of groundSegments) {
    segment.position.z += RUN_SPEED * delta;

    if (segment.position.z > SEGMENT_LENGTH) {
      segment.position.z -= SEGMENT_COUNT * SEGMENT_LENGTH;
    }
  }

  // Move the set number of obstacles. Once that many have spawned, passed ones are retired.
  for (const hurdle of hurdles) {
    if (!hurdle.userData.active) continue;

    const previousZ = previousHurdleZ.get(hurdle) ?? hurdle.position.z;
    hurdle.position.z += RUN_SPEED * delta;

    const isLaneGate = hurdle.userData.obstacleType === 'switch';
    const encounterId = `${hurdle.userData.obstacleId}:${hurdle.userData.encounter}`;
    if (pendingGestureAction?.encounterId === encounterId && hurdle.position.z <= 0) {
      const actionDistance = pendingGestureAction.action === 'switch-lane'
        ? LANE_SWITCH_ACTION_DISTANCE
        : JUMP_ACTION_DISTANCE;
      if (-hurdle.position.z <= actionDistance) {
        if (pendingGestureAction.action === 'switch-lane') {
          startLaneSwitch(pendingGestureAction.direction);
        } else {
          startJump();
        }
        pendingGestureAction = null;
      }
    }
    const passedCorrectly = isLaneGate
      ? laneIndex === hurdle.userData.openLane
      : isJumping;
    const crossedPlayer = previousZ <= HURDLE_HIT_DEPTH && hurdle.position.z > HURDLE_HIT_DEPTH;

    if (!hurdle.userData.resolved && crossedPlayer) {
      if (resolveObstacle(hurdle, passedCorrectly)) break;
    } else if (
      !hurdle.userData.resolved
      && Math.abs(hurdle.position.z) < HURDLE_HIT_DEPTH
      && !passedCorrectly
    ) {
      if (resolveObstacle(hurdle, false)) break;
    }

    if (hurdle.userData.active && hurdle.position.z > SEGMENT_LENGTH) {
      if (obstaclesSpawned >= obstacleLimit) {
        retireHurdle(hurdle);
        continue;
      }
      const nextIndex = obstaclesSpawned;
      obstaclesSpawned += 1;
      hurdle.position.z = farthestActiveZ(hurdle) - HURDLE_SPACING;
      hurdle.userData.resolved = false;
      hurdle.userData.spawnIndex = nextIndex;
      hurdle.userData.encounter += 1;
      if (hurdle.userData.obstacleType === 'switch') continueGateSequence(hurdle);
    }

    previousHurdleZ.set(hurdle, hurdle.position.z);
  }

  updateObstacleCue();

  activeRenderer?.render(scene, camera);
}

function updateObstacleCue() {
  const now = performance.now();
  if (now - lastCueUpdate < 80) return;
  lastCueUpdate = now;

  const progressFields = {
    trialIndex: lastObstacleIndex,
    trialCount: obstacleLimit,
  };

  if (now < completeUntil) {
    activeGameOptions.onQteUpdate?.({
      status: 'complete',
      progress: 1,
      targetGestureName: lastObstacleTarget,
      resultLabel: lastObstacleResult ? 'Correct — obstacle cleared' : 'Missed — life lost',
      encounterId: lastEncounterId,
      expectedAction: lastExpectedAction,
      ...progressFields,
    });
    return;
  }

  const upcoming = hurdles
    .filter((hurdle) => hurdle.userData.active && hurdle.position.z <= 0)
    .sort((left, right) => right.position.z - left.position.z)[0];
  const distance = upcoming ? -upcoming.position.z : HURDLE_SPACING;
  const targetGestureName = upcoming?.userData.obstacleType === 'switch'
    ? (laneIndex === upcoming.userData.openLane ? 'Hold Lane' : 'Switch Lane')
    : 'Jump';
  const expectedAction = upcoming?.userData.obstacleType === 'switch' ? 'switch-lane' : 'jump';
  const encounterId = upcoming
    ? `${upcoming.userData.obstacleId}:${upcoming.userData.encounter}`
    : '';
  const switchDirection = upcoming?.userData.obstacleType === 'switch'
    ? upcoming.userData.openLane - laneIndex
    : 0;
  const cueContext = {
    encounterId,
    expectedAction,
    switchDirection,
    trialIndex: upcoming ? (upcoming.userData.spawnIndex ?? 0) + 1 : lastObstacleIndex,
    trialCount: obstacleLimit,
  };

  if (distance > 30) {
    activeGameOptions.onQteUpdate?.({ status: 'rest', progress: 0, targetGestureName, ...cueContext });
  } else if (distance > 22) {
    activeGameOptions.onQteUpdate?.({
      status: 'ready',
      progress: Math.min(1, (30 - distance) / 8),
      targetGestureName,
      ...cueContext,
    });
  } else if (distance > 10) {
    activeGameOptions.onQteUpdate?.({
      status: 'recording',
      progress: Math.min(1, Math.max(0, (22 - distance) / 12)),
      targetGestureName,
      ...cueContext,
    });
  } else {
    activeGameOptions.onQteUpdate?.({
      status: 'processing',
      progress: 1,
      targetGestureName,
      ...cueContext,
    });
  }
}