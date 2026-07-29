import * as THREE from 'three';

/**
 * One palette drives the sky dome, the distance fog and the terrain's lighting terms. When
 * these drift apart the map reads as a slab floating in a void instead of a landscape, so
 * every consumer reads from here rather than carrying its own constants.
 */
export const ATMOSPHERE = {
  sunDirection: new THREE.Vector3(0.38, 0.42, 0.32).normalize(),
  sunColor: new THREE.Color(0xffd7a0),
  skyZenith: new THREE.Color(0x24405e),
  skyHorizon: new THREE.Color(0xb08155),
  skyHaze: new THREE.Color(0xd9a878),
  fog: new THREE.Color(0x8d7358),
  bounce: new THREE.Color(0x2b2318),
  ember: new THREE.Color(0xff6a1e),
  fogNear: 520,
  fogFar: 2600,
  exposure: 1.12,
} as const;
