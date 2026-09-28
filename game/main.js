import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TRACK_WIDTH = 10;
const SEGMENT_LENGTH = 20;
const SEGMENT_COUNT = 4;
const RUN_SPEED = 10;

const HURDLE_WIDTH = 2.4;
const SHORT_HURDLE_HEIGHT = 0.45;
const HIGH_HURDLE_HEIGHT = 1.0;
const HURDLE_COUNT = 3; // Same constant is used for short and tall hurdles
const HURDLE_SPACING = 40;
const HURDLE_HIT_DEPTH = 0.35;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 15, 50);

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

const short_hurdles = [];

// Initialize short hurdles
for (let i = 0; i < HURDLE_COUNT; i++) {
  const hurdle = createHurdle(SHORT_HURDLE_HEIGHT);
  hurdle.position.z = -(i + 1) * HURDLE_SPACING;
  scene.add(hurdle);
  short_hurdles.push(hurdle);
}

const high_hurdles = [];

// Initialize tall hurdles
for (let i = 0; i < HURDLE_COUNT; i++) {
  const hurdle = createHurdle(HIGH_HURDLE_HEIGHT);
  hurdle.position.z = -(i + 1.5) * HURDLE_SPACING;
  scene.add(hurdle);
  high_hurdles.push(hurdle)
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
// prevents jumping/sliding while mid-jump
let isJumping = false;
let isSliding = false;

const clock = new THREE.Clock()

const loader = new GLTFLoader();
loader.load(
  '/models/runner.glb',
  (gltf) => {
    const model = gltf.scene;
    model.position.set(0, 0, 0);
    model.rotation.y = Math.PI;
    // model.scale.setScalar(1);
    scene.add(model);

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
      if (event.action == slideAction) {
        isSliding = false;
        slideAction.fadeOut(0.15);
        runAction.reset().fadeIn(0.15).play();
      }
    });

    loader.load(
      '/models/jump.glb',
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
    
    loader.load(
      '/models/slide.glb',
      (slideGltf) => {
        const slideClip =
          THREE.AnimationClip.findByName(slideGltf.animations, 'Running Slide') || slideGltf.animations[0];
        
        lockRootXZ(slideClip)

        slideAction = mixer.clipAction(slideClip);
        slideAction.setLoop(THREE.LoopOnce, 1);
        slideAction.clampWhenFinished = true;
      },
      undefined,
      (error) => {
        console.error('Failed to load slide', error);
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
    if (event.code == 'ArrowDown') startSlide();
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

// Removes horizontal movement from jump/slide animations
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

function startJump() {
  if (isJumping || isSliding || !jumpAction || !runAction) return;

  isJumping = true;
  jumpAction.reset();
  jumpAction.crossFadeFrom(runAction, 0.1, false);
  jumpAction.play()
}

function startSlide() {
  if (isSliding || isJumping || !slideAction || !runAction) return;

  isSliding = true;
  slideAction.reset();
  slideAction.crossFadeFrom(runAction, 0.1, false);
  slideAction.play()
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
  const geometry = new THREE.PlaneGeometry(TRACK_WIDTH, SEGMENT_LENGTH);
  const mesh = new THREE.Mesh(geometry, groundMaterial);
  mesh.rotation.x = -Math.PI/2;
  return mesh;
}

// Same function will be used for short and tall hurdles
function createHurdle(HURDLE_HEIGHT) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0xc4c4c4,
    metalness: 0.35,
    roughness: 0.45,
  });

  const postGeo = new THREE.BoxGeometry(0.08, HURDLE_HEIGHT, 0.08);
  const barGeo = new THREE.BoxGeometry(HURDLE_WIDTH, 0.06, 0.06);

  const leftPost = new THREE.Mesh(postGeo, material);
  leftPost.position.set(-HURDLE_WIDTH/2, HURDLE_HEIGHT/2, 0);

  const rightPost = new THREE.Mesh(postGeo, material);
  rightPost.position.set(HURDLE_WIDTH/2, HURDLE_HEIGHT/2, 0);

  const bar = new THREE.Mesh(barGeo, material);
  bar.position.set(0, HURDLE_HEIGHT, 0);

  group.add(leftPost, rightPost, bar);
  return group;
}

function resetGame() {
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

  for (let i = 0; i < short_hurdles.length; i++) {
    short_hurdles[i].position.z = -(i + 1) * HURDLE_SPACING;
  }
  for (let i = 0; i < high_hurdles.length; i++) {
    high_hurdles[i].position.z = -(i + 1.5) * HURDLE_SPACING;
  }
}

function animate() {
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);

  // Recycle ground segments
  for (const segment of groundSegments) {
    segment.position.z += RUN_SPEED * delta;

    if (segment.position.z > SEGMENT_LENGTH) {
      segment.position.z -= SEGMENT_COUNT * SEGMENT_LENGTH;
    }
  }

  // Recycle hurdles
  for (const hurdle of short_hurdles) {
    hurdle.position.z += RUN_SPEED * delta;

    if (hurdle.position.z > SEGMENT_LENGTH) {
      hurdle.position.z -= HURDLE_COUNT * HURDLE_SPACING;
    }
    if (Math.abs(hurdle.position.z) < HURDLE_HIT_DEPTH && !isJumping) {
      resetGame();
      return;
    }
  }
  for (const hurdle of high_hurdles) {
    hurdle.position.z += RUN_SPEED * delta;

    if (hurdle.position.z > SEGMENT_LENGTH) {
      hurdle.position.z -= HURDLE_COUNT * HURDLE_SPACING;
    }
    if (Math.abs(hurdle.position.z) < HURDLE_HIT_DEPTH && !isSliding) {
      resetGame();
      return;
    }
  }

  activeRenderer?.render(scene, camera);
}