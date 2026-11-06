// Visual settings for the endless stadium. Distances are in the same world
// units as the runner. Forward is -Z; the world scrolls toward +Z.
// sectionLength matches the ground segment length in main.js so the field
// extension stays in phase with the existing lanes.
export const STADIUM_CONFIG = {
  sectionLength: 20,
  sectionCount: 10,

  fieldHalfWidth: 5,
  laneOffset: 1.5,
  laneWidth: 2.2,

  // Distance from the centerline to the front face of each grandstand.
  grandstandFront: 10.2,
  plinthDepth: 0.85,
  plinthHeight: 0.55,

  // Lower bowl: the larger deck. Rise is the back-edge height above the field.
  lowerTierDepth: 7.6,
  lowerTierRise: 3.85,
  lowerTierSteps: 7,

  // Gray walkway between the two bowls. Height is how far it stands above the lower deck.
  concourseDepth: 2.35,
  concourseHeight: 0.85,

  // Upper bowl: behind the walkway, shorter in depth, steeper in rise.
  upperTierDepth: 5.4,
  upperTierRise: 4.1,
  upperTierSteps: 5,
  upperTierStep: 0.28,

  seatTread: '#a32036',
  seatAccent: '#f3f0ea',

  // Seating sits on the existing steps. Row interval is the step depth.
  seatWidth: 0.36,
  seatDepth: 0.34,
  seatBaseHeight: 0.05,
  seatBackHeight: 0.32,
  seatBackThickness: 0.07,
  seatCornerRadius: 0.058,
  seatBevelSegments: 4,
  seatSpacing: 0.5,
  seatRowInset: 0.66,
  seatLift: 0.03,
  seatColorDark: '#751527',
  seatColorMuted: '#C45A68',
  seatColorWhite: '#F0E9E5',
  seatColorWeights: { crimson: 70, dark: 15, muted: 10, white: 5 },

  aisleEvery: 3,
  aisleWidth: 1.55,
  aisleZ: 0,
  wideAisleEvery: 5,
  wideAislePhase: 0,
  wideAisleWidth: 2.65,

  // Concrete ribs on a repeating section, inset from the far edge.
  dividerEvery: 4,
  dividerPhase: 2,
  dividerWidth: 0.5,
  dividerInset: 1.2,
  dividerRise: 0.7,

  // Framed openings in the concourse fascia. Offset when an aisle shares the section.
  entranceEvery: 5,
  entrancePhase: 2,
  entranceWidth: 2.3,
  entranceHeight: 0.52,
  entranceRecess: 0.22,
  entranceFrame: 0.14,
  entranceOffset: 6.3,
  tunnel: '#151a21',

  // Camera Z matches the runner camera in main.js. Used only to choose seat detail.
  lodCameraZ: 3,
  seatDetailDistance: 46,
  seatSimpleDistance: 64,

  concourseDeckThickness: 0.16,
  concourseDeck: '#d7dde3',
  concourseRiser: '#8d969e',

  // Every fourth 20-unit section, so towers sit 80 units apart.
  floodlightEvery: 4,
  lightZShift: 6.5,
  lightPoleHeight: 7.4,
  lightPoleRadius: 0.4,
  lightArmLength: 1.7,
  bulbCols: 9,
  bulbRows: 5,
  bulbRadius: 0.26,
  bulbGap: 0.16,
  framePadding: 0.38,
  frameBar: 0.16,
  frameDepth: 0.2,
  lightHousingDepth: 0.5,
  lightTilt: 0.4,
  lightYaw: 1.18,
  lightFrame: '#303845',
  lightHousing: '#48515E',
  lightPole: '#2a313c',

  // One board in the loop, on a section without a floodlight.
  // Clearance is the gap from the upper-deck rim to the board. Column height
  // is derived from that rim down to the ground foundation, so the masts
  // are not left floating.
  scoreboardEvery: 10,
  scoreboardPhase: 3,
  scoreboardWidth: 15.6,
  scoreboardHeight: 6.4,
  scoreboardFrame: 0.72,
  scoreboardLip: 0.13,
  scoreboardDepth: 0.95,
  scoreboardFrameDepth: 0.55,
  scoreboardInset: 0.16,
  scoreboardClearance: 1.6,
  scoreboardGap: 0.55,
  scoreboardYaw: -0.48,
  scoreboardColumnRadius: 0.48,
  scoreboardColumnInset: 0.95,
  scoreboardFoundation: 0.4,
  scoreFrame: '#26303D',
  scoreHousing: '#39424F',
  scoreSupport: '#606B78',
  scoreBevel: '#4a5563',

  // Fog matches the horizon. Near distance stays beyond the next obstacles.
  fogColor: '#B7E3F7',
  fogNear: 92,
  fogFar: 220,

  skyZenith: '#3E86C9',
  skyMid: '#6BB4EF',
  skyHorizon: '#B7E3F7',
  // Elevation stops on the sky sphere, 0 at the horizon and 1 overhead.
  // The gameplay view only reaches about 0.6, so the deep blue stays near the top.
  skyHorizonStop: 0.48,
  skyZenithStop: 0.9,

  cloudScale: 1,
  cloudOpacity: 1,
  cloudSpeed: 0,
  cloudWrap: 80,
  cloudTop: '#FFFEFF',
  cloudBottom: '#A9C4DA',
  clouds: [
    { x: -20, y: 17.5, z: -32, scale: 3.8 },
    { x: 23, y: 19.5, z: -46, scale: 4.3 },
    { x: -6, y: 26, z: -68, scale: 2.5 },
    { x: 12, y: 16.5, z: -24, scale: 2.1 },
    { x: -32, y: 18, z: -54, scale: 2.9 },
  ],

  hemiSky: '#e7f2ff',
  hemiGround: '#8fa08a',
  hemiIntensity: 1.2,
  sunColor: '#fff5e6',
  sunIntensity: 1.5,
  sunX: 8,
  sunY: 22,
  sunZ: 5,

  crimson: '#9E1B32',
  concrete: '#aeb6be',
  concourse: '#c5ccd4',
  metal: '#e7ecf0',
  lane: 0x8d8d8d,
};
