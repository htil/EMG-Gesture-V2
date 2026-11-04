import * as THREE from 'three';

export function createFieldGeometries(config) {
  const length = config.sectionLength;
  return {
    grass: new THREE.PlaneGeometry((config.grandstandFront + 1.1) * 2, length),
    lane: new THREE.PlaneGeometry(config.laneWidth, length),
  };
}

export function addField(section, config, geometries, materials) {
  const grass = new THREE.Mesh(geometries.grass, materials.grass);
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = 0;
  section.add(grass);

  for (const x of [-config.laneOffset, config.laneOffset]) {
    const lane = new THREE.Mesh(geometries.lane, materials.lane);
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(x, 0.02, 0);
    section.add(lane);
  }
}
