import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TRACK_WIDTH = 10;
const LANE_WIDTH = 2.2;
const LANE_OFFSET = 1.5;
const SEGMENT_LENGTH = 20;
const SEGMENT_COUNT = 4;
const RUN_SPEED = 10;

const HURDLE_WIDTH = 2.4;
const HURDLE_HEIGHT = 0.45;
const HURDLE_COUNT = 6;
const HURDLE_SPACING = 40;
const HURDLE_HIT_DEPTH = 0.35;
const JUMP_ACTION_DISTANCE = 4.5;
const LANE_SWITCH_ACTION_DISTANCE = 3.5;

const JUMP_SCALE = 2; // Edit jump height

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

// Alternate jump hurdles with lane gates. A lane gate blocks one lane completely.
for (let i = 0; i < HURDLE_COUNT; i++) {
  const isLaneGate = i % 2 === 1;
  const openLane = Math.floor(i / 2) % 2 === 0 ? 1 : 0;
  const hurdle = isLaneGate ? createLaneGate(openLane) : createHurdle();
  hurdle.userData.obstacleType = isLaneGate ? 'switch' : 'jump';
  hurdle.userData.openLane = isLaneGate ? openLane : null;
  hurdle.userData.resolved = false;
  hurdle.userData.encounter = 0;
  hurdle.userData.obstacleId = i;
  hurdle.position.z = -(i + 1) * HURDLE_SPACING;
  scene.add(hurdle);
  hurdles.push(hurdle);
}

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
// prevents jumping/sliding while mid-jump
let isJumping = false;
let isSliding = false;

const clock = new THREE.Clock()
const loader = new GLTFLoader();

const atlas = new THREE.TextureLoader().load('/models/Atlas_Pirate.png');
atlas.colorSpace = THREE.SRGBColorSpace;
atlas.flipY = false;

const characters = [
  '/models/Anne.glb',
  '/models/Captain.glb',
  '/models/Henry.glb',
  '/models/Skeleton.glb',
];

let characterModel = null;
let loadId = 0;

let characterRoot = null;
let laneIndex = 0;
let isSwitching = false;
let switchFrom = -LANE_OFFSET;
let switchTo = -LANE_OFFSET;
let switchElapsed = 0;

const LANE_SWITCH_TIME = 0.3;

function findClip(animations, actionName) {
  return animations.find((clip) => clip.name.split('|').includes(actionName));
}

function clearCharacter() {
  loadId += 1;
  if (characterRoot) {
    scene.remove(characterRoot);
    characterModel = null;
  }
  characterRoot = null;
  laneIndex = 0;
  isSwitching = false;

  mixer = null;
  runAction = null;

  jumpAction = null;
  isJumping = false;

  slideAction = null;
  isSliding = false;
}

function scaleJumpHeight(clip) {
  const bodyTrack = clip.tracks.find((track) => track.name === 'Body.position');
  if (!bodyTrack) return;
  const baseY = bodyTrack.values[1];
  const times = bodyTrack.times;
  const values = new Float32Array(times.length * 3);
  for (let i = 0; i < times.length; i++) {
    const rise = Math.max(0, bodyTrack.values[i * 3 + 1] - baseY);
    values[i * 3 + 1] = rise * (JUMP_SCALE - 1);
  }
  clip.tracks = clip.tracks.filter((track) => track.name !== 'Root.position');
  clip.tracks.push(new THREE.VectorKeyframeTrack('Root.position', times, values));
}

