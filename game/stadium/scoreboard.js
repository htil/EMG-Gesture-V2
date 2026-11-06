import * as THREE from 'three';

export function createScoreboardGeometries(config, layout) {
  const metrics = scoreboardMetrics(config, layout);
  const frame = config.scoreboardFrame;
  const lip = config.scoreboardLip;
  const beamLength = metrics.width - config.scoreboardColumnInset * 2 + config.scoreboardColumnRadius * 2;
  return {
    boardHousing: new THREE.BoxGeometry(metrics.width, metrics.height, config.scoreboardDepth),
    boardFrameH: new THREE.BoxGeometry(metrics.width, frame, config.scoreboardFrameDepth),
    boardFrameV: new THREE.BoxGeometry(frame, metrics.height - frame * 2, config.scoreboardFrameDepth),
    boardLipH: new THREE.BoxGeometry(metrics.displayW + lip * 2, lip, 0.22),
    boardLipV: new THREE.BoxGeometry(lip, metrics.displayH, 0.22),
    boardBevelH: new THREE.BoxGeometry(metrics.width + 0.08, 0.1, 0.1),
    boardDisplay: new THREE.PlaneGeometry(metrics.displayW, metrics.displayH),
    boardBeam: new THREE.BoxGeometry(beamLength, 0.42, 0.5),
    boardColumn: new THREE.CylinderGeometry(
      config.scoreboardColumnRadius,
      config.scoreboardColumnRadius * 1.08,
      metrics.columnHeight,
      10,
    ),
    boardBrace: new THREE.BoxGeometry(0.28, 1, 0.28),
  };
}

