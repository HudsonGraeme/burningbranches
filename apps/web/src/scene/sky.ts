import * as THREE from 'three';
import { ATMOSPHERE } from './atmosphere.js';

const VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uHaze;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;

  varying vec3 vDirection;

  void main() {
    vec3 dir = normalize(vDirection);
    float height = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

    // Two stops plus a low band of smoke haze, which is what sells the horizon.
    vec3 sky = mix(uHorizon, uZenith, pow(height, 0.9));
    float haze = pow(1.0 - clamp(abs(dir.y) * 3.2, 0.0, 1.0), 2.2);
    sky = mix(sky, uHaze, haze * 0.55);

    float sun = max(dot(dir, normalize(uSunDirection)), 0.0);
    sky += uSunColor * pow(sun, 220.0) * 3.0;
    sky += uSunColor * pow(sun, 12.0) * 0.28;

    gl_FragColor = vec4(sky, 1.0);
  }
`;

export interface SkyHandle {
  mesh: THREE.Mesh;
  dispose: () => void;
}

export function buildSky(): SkyHandle {
  const geometry = new THREE.SphereGeometry(9000, 32, 20);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      uZenith: { value: ATMOSPHERE.skyZenith.clone() },
      uHorizon: { value: ATMOSPHERE.skyHorizon.clone() },
      uHaze: { value: ATMOSPHERE.skyHaze.clone() },
      uSunDirection: { value: ATMOSPHERE.sunDirection.clone() },
      uSunColor: { value: ATMOSPHERE.sunColor.clone() },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;

  return {
    mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
