import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const scene = new THREE.Scene();
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
    model.position.set(0, 0, 0);
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

function animate() {
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);
  renderer.render(scene, camera);
}