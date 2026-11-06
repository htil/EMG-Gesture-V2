import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function createStandGeometries(config, layout) {
  const length = config.sectionLength;
  return {
    lowerTier: createTierGeometry(
      length,
      config.lowerTierDepth,
      config.plinthHeight,
      layout.lowerBackY,
      config.lowerTierSteps,
      config.crimson,
      config.seatTread,
      true,
    ),
    upperTier: createTierGeometry(
      length,
      config.upperTierDepth,
      layout.upperFrontY,
      layout.upperBackY,
      config.upperTierSteps,
      config.crimson,
      config.seatTread,
      false,
    ),
    seat: createSeatGeometry(config, config.seatBevelSegments),
    seatFar: createSeatGeometry(config, 2),
    plinth: new THREE.BoxGeometry(config.plinthDepth, config.plinthHeight, length),
    concourseBody: new THREE.BoxGeometry(
      config.concourseDepth,
      config.concourseHeight - config.concourseDeckThickness,
      length,
    ),
    concourseDeck: new THREE.BoxGeometry(config.concourseDepth, config.concourseDeckThickness, length),
    accent: new THREE.BoxGeometry(0.28, 0.1, length),
    cap: new THREE.BoxGeometry(0.7, 0.28, length),
  };
}

// side is +1 on the right (positive X) and -1 on the left.
// Each bowl is built outward in +X, then the whole stand is mirrored.
export function addStand(section, side, sectionIndex, config, geometries, materials, layout) {
  const pivot = new THREE.Group();
  pivot.scale.x = side;

  const plinth = new THREE.Mesh(geometries.plinth, materials.wall);
  plinth.position.set(layout.front + config.plinthDepth / 2, config.plinthHeight / 2, 0);
  pivot.add(plinth);

  const lower = new THREE.Mesh(geometries.lowerTier, materials.seats);
  lower.position.x = layout.lowerInner;
  const lowerAccent = new THREE.Mesh(geometries.accent, materials.accent);
  lowerAccent.position.set(layout.lowerInner + 0.2, config.plinthHeight + 0.08, 0);
  pivot.add(lower, lowerAccent);

  const concourseX = layout.lowerOuter - config.concourseDepth * 0.2;
  const deckThickness = config.concourseDeckThickness;
  const bodyHeight = config.concourseHeight - deckThickness;
  const concourseBody = new THREE.Mesh(geometries.concourseBody, materials.concourseRiser);
  concourseBody.position.set(concourseX, layout.concourseTop - deckThickness - bodyHeight / 2, 0);
  const concourseDeck = new THREE.Mesh(geometries.concourseDeck, materials.concourseDeck);
  concourseDeck.position.set(concourseX, layout.concourseTop - deckThickness / 2, 0);
  pivot.add(concourseBody, concourseDeck);

  const upper = new THREE.Mesh(geometries.upperTier, materials.seats);
  upper.position.x = layout.upperInner;
  const upperAccent = new THREE.Mesh(geometries.accent, materials.accent);
  upperAccent.position.set(layout.upperInner + 0.2, layout.upperFrontY + 0.08, 0);
  pivot.add(upper, upperAccent);

  const cap = new THREE.Mesh(geometries.cap, materials.wall);
  cap.position.set(layout.upperOuter - 0.2, layout.upperBackY + 0.02, 0);
  pivot.add(cap);

  addTierSeating(section, pivot, side, sectionIndex, 'lower', config, geometries, materials, {
    originX: layout.lowerInner,
    depth: config.lowerTierDepth,
    startHeight: config.plinthHeight,
    endHeight: layout.lowerBackY,
    steps: config.lowerTierSteps,
  });
  addTierSeating(section, pivot, side, sectionIndex, 'upper', config, geometries, materials, {
    originX: layout.upperInner,
    depth: config.upperTierDepth,
    startHeight: layout.upperFrontY,
    endHeight: layout.upperBackY,
    steps: config.upperTierSteps,
  });
  const aisle = sectionAisleWidth(sectionIndex, config);
  if (aisle > 0) addAisle(pivot, aisle, config, geometries, materials, layout);
  if (sectionDividerZ(sectionIndex, config) !== null) {
    addDivider(pivot, sectionIndex, config, geometries, materials, layout);
  }
  if (sectionIndex % config.entranceEvery === config.entrancePhase) {
    addEntrance(pivot, sectionIndex, config, geometries, materials, layout);
  }

  section.add(pivot);
}

