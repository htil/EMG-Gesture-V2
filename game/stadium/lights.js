import * as THREE from 'three';

export function createLightGeometries(config) {
  const { panelW, panelH } = lightPanelSize(config);
  const braceLength = Math.hypot(config.lightArmLength, config.lightPoleHeight * 0.45);
  return {
    lightPole: new THREE.CylinderGeometry(
      config.lightPoleRadius,
      config.lightPoleRadius * 1.15,
      config.lightPoleHeight,
      10,
    ),
    lightFoot: new THREE.BoxGeometry(1.25, 0.16, 1.25),
    lightNeck: new THREE.BoxGeometry(0.48, 0.4, 0.85),
    lightArm: new THREE.BoxGeometry(config.lightArmLength, 0.42, 0.36),
    lightBrace: new THREE.BoxGeometry(braceLength, 0.18, 0.16),
    lightHousing: new THREE.BoxGeometry(panelW * 0.9, panelH * 0.9, config.lightHousingDepth),
    lightBack: new THREE.BoxGeometry(panelW - config.frameBar * 1.4, panelH - config.frameBar * 1.4, 0.08),
    lightFrameH: new THREE.BoxGeometry(panelW, config.frameBar, config.frameDepth),
    lightFrameV: new THREE.BoxGeometry(config.frameBar, panelH - config.frameBar * 2, config.frameDepth),
    lightBulb: createBulbGeometry(config.bulbRadius),
    lightGlow: new THREE.PlaneGeometry(panelW * 1.7, panelH * 1.9),
    lightHalo: new THREE.PlaneGeometry(panelW * 2.6, panelH * 2.8),
  };
}

export function addFloodlight(section, side, along, config, geometries, materials, layout) {
  const poleX = side * (layout.upperOuter + 0.45);
  const headX = poleX - side * config.lightArmLength;
  const baseY = layout.upperBackY;
  const topY = baseY + config.lightPoleHeight;

  const pole = new THREE.Mesh(geometries.lightPole, materials.lightPole);
  pole.position.set(poleX, baseY + config.lightPoleHeight / 2, along);
  const foot = new THREE.Mesh(geometries.lightFoot, materials.lightFrame);
  foot.position.set(poleX, baseY + 0.06, along);

  const arm = new THREE.Mesh(geometries.lightArm, materials.lightFrame);
  arm.position.set((poleX + headX) / 2, topY, along);
  const brace = new THREE.Mesh(geometries.lightBrace, materials.lightPole);
  brace.position.set((poleX + headX) / 2, topY - config.lightPoleHeight * 0.22, along);
  brace.rotation.z = Math.atan2(config.lightPoleHeight * 0.45, headX - poleX);
  section.add(pole, foot, arm, brace);

  const head = new THREE.Group();
  head.position.set(headX, topY, along);
  head.rotation.order = 'YXZ';
  head.rotation.y = -side * config.lightYaw;
  head.rotation.x = config.lightTilt;

  const lampZ = 0.95;
  const housing = new THREE.Mesh(geometries.lightHousing, materials.lightHousing);
  housing.position.z = lampZ - config.lightHousingDepth / 2 - 0.08;
  const back = new THREE.Mesh(geometries.lightBack, materials.lightFrame);
  back.position.z = lampZ - 0.05;
  const neck = new THREE.Mesh(geometries.lightNeck, materials.lightFrame);
  neck.position.z = 0.28;

  const { panelW, panelH } = lightPanelSize(config);
  const frameTop = new THREE.Mesh(geometries.lightFrameH, materials.lightFrame);
  frameTop.position.set(0, panelH / 2 - config.frameBar / 2, lampZ);
  const frameBottom = frameTop.clone();
  frameBottom.position.y = -frameTop.position.y;
  const frameLeft = new THREE.Mesh(geometries.lightFrameV, materials.lightFrame);
  frameLeft.position.set(-panelW / 2 + config.frameBar / 2, 0, lampZ);
  const frameRight = frameLeft.clone();
  frameRight.position.x = -frameLeft.position.x;

  const halo = new THREE.Mesh(geometries.lightHalo, materials.halo);
  halo.position.z = lampZ + 0.05;
  halo.renderOrder = 1;
  const glow = new THREE.Mesh(geometries.lightGlow, materials.glow);
  glow.position.z = lampZ + 0.28;
  glow.renderOrder = 2;

  const bulbs = new THREE.InstancedMesh(
    geometries.lightBulb,
    materials.bulb,
    config.bulbCols * config.bulbRows,
  );
  placeBulbs(bulbs, config);
  bulbs.position.z = lampZ + 0.14;
  bulbs.renderOrder = 3;

  head.add(neck, housing, back, frameTop, frameBottom, frameLeft, frameRight, halo, glow, bulbs);
  section.add(head);
}

function lightPanelSize(config) {
  const pitch = config.bulbRadius * 2 + config.bulbGap;
  const gridW = (config.bulbCols - 1) * pitch;
  const gridH = (config.bulbRows - 1) * pitch;
  return {
    pitch,
    panelW: gridW + config.bulbRadius * 2 + config.framePadding * 2,
    panelH: gridH + config.bulbRadius * 2 + config.framePadding * 2,
  };
}

function createBulbGeometry(radius) {
  const geometry = new THREE.SphereGeometry(radius, 16, 12);
  geometry.scale(1, 1, 0.82);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const core = new THREE.Color('#FFFDF0');
  const rim = new THREE.Color('#E4C98A');
  const depth = radius * 0.82;

  for (let i = 0; i < position.count; i += 1) {
    const facing = Math.max(0, position.getZ(i) / depth);
    const color = rim.clone().lerp(core, facing * facing);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.translate(0, 0, radius * 0.1);
  return geometry;
}

function placeBulbs(mesh, config) {
  const pitch = config.bulbRadius * 2 + config.bulbGap;
  const dummy = new THREE.Object3D();
  let index = 0;
  for (let row = 0; row < config.bulbRows; row += 1) {
    for (let col = 0; col < config.bulbCols; col += 1) {
      dummy.position.set(
        (col - (config.bulbCols - 1) / 2) * pitch,
        (row - (config.bulbRows - 1) / 2) * pitch,
        0,
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      index += 1;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}
