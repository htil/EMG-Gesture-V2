import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TRACK_WIDTH = 10;
const SEGMENT_LENGTH = 20;
const SEGMENT_COUNT = 4;
const RUN_SPEED = 10;

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

const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );

const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setAnimationLoop( animate );
document.body.appendChild( renderer.domElement );

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
const clock = new THREE.Clock()

const loader = new GLTFLoader();
loader.load(
  '/models/runner.glb',
  (gltf) => {
    const model = gltf.scene;
    model.position.set(-1, 0, 0);
    model.rotation.y = Math.PI;
    // model.scale.setScalar(1);
    scene.add(model);

    // Animation
    mixer = new THREE.AnimationMixer(model);
    const clips = gltf.animations;

    const runClip = THREE.AnimationClip.findByName(clips, 'Running') || clips[0];

    if (runClip) {
      const action = mixer.clipAction(runClip);
      action.play();
    } else {
      console.warn('No animations found on this model.');
    }
  },
  undefined,
  (error) => {
    console.error('Failed to load model:', error);
  }
);

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

function animate() {
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);

  for (const segment of groundSegments) {
    segment.position.z += RUN_SPEED * delta;

    if (segment.position.z > SEGMENT_LENGTH) {
      segment.position.z -= SEGMENT_COUNT * SEGMENT_LENGTH;
    }
  }

  renderer.render(scene, camera);
}