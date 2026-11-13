import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function applyAtmosphere(scene, config) {
  scene.background = new THREE.Color(config.skyHorizon);
  scene.fog = new THREE.Fog(config.fogColor, config.fogNear, config.fogFar);
}

export function createBackdrop(config, materials) {
  const backdrop = new THREE.Group();
  backdrop.name = 'stadium-backdrop';
  const clouds = createClouds(config, materials.cloud);
  backdrop.add(createSky(config));
  backdrop.add(clouds);
  backdrop.userData.clouds = clouds;
  return backdrop;
}

function createSky(config) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(420, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        horizonColor: { value: new THREE.Color(config.skyHorizon) },
        midColor: { value: new THREE.Color(config.skyMid) },
        zenithColor: { value: new THREE.Color(config.skyZenith) },
        horizonStop: { value: config.skyHorizonStop },
        zenithStop: { value: config.skyZenithStop },
      },
      vertexShader: `
        varying vec3 vPosition;
        void main() {
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 horizonColor;
        uniform vec3 midColor;
        uniform vec3 zenithColor;
        uniform float horizonStop;
        uniform float zenithStop;
        varying vec3 vPosition;
        void main() {
          float height = clamp(normalize(vPosition).y, 0.0, 1.0);
          vec3 color = mix(horizonColor, midColor, smoothstep(0.0, horizonStop, height));
          color = mix(color, zenithColor, smoothstep(horizonStop, zenithStop, height));
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    }),
  );
  sky.position.set(0, 2, 3);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

function createClouds(config, material) {
  const puff = new THREE.SphereGeometry(1, 12, 9);
  const top = new THREE.Color(config.cloudTop);
  const bottom = new THREE.Color(config.cloudBottom);
  const lobes = [
    [0, 0.16, 0, 1, 0.86],
    [0.8, 0.02, 0.12, 0.74, 0.78],
    [-0.76, 0.0, -0.1, 0.68, 0.76],
    [0.12, 0.72, 0.02, 0.58, 0.74],
    [-0.28, 0.58, 0.16, 0.5, 0.72],
    [0.46, 0.5, -0.12, 0.46, 0.7],
  ];
  const parts = [];

  config.clouds.forEach((spec, index) => {
    const scale = spec.scale * config.cloudScale;
    const yaw = (index * 1.7 + 0.4) % (Math.PI * 2);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const count = scale > 3 ? lobes.length : 4;
    for (let lobe = 0; lobe < count; lobe += 1) {
      const [lx, ly, lz, ls, sy] = lobes[lobe];
      const geometry = puff.clone();
      paintCloud(geometry, top, bottom);
      const x = lx * cos - lz * sin;
      const z = lx * sin + lz * cos;
      geometry.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(spec.x + x * scale, spec.y + ly * scale, spec.z + z * scale),
        new THREE.Quaternion(),
        new THREE.Vector3(ls * scale, ls * sy * scale, ls * scale * 0.92),
      ));
      parts.push(geometry);
    }
  });

  const clouds = new THREE.Mesh(mergeGeometries(parts), material);
  puff.dispose();
  for (const geometry of parts) geometry.dispose();
  clouds.frustumCulled = false;
  return clouds;
}

function paintCloud(geometry, top, bottom) {
  const normal = geometry.attributes.normal;
  const colors = new Float32Array(normal.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < normal.count; i += 1) {
    const shade = normal.getY(i) * 0.5 + 0.5;
    color.copy(bottom).lerp(top, shade * shade);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