function loadCharacter() {
  const requestId = ++loadId;
  const characterUrl = characters[Math.floor(Math.random() * characters.length)];

  loader.load(
    characterUrl,
    (gltf) => {
      if (requestId !== loadId) return;

      const model = gltf.scene;
      model.traverse((child) => {
        if (!child.isMesh) return;
        child.material = new THREE.MeshLambertMaterial({
          map: atlas,
          side: THREE.DoubleSide,
        });
      });
      model.position.set(0, 0, 0);
      model.rotation.y = Math.PI;

      const root = new THREE.Group();
      root.position.set(-LANE_OFFSET, 0, 0);
      root.add(model);
      scene.add(root);
      characterRoot = root;
      characterModel = model;

      mixer = new THREE.AnimationMixer(model);

      const runClip = findClip(gltf.animations, 'Run');
      if (!runClip) {
        console.error('No Run clip in', characterUrl);
        return;
      }

      runAction = mixer.clipAction(runClip);
      runAction.play();

      const jumpClip = findClip(gltf.animations, 'Jump');
      if (!jumpClip) {
        console.error('No Jump clip in', characterUrl);
        return;
      }

      scaleJumpHeight(jumpClip);

      jumpAction = mixer.clipAction(jumpClip);
      jumpAction.timeScale = 0.75;
      jumpAction.setLoop(THREE.LoopOnce, 1);
      jumpAction.clampWhenFinished = true;

      mixer.addEventListener('finished', (event) => {
        if (event.action !== jumpAction) return;

        isJumping = false;
        jumpAction.fadeOut(0.15);
        runAction.reset().fadeIn(0.15).play();
      })
    },
    undefined,
    (error) => {
      console.error('Failed to load model:', error);
    }
  )
}

export function mountGame(container, options = {}) {
  const resizeRenderer = () => {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    activeRenderer?.setSize(width, height);
  };

  loadCharacter();
  activeGameOptions = options;

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
    clearCharacter();
  };
}

export function startJump() {
  if (isJumping || isSliding || isSwitching || !jumpAction || !runAction) return;

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

function createHurdle() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0xFF0000,
    metalness: 0.35,
    roughness: 0.45,
  });

  const postGeo = new THREE.BoxGeometry(0.08, HURDLE_HEIGHT, 0.08);
  const barGeo = new THREE.BoxGeometry(HURDLE_WIDTH, 0.06, 0.06);

  // Create left lane hurdle
  const leftPostL = new THREE.Mesh(postGeo, material);
  leftPostL.position.set(-HURDLE_WIDTH/2 - LANE_OFFSET, HURDLE_HEIGHT/2, 0);

  const rightPostL = new THREE.Mesh(postGeo, material);
  rightPostL.position.set(HURDLE_WIDTH/2 - LANE_OFFSET, HURDLE_HEIGHT/2, 0);

  const barL = new THREE.Mesh(barGeo, material);
  barL.position.set(-LANE_OFFSET, HURDLE_HEIGHT, 0);

  // Create right lane hurdle
  const leftPostR = new THREE.Mesh(postGeo, material);
  leftPostR.position.set(-HURDLE_WIDTH/2 + LANE_OFFSET, HURDLE_HEIGHT/2, 0);

  const rightPostR = new THREE.Mesh(postGeo, material);
  rightPostR.position.set(HURDLE_WIDTH/2 + LANE_OFFSET, HURDLE_HEIGHT/2, 0);

  const barR = new THREE.Mesh(barGeo, material);
  barR.position.set(LANE_OFFSET, HURDLE_HEIGHT, 0);

  group.add(leftPostL, rightPostL, barL, leftPostR, rightPostR, barR);
  return group;
}

function createLaneGate(openLane) {
  const group = new THREE.Group();
  const closedLane = openLane === 0 ? 1 : 0;
  const closedX = closedLane === 0 ? -LANE_OFFSET : LANE_OFFSET;
  const openX = openLane === 0 ? -LANE_OFFSET : LANE_OFFSET;
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0x5f0a16,
    metalness: 0.25,
    roughness: 0.55,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x083344,
    metalness: 0.45,
    roughness: 0.35,
  });

  const wall = new THREE.Mesh(new THREE.BoxGeometry(LANE_WIDTH, 2.6, 0.32), wallMaterial);
  wall.position.set(closedX, 1.3, 0);
  group.add(wall);

  // Bright frame makes the single open lane readable from a distance.
  const postGeometry = new THREE.BoxGeometry(0.1, 2.6, 0.12);
  const topGeometry = new THREE.BoxGeometry(LANE_WIDTH, 0.12, 0.12);
  const leftPost = new THREE.Mesh(postGeometry, frameMaterial);
  const rightPost = new THREE.Mesh(postGeometry, frameMaterial);
  const topBar = new THREE.Mesh(topGeometry, frameMaterial);
  leftPost.position.set(openX - LANE_WIDTH / 2, 1.3, 0);
  rightPost.position.set(openX + LANE_WIDTH / 2, 1.3, 0);
  topBar.position.set(openX, 2.55, 0);
  group.add(leftPost, rightPost, topBar);

  return group;
}

