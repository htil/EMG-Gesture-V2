import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TRACK_WIDTH = 10;
const LANE_WIDTH = 2.2;
const LANE_OFFSET = 1.5;
const SEGMENT_LENGTH = 20;
const SEGMENT_COUNT = 4;
const RUN_SPEED = 10;
const CHARACTER_SCALE = 4;

const HURDLE_WIDTH = 2.4;
const HURDLE_HEIGHT = 0.45;
const HURDLE_COUNT = 6;
const HURDLE_SPACING = 40;
const HURDLE_HIT_DEPTH = 0.35;

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

// Initialize hurdles
for (let i = 0; i < HURDLE_COUNT; i++) {
  const hurdle = createHurdle();
  hurdle.position.z = -(i + 1) * HURDLE_SPACING;
  scene.add(hurdle);
  hurdles.push(hurdle);
}

const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
let activeRenderer = null;

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

let characterRoot = null;
let laneIndex = 0;
let isSwitching = false;
let switchFrom = -LANE_OFFSET;
let switchTo = -LANE_OFFSET;
let switchElapsed = 0;

const LANE_SWITCH_TIME = 0.3;

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

export function mountGame(container) {
  const resizeRenderer = () => {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    activeRenderer?.setSize(width, height);
  };

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
  };
}

// Removes horizontal movement from jump animations
function lockRootXZ(clip) {
  for (const track of clip.tracks) {
    if (!track.name.endsWith('Hips.position')) continue;

    const values = track.values;
    const baseX = values[0];
    const baseZ = values[1];

    for (let i = 0; i < values.length; i += 3) {
      values[i] = baseX;
      values[i+1] = baseZ;
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

function resetGame() {
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

  for (let i = 0; i < hurdles.length; i++) {
    hurdles[i].position.z = -(i + 1) * HURDLE_SPACING;
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
    hurdle.position.z += RUN_SPEED * delta;

    if (hurdle.position.z > SEGMENT_LENGTH) {
      hurdle.position.z -= HURDLE_COUNT * HURDLE_SPACING;
    }
    if (Math.abs(hurdle.position.z) < HURDLE_HIT_DEPTH && !isJumping) {
      resetGame();
      return;
    }
  }

  activeRenderer?.render(scene, camera);
}