export function updateSeatDetail(section, config) {
  const pairs = section.userData.seatLods;
  if (!pairs) return;
  const distance = config.lodCameraZ - section.position.z;
  for (const pair of pairs) {
    const detailed = pair.near.visible;
    let next = detailed;
    if (distance <= config.seatDetailDistance) next = true;
    else if (distance >= config.seatSimpleDistance) next = false;
    if (next === detailed) continue;
    pair.near.visible = next;
    pair.far.visible = !next;
  }
}

function addTierSeating(section, pivot, side, sectionIndex, tierName, config, geometries, materials, tier) {
  const slots = seatSlots(sectionIndex, side, tierName, config, tier);
  if (slots.length === 0) return;

  const near = new THREE.InstancedMesh(geometries.seat, materials.seatPaint, slots.length);
  const far = new THREE.InstancedMesh(geometries.seatFar, materials.seatPaint, slots.length);
  writeSeatInstances(near, slots, false);
  writeSeatInstances(far, slots, false);
  const distance = config.lodCameraZ + sectionIndex * config.sectionLength;
  const detailed = distance <= config.seatDetailDistance;
  near.visible = detailed;
  far.visible = !detailed;
  near.userData.seatDetail = 'near';
  far.userData.seatDetail = 'far';
  pivot.add(near, far);

  if (!section.userData.seatLods) section.userData.seatLods = [];
  section.userData.seatLods.push({ near, far });
}

function seatSlots(sectionIndex, side, tierName, config, tier) {
  const stepDepth = tier.depth / tier.steps;
  const stepRise = (tier.endHeight - tier.startHeight) / tier.steps;
  const count = Math.floor(config.sectionLength / config.seatSpacing);
  const z0 = -((count - 1) * config.seatSpacing) / 2;
  const tierId = tierName === 'lower' ? 1 : 2;
  const sideId = side === 1 ? 1 : 2;
  const aisle = sectionAisleWidth(sectionIndex, config);
  const dividerZ = sectionDividerZ(sectionIndex, config);
  const slots = [];

  for (let row = 0; row < tier.steps; row += 1) {
    const treadY = tier.startHeight + (row + 1) * stepRise;
    const x = tier.originX + (row + config.seatRowInset) * stepDepth;
    let clusterLeft = 0;
    let clusterColor = config.crimson;

    for (let seat = 0; seat < count; seat += 1) {
      const z = z0 + seat * config.seatSpacing;
      if (aisle > 0 && Math.abs(z - config.aisleZ) < aisle / 2) continue;
      if (dividerZ !== null && Math.abs(z - dividerZ) < config.dividerWidth / 2 + 0.06) continue;
      if (clusterLeft <= 0) {
        const roll = mixHash(sectionIndex, sideId, tierId, row, seat);
        clusterColor = seatColor(roll, config);
        clusterLeft = 2 + Math.floor(mixHash(sectionIndex, sideId, tierId, row, seat + 97) * 3);
      }
      slots.push({ x, y: treadY + config.seatLift, z, color: clusterColor });
      clusterLeft -= 1;
    }
  }

  return slots;
}