function resetGame() {
  pendingGestureAction = null;
  laneIndex = 0;
  isSwitching = false;
  if (characterRoot) {
    characterRoot.position.set(-LANE_OFFSET, 0, 0);
    characterRoot.rotation.set(0, 0, 0);
  }

  isJumping = false;
  isSliding = false;

  if (jumpAction) {
    jumpAction.stop();
    jumpAction.reset();
  }
  if (slideAction) {
    slideAction.stop();
    slideAction.reset();
  }
  if (runAction) {
    runAction.reset().fadeIn(0.1).play();
  }

  for (let i = 0; i < groundSegments.length; i++) {
    groundSegments[i].position.z = -i * SEGMENT_LENGTH;
  }

  for (let i = 0; i < hurdles.length; i++) {
    hurdles[i].position.z = -(i + 1) * HURDLE_SPACING;
    hurdles[i].userData.resolved = false;
    hurdles[i].userData.encounter += 1;
  }
}

function animate() {
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);

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

  // Recycle ground segments
  for (const segment of groundSegments) {
    segment.position.z += RUN_SPEED * delta;

    if (segment.position.z > SEGMENT_LENGTH) {
      segment.position.z -= SEGMENT_COUNT * SEGMENT_LENGTH;
    }
  }

  // Recycle hurdles
  for (const hurdle of hurdles) {
    const previousZ = previousHurdleZ.get(hurdle) ?? hurdle.position.z;
    hurdle.position.z += RUN_SPEED * delta;
    previousHurdleZ.set(hurdle, hurdle.position.z);

    if (hurdle.position.z > SEGMENT_LENGTH) {
      hurdle.position.z -= HURDLE_COUNT * HURDLE_SPACING;
      hurdle.userData.resolved = false;
      hurdle.userData.encounter += 1;
      previousHurdleZ.set(hurdle, hurdle.position.z);
    }

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

    if (
      !hurdle.userData.resolved
      && Math.abs(hurdle.position.z) < HURDLE_HIT_DEPTH
      && !passedCorrectly
    ) {
      hurdle.userData.resolved = true;
      completeUntil = performance.now() + 700;
      lastObstacleResult = false;
      lastObstacleTarget = isLaneGate ? 'Switch Lane' : 'Jump';
      lastExpectedAction = isLaneGate ? 'switch-lane' : 'jump';
      lastEncounterId = `${hurdle.userData.obstacleId}:${hurdle.userData.encounter}`;
      activeGameOptions.onObstacleResult?.({
        correct: false,
        encounterId: lastEncounterId,
        expectedAction: lastExpectedAction,
      });
      resetGame();
      break;
    }
    if (
      !hurdle.userData.resolved
      && previousZ <= HURDLE_HIT_DEPTH
      && hurdle.position.z > HURDLE_HIT_DEPTH
      && passedCorrectly
    ) {
      hurdle.userData.resolved = true;
      completeUntil = performance.now() + 700;
      lastObstacleResult = true;
      lastObstacleTarget = isLaneGate ? 'Switch Lane' : 'Jump';
      lastExpectedAction = isLaneGate ? 'switch-lane' : 'jump';
      lastEncounterId = `${hurdle.userData.obstacleId}:${hurdle.userData.encounter}`;
      activeGameOptions.onObstacleResult?.({
        correct: true,
        encounterId: lastEncounterId,
        expectedAction: lastExpectedAction,
      });
    }
  }

  updateObstacleCue();

  activeRenderer?.render(scene, camera);
}

function updateObstacleCue() {
  const now = performance.now();
  if (now - lastCueUpdate < 80) return;
  lastCueUpdate = now;

  if (now < completeUntil) {
    activeGameOptions.onQteUpdate?.({
      status: 'complete',
      progress: 1,
      targetGestureName: lastObstacleTarget,
      resultLabel: lastObstacleResult ? 'Correct — obstacle cleared' : 'Missed — return to rest',
      encounterId: lastEncounterId,
      expectedAction: lastExpectedAction,
    });
    return;
  }

  const upcoming = hurdles
    .filter((hurdle) => hurdle.position.z <= 0)
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
  const cueContext = { encounterId, expectedAction, switchDirection };

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