export function addScoreboard(section, config, geometries, materials, layout) {
  const metrics = scoreboardMetrics(config, layout);
  const { yaw, cos, sin, width, height, boardX, boardY, boardBottom, beamDrop } = metrics;
  const frame = config.scoreboardFrame;
  const lip = config.scoreboardLip;
  const frameDepth = config.scoreboardFrameDepth;
  const housingZ = -config.scoreboardDepth * 0.32;

  const board = new THREE.Group();
  board.position.set(boardX, boardY, 0);
  board.rotation.y = yaw;

  const housing = new THREE.Mesh(geometries.boardHousing, materials.boardHousing);
  housing.position.z = -config.scoreboardDepth / 2;

  const frameZ = frameDepth / 2;
  const frameTop = new THREE.Mesh(geometries.boardFrameH, materials.boardFrame);
  frameTop.position.set(0, height / 2 - frame / 2, frameZ);
  const frameBottom = frameTop.clone();
  frameBottom.position.y = -frameTop.position.y;
  const frameLeft = new THREE.Mesh(geometries.boardFrameV, materials.boardFrame);
  frameLeft.position.set(-width / 2 + frame / 2, 0, frameZ);
  const frameRight = frameLeft.clone();
  frameRight.position.x = -frameLeft.position.x;

  const lipZ = frameDepth - 0.14;
  const lipTop = new THREE.Mesh(geometries.boardLipH, materials.boardBevel);
  lipTop.position.set(0, height / 2 - frame - lip / 2, lipZ);
  const lipBottom = lipTop.clone();
  lipBottom.position.y = -lipTop.position.y;
  const lipLeft = new THREE.Mesh(geometries.boardLipV, materials.boardBevel);
  lipLeft.position.set(-width / 2 + frame + lip / 2, 0, lipZ);
  const lipRight = lipLeft.clone();
  lipRight.position.x = -lipLeft.position.x;

  const bevelTop = new THREE.Mesh(geometries.boardBevelH, materials.boardBevel);
  bevelTop.position.set(0, height / 2 - 0.05, frameDepth - 0.04);
  const bevelBottom = bevelTop.clone();
  bevelBottom.position.y = -bevelTop.position.y;

  const display = new THREE.Mesh(geometries.boardDisplay, materials.scoreDisplay);
  display.name = 'scoreboard-display';
  display.position.z = frameDepth - config.scoreboardInset;

  const beam = new THREE.Mesh(geometries.boardBeam, materials.boardSupport);
  beam.position.set(0, -height / 2 - beamDrop, housingZ);

  board.add(
    housing,
    frameTop,
    frameBottom,
    frameLeft,
    frameRight,
    lipTop,
    lipBottom,
    lipLeft,
    lipRight,
    bevelTop,
    bevelBottom,
    display,
    beam,
  );
  section.add(board);

  const localX = width / 2 - config.scoreboardColumnInset;
  const columns = [-localX, localX].map((x) => ({
    x: boardX + x * cos + housingZ * sin,
    z: -x * sin + housingZ * cos,
  }));

  for (const column of columns) {
    const mast = new THREE.Mesh(geometries.boardColumn, materials.boardSupport);
    mast.position.set(
      column.x,
      metrics.foundationTop + metrics.columnHeight / 2,
      column.z,
    );
    addScaledBox(
      section, geometries.unitBox, materials.wall,
      column.x, metrics.foundationTop + 0.1, column.z,
      1.35, 0.22, 1.35,
    );
    section.add(mast);
  }

  const spanX = columns[1].x - columns[0].x;
  const spanZ = columns[1].z - columns[0].z;
  const foundation = new THREE.Mesh(geometries.unitBox, materials.wall);
  foundation.position.set(
    (columns[0].x + columns[1].x) / 2,
    metrics.foundationTop / 2,
    (columns[0].z + columns[1].z) / 2,
  );
  foundation.rotation.y = Math.atan2(spanZ, spanX);
  foundation.scale.set(Math.hypot(spanX, spanZ) + 1.8, metrics.foundationTop, 1.7);
  section.add(foundation);

  const anchor = columns[0].x < columns[1].x ? columns[0] : columns[1];
  const capOuter = layout.upperOuter + 0.12;
  addScaledBox(
    section, geometries.unitBox, materials.wall,
    (capOuter + anchor.x) / 2, layout.upperBackY + 0.22, anchor.z,
    Math.max(0.2, anchor.x - capOuter), 0.4, 0.5,
  );

  const mount = {
    x: boardX + (-config.scoreboardDepth * 0.55) * sin,
    y: boardBottom - 0.04,
    z: (-config.scoreboardDepth * 0.55) * cos,
  };
  for (const column of columns) {
    const brace = new THREE.Mesh(geometries.boardBrace, materials.boardSupport);
    placeStrut(
      brace,
      { x: column.x, y: layout.upperBackY - 1.6, z: column.z },
      {
        x: mount.x * 0.45 + column.x * 0.55,
        y: mount.y,
        z: mount.z * 0.45 + column.z * 0.55,
      },
    );
    section.add(brace);
  }
}

function scoreboardMetrics(config, layout) {
  const yaw = config.scoreboardYaw;
  const width = config.scoreboardWidth;
  const height = config.scoreboardHeight;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const inward = (width / 2) * Math.abs(cos) + config.scoreboardFrameDepth * Math.abs(sin);
  const boardX = layout.upperOuter + config.scoreboardGap + inward;
  const boardBottom = layout.upperBackY + config.scoreboardClearance;
  const beamDrop = 0.16;
  const foundationTop = config.scoreboardFoundation;
  const columnTop = boardBottom - beamDrop;
  return {
    yaw,
    cos,
    sin,
    width,
    height,
    boardX,
    boardY: boardBottom + height / 2,
    boardBottom,
    beamDrop,
    foundationTop,
    columnTop,
    columnHeight: columnTop - foundationTop,
    displayW: width - config.scoreboardFrame * 2 - config.scoreboardLip * 2,
    displayH: height - config.scoreboardFrame * 2 - config.scoreboardLip * 2,
  };
}

function placeStrut(mesh, from, to) {
  const delta = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
  const length = delta.length();
  mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  mesh.scale.set(1, length, 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.multiplyScalar(1 / length));
}

function addScaledBox(parent, geometry, material, x, y, z, sx, sy, sz) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}
