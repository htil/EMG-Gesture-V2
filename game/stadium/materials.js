import * as THREE from 'three';

export function assignSurfaceTexture(material, texture) {
  material.map = texture || null;
  material.color.set(texture ? '#ffffff' : material.userData.baseColor);
  material.transparent = Boolean(texture);
  material.needsUpdate = true;
  if (texture) texture.colorSpace = THREE.SRGBColorSpace;
}

function scoreSurfaceMaterial(color) {
  const material = new THREE.MeshBasicMaterial({ color });
  material.userData.baseColor = color;
  return material;
}

export function createMaterials(config) {
  const glow = createRadialTexture([
    [0, 'rgba(255, 252, 240, 0.2)'],
    [0.22, 'rgba(255, 248, 226, 0.7)'],
    [0.55, 'rgba(255, 244, 214, 0.28)'],
    [1, 'rgba(255, 244, 214, 0)'],
  ]);
  const concrete = new THREE.MeshBasicMaterial({ color: config.concrete, side: THREE.DoubleSide });
  return {
    seats: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    wall: concrete,
    accent: new THREE.MeshBasicMaterial({ color: config.seatAccent, side: THREE.DoubleSide }),
    concourseDeck: new THREE.MeshBasicMaterial({ color: config.concourseDeck, side: THREE.DoubleSide }),
    concourseRiser: new THREE.MeshBasicMaterial({ color: config.concourseRiser, side: THREE.DoubleSide }),
    seatPaint: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    scoreDisplay: scoreSurfaceMaterial(config.crimson),
    boardFrame: new THREE.MeshBasicMaterial({ color: config.scoreFrame }),
    boardHousing: new THREE.MeshBasicMaterial({ color: config.scoreHousing }),
    boardSupport: new THREE.MeshBasicMaterial({ color: config.scoreSupport }),
    boardBevel: new THREE.MeshBasicMaterial({ color: config.scoreBevel }),
    tunnel: new THREE.MeshBasicMaterial({ color: config.tunnel, side: THREE.DoubleSide }),
    lightFrame: new THREE.MeshBasicMaterial({ color: config.lightFrame }),
    lightHousing: new THREE.MeshBasicMaterial({ color: config.lightHousing }),
    lightPole: new THREE.MeshBasicMaterial({ color: config.lightPole }),
    bulb: new THREE.MeshBasicMaterial({
      vertexColors: true,
      fog: false,
    }),
    glow: new THREE.MeshBasicMaterial({
      map: glow,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
    halo: new THREE.MeshBasicMaterial({
      map: glow,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
    grass: new THREE.MeshStandardMaterial({
      map: createFieldTexture(),
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 4,
    }),
    lane: new THREE.MeshStandardMaterial({
      color: config.lane,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    cloud: new THREE.MeshBasicMaterial({
      vertexColors: true,
      fog: false,
      transparent: config.cloudOpacity < 1,
      opacity: config.cloudOpacity,
    }),
  };
}

function createRadialTexture(stops) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(canvas, false);
}

function createFieldTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4a7c3a';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#3d6b32';
  ctx.fillRect(0, 0, size, size / 2);
  const texture = canvasTexture(canvas, true);
  texture.repeat.set(1, 4);
  return texture;
}

function canvasTexture(canvas, repeat) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  return texture;
}