function writeSeatInstances(mesh, slots, scaled) {
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    dummy.position.set(slot.x, slot.y, slot.z);
    dummy.scale.set(scaled ? slot.sx : 1, scaled ? slot.sy : 1, scaled ? slot.sz : 1);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    color.set(slot.color);
    mesh.setColorAt(index, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}

function addAisle(pivot, width, config, geometries, materials, layout) {
  addAisleTier(pivot, width, config, geometries, materials, {
    originX: layout.lowerInner,
    depth: config.lowerTierDepth,
    startHeight: config.plinthHeight,
    endHeight: layout.lowerBackY,
    steps: config.lowerTierSteps,
  });
  addAisleTier(pivot, width, config, geometries, materials, {
    originX: layout.upperInner,
    depth: config.upperTierDepth,
    startHeight: layout.upperFrontY,
    endHeight: layout.upperBackY,
    steps: config.upperTierSteps,
  });

  const deck = new THREE.Mesh(geometries.unitBox, materials.concourseDeck);
  deck.position.set(
    layout.lowerOuter - config.concourseDepth * 0.2,
    layout.concourseTop + 0.02,
    config.aisleZ,
  );
  deck.scale.set(config.concourseDepth * 0.92, 0.04, width);
  pivot.add(deck);
}

function addAisleTier(pivot, width, config, geometries, materials, tier) {
  const stepDepth = tier.depth / tier.steps;
  const stepRise = (tier.endHeight - tier.startHeight) / tier.steps;
  const pads = new THREE.InstancedMesh(geometries.unitBox, materials.concourseDeck, tier.steps);
  const risers = new THREE.InstancedMesh(geometries.unitBox, materials.concourseRiser, tier.steps);
  const cheeks = new THREE.InstancedMesh(geometries.unitBox, materials.concourseRiser, tier.steps);
  const dummy = new THREE.Object3D();

  for (let row = 0; row < tier.steps; row += 1) {
    const treadY = tier.startHeight + (row + 1) * stepRise;
    const x = tier.originX + (row + 0.5) * stepDepth;
    dummy.position.set(x, treadY + 0.025, config.aisleZ);
    dummy.scale.set(stepDepth * 0.96, 0.05, width);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    pads.setMatrixAt(row, dummy.matrix);

    dummy.position.set(tier.originX + row * stepDepth - 0.02, treadY - stepRise / 2, config.aisleZ);
    dummy.scale.set(0.08, stepRise * 1.04, width);
    dummy.updateMatrix();
    risers.setMatrixAt(row, dummy.matrix);

    dummy.position.set(x, treadY + 0.18, config.aisleZ + width / 2);
    dummy.scale.set(stepDepth * 0.72, 0.32, 0.08);
    dummy.updateMatrix();
    cheeks.setMatrixAt(row, dummy.matrix);
  }

  for (const mesh of [pads, risers, cheeks]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
  pivot.add(pads, risers, cheeks);
}

function seatColor(roll, config) {
  const weights = config.seatColorWeights;
  const stop = roll * (weights.crimson + weights.dark + weights.muted + weights.white);
  if (stop < weights.crimson) return config.crimson;
  if (stop < weights.crimson + weights.dark) return config.seatColorDark;
  if (stop < weights.crimson + weights.dark + weights.muted) return config.seatColorMuted;
  return config.seatColorWhite;
}

function mixHash(a, b, c, d, e) {
  let h = Math.imul(a + 1, 374761393)
    ^ Math.imul(b + 3, 668265263)
    ^ Math.imul(c + 5, 1274126177)
    ^ Math.imul(d + 7, 2246822519)
    ^ Math.imul(e + 11, 3266489917);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function sectionAisleWidth(index, config) {
  if (index % config.wideAisleEvery === config.wideAislePhase) return config.wideAisleWidth;
  if (index % config.aisleEvery === 1) return config.aisleWidth;
  return 0;
}

function sectionDividerZ(index, config) {
  if (index % config.dividerEvery !== config.dividerPhase) return null;
  return -config.sectionLength / 2 + config.dividerInset;
}

function createSeatGeometry(config, steps) {
  const radius = config.seatCornerRadius;
  const backT = Math.max(config.seatBackThickness, radius * 2);
  const backHeight = config.seatBaseHeight + config.seatBackHeight;

  const back = extrudeProfile(
    roundedBackProfile(backT, backHeight, radius, steps),
    config.seatWidth * 0.9,
  );
  back.rotateZ(-0.2);
  back.translate(config.seatDepth - backT * 0.85, 0, 0);

  const cushionDepth = Math.max(0.12, config.seatDepth - backT * 0.45);
  const cushion = extrudeProfile(
    cushionProfile(cushionDepth, config.seatBaseHeight * 1.2, radius * 0.75, steps),
    config.seatWidth * 0.96,
  );

  const seat = mergeGeometries([cushion, back]);
  cushion.dispose();
  back.dispose();
  seat.computeBoundingSphere();
  return seat;
}

function roundedBackProfile(thickness, height, radius, steps) {
  const crown = Math.min(radius, thickness * 0.5, height * 0.45);
  const spring = height - crown;
  const points = [
    [-thickness / 2, 0],
    [-thickness / 2, spring],
  ];
  for (let i = 1; i <= steps; i += 1) {
    const angle = Math.PI - (i / steps) * Math.PI;
    points.push([Math.cos(angle) * crown, spring + Math.sin(angle) * crown]);
  }
  points.push([thickness / 2, 0]);
  return points;
}

function cushionProfile(depth, height, radius, steps) {
  const lip = Math.min(Math.max(radius, 0.012), height * 0.85, depth * 0.4);
  const points = [
    [0, 0],
    [0, height - lip],
  ];
  for (let i = 1; i <= steps; i += 1) {
    const angle = Math.PI - (i / steps) * (Math.PI / 2);
    points.push([lip + Math.cos(angle) * lip, height - lip + Math.sin(angle) * lip]);
  }
  points.push([depth, height]);
  points.push([depth, 0]);
  return points;
}

function extrudeProfile(points, width) {
  const half = width / 2;
  const count = points.length;
  const positions = new Float32Array(count * 6);
  for (let i = 0; i < count; i += 1) {
    const [x, y] = points[i];
    positions[i * 6] = x;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = -half;
    positions[i * 6 + 3] = x;
    positions[i * 6 + 4] = y;
    positions[i * 6 + 5] = half;
  }

  const indices = [];
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count;
    const a = i * 2;
    const b = a + 1;
    const c = next * 2;
    const d = c + 1;
    indices.push(a, b, c, b, d, c);
  }
  for (let i = 1; i < count - 1; i += 1) {
    indices.push(0, (i + 1) * 2, i * 2);
    indices.push(1, i * 2 + 1, (i + 1) * 2 + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addDivider(pivot, sectionIndex, config, geometries, materials, layout) {
  const z = sectionDividerZ(sectionIndex, config);
  addDividerTier(pivot, z, config, geometries, materials, {
    originX: layout.lowerInner,
    depth: config.lowerTierDepth,
    startHeight: config.plinthHeight,
    endHeight: layout.lowerBackY,
    steps: config.lowerTierSteps,
  });
  addDividerTier(pivot, z, config, geometries, materials, {
    originX: layout.upperInner,
    depth: config.upperTierDepth,
    startHeight: layout.upperFrontY,
    endHeight: layout.upperBackY,
    steps: config.upperTierSteps,
  });

  const joint = new THREE.Mesh(geometries.unitBox, materials.concourseRiser);
  joint.position.set(
    layout.lowerOuter - config.concourseDepth * 0.2,
    layout.concourseTop - config.concourseHeight * 0.42,
    z,
  );
  joint.scale.set(config.concourseDepth * 0.85, config.concourseHeight * 0.82, config.dividerWidth);
  pivot.add(joint);
}

function addDividerTier(pivot, z, config, geometries, materials, tier) {
  const stepDepth = tier.depth / tier.steps;
  const stepRise = (tier.endHeight - tier.startHeight) / tier.steps;
  const ribs = new THREE.InstancedMesh(geometries.unitBox, materials.concourseRiser, tier.steps);
  const dummy = new THREE.Object3D();

  for (let row = 0; row < tier.steps; row += 1) {
    const treadY = tier.startHeight + (row + 1) * stepRise;
    dummy.position.set(tier.originX + (row + 0.5) * stepDepth, treadY + config.dividerRise / 2, z);
    dummy.scale.set(stepDepth * 1.04, config.dividerRise, config.dividerWidth);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    ribs.setMatrixAt(row, dummy.matrix);
  }

  ribs.instanceMatrix.needsUpdate = true;
  ribs.computeBoundingSphere();
  pivot.add(ribs);
}

function addEntrance(pivot, sectionIndex, config, geometries, materials, layout) {
  const z = sectionAisleWidth(sectionIndex, config) > 0 ? config.entranceOffset : 0;
  const frontX = layout.lowerOuter - config.concourseDepth * 0.2 - config.concourseDepth / 2;
  const fasciaTop = layout.concourseTop - config.concourseDeckThickness;
  const fasciaBottom = fasciaTop - (config.concourseHeight - config.concourseDeckThickness);
  const centerY = (fasciaTop + fasciaBottom) / 2;
  const height = Math.min(config.entranceHeight, (fasciaTop - fasciaBottom) * 0.9);
  const width = config.entranceWidth;
  const frame = config.entranceFrame;
  const frameX = frontX - 0.16;

  addScaledBox(pivot, geometries.unitBox, materials.tunnel, frontX - 0.05, centerY, z, 0.1, height, width);
  addScaledBox(
    pivot, geometries.unitBox, materials.concourseDeck,
    frameX, centerY + height / 2 + frame / 2, z,
    0.2, frame, width + frame * 2,
  );
  addScaledBox(
    pivot, geometries.unitBox, materials.concourseDeck,
    frontX - 0.34, centerY - height / 2 - frame / 2, z,
    0.62, 0.1, width + frame * 2,
  );
  for (const end of [-1, 1]) {
    addScaledBox(
      pivot, geometries.unitBox, materials.concourseDeck,
      frameX, centerY, z + end * (width / 2 + frame / 2),
      0.2, height, frame,
    );
    addScaledBox(
      pivot, geometries.unitBox, materials.concourseRiser,
      frontX - 0.04, centerY, z + end * (width / 2),
      0.1, height * 0.96, 0.07,
    );
  }
}

function addScaledBox(parent, geometry, material, x, y, z, sx, sy, sz) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}

// One shared mesh per bowl. Lower steps are solid down to the field.
// Upper steps are slabs, so the upper bowl does not become a wall in front of the lower one.
function createTierGeometry(length, depth, startHeight, endHeight, steps, sideColor, topColor, solid) {
  const stepDepth = depth / steps;
  const stepRise = (endHeight - startHeight) / steps;
  const pieces = [];

  for (let i = 0; i < steps; i += 1) {
    const treadY = startHeight + (i + 1) * stepRise;
    const height = solid ? treadY : stepRise + 0.14;
    const box = new THREE.BoxGeometry(stepDepth + 0.05, height, length);
    paintStep(box, height, sideColor, topColor);
    box.translate((i + 0.5) * stepDepth, solid ? height / 2 : treadY - height / 2, 0);
    pieces.push(box);
  }

  const merged = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  return merged;
}

function paintStep(box, height, sideColor, topColor) {
  const position = box.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const side = new THREE.Color(sideColor);
  const top = new THREE.Color(topColor);
  const topY = height / 2 - 0.001;

  for (let i = 0; i < position.count; i += 1) {
    const color = position.getY(i) >= topY ? top : side;
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  box.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}
