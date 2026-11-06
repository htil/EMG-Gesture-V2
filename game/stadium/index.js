import * as THREE from 'three';
import { STADIUM_CONFIG } from './config.js';
import { grandstandLayout } from './layout.js';
import { assignSurfaceTexture, createMaterials } from './materials.js';
import { createFieldGeometries, addField } from './field.js';
import { createStandGeometries, addStand, updateSeatDetail } from './stands.js';
import { createLightGeometries, addFloodlight } from './lights.js';
import { createScoreboardGeometries, addScoreboard } from './scoreboard.js';
import { applyAtmosphere, createBackdrop } from './sky.js';

export { STADIUM_CONFIG } from './config.js';

export function createStadium(scene) {
  const config = STADIUM_CONFIG;
  applyAtmosphere(scene, config);

  const materials = createMaterials(config);
  const layout = grandstandLayout(config);
  const geometries = {
    layout,
    unitBox: new THREE.BoxGeometry(1, 1, 1),
    ...createFieldGeometries(config),
    ...createStandGeometries(config, layout),
    ...createLightGeometries(config),
    ...createScoreboardGeometries(config, layout),
  };
  const sections = [];

  for (let index = 0; index < config.sectionCount; index += 1) {
    const section = createSection(index, config, geometries, materials);
    section.position.z = -index * config.sectionLength;
    scene.add(section);
    sections.push(section);
  }

  const backdrop = createBackdrop(config, materials);
  scene.add(backdrop);
  const clouds = backdrop.userData.clouds;
  let cloudTime = performance.now();

  return {
    advance(distance) {
      if (config.cloudSpeed !== 0 && clouds) {
        const now = performance.now();
        const delta = Math.min(0.05, (now - cloudTime) / 1000);
        cloudTime = now;
        clouds.position.x += config.cloudSpeed * delta;
        const limit = config.cloudWrap;
        if (clouds.position.x > limit) clouds.position.x = -limit;
        else if (clouds.position.x < -limit) clouds.position.x = limit;
      }
      const span = config.sectionLength * config.sectionCount;
      for (const section of sections) {
        section.position.z += distance;
        while (section.position.z > config.sectionLength) {
          section.position.z -= span;
        }
        updateSeatDetail(section, config);
      }
    },
    reset() {
      for (let index = 0; index < sections.length; index += 1) {
        sections[index].position.z = -index * config.sectionLength;
      }
    },
    setScoreboardLogo(texture) {
      assignSurfaceTexture(materials.scoreDisplay, texture);
    },
  };
}

function createSection(index, config, geometries, materials) {
  const section = new THREE.Group();
  section.name = `stadium-section-${index}`;
  const { layout } = geometries;

  addField(section, config, geometries, materials);
  addStand(section, 1, index, config, geometries, materials, layout);
  addStand(section, -1, index, config, geometries, materials, layout);

  if (index % config.floodlightEvery === 0) {
    const along = ((index / config.floodlightEvery) % 2 === 0 ? -1 : 1) * config.lightZShift;
    addFloodlight(section, 1, along, config, geometries, materials, layout);
    addFloodlight(section, -1, along, config, geometries, materials, layout);
  }

  if (index % config.scoreboardEvery === config.scoreboardPhase) {
    addScoreboard(section, config, geometries, materials, layout);
  }

  return section;
}
