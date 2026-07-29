import * as THREE from 'three';
import { ATMOSPHERE } from './atmosphere.js';
import { sampleHeight, type Field } from './field.js';

const SEGMENTS = 384;

export interface TerrainHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  dispose: () => void;
}

const VERTEX = /* glsl */ `
  attribute float aBurn;
  attribute float aFire;
  attribute float aPlot;
  uniform float uSelected;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vBurn;
  varying float vFire;
  varying float vSelect;

  void main() {
    vColor = color;
    vNormal = normalize(normalMatrix * normal);
    vBurn = aBurn;
    vFire = aFire;

    // Binary per vertex, but interpolated across the triangle, which hands the fragment
    // stage a free soft band exactly along the selected plot's border.
    vSelect = abs(aPlot - uSelected) < 0.5 ? 1.0 : 0.0;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uFogColor;
  uniform vec3 uEmberColor;
  uniform vec3 uHighlight;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uTime;

  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vBurn;
  varying float vFire;
  varying float vSelect;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec3 normal = normalize(vNormal);
    float diffuse = max(dot(normal, uSunDirection), 0.0);

    // Hemisphere fill keeps the shaded sides readable without a second light.
    float sky = normal.y * 0.5 + 0.5;
    vec3 ambient = mix(uGroundColor, uSkyColor, sky);

    vec3 albedo = mix(vColor, vColor * 0.34, vBurn);
    vec3 lit = albedo * (ambient + uSunColor * diffuse);

    // Embers breathe out of the char rather than sitting as a flat glow.
    float flicker = 0.55 + 0.45 * sin(uTime * 5.0 + hash(floor(vWorld.xz * 0.6)) * 40.0);
    lit += uEmberColor * vFire * flicker * 1.4;
    lit += uEmberColor * vBurn * 0.06;

    // Selected ground lifts, and the interpolated band along its border becomes a rim.
    float rim = smoothstep(0.08, 0.5, vSelect) * (1.0 - smoothstep(0.5, 0.92, vSelect));
    float pulse = 0.75 + 0.25 * sin(uTime * 3.0);
    lit = mix(lit, lit * 1.35 + uHighlight * 0.16, vSelect * 0.75);
    lit += uHighlight * rim * 1.6 * pulse;

    float depth = length(vWorld - cameraPosition);
    float fogAmount = smoothstep(uFogNear, uFogFar, depth);
    gl_FragColor = vec4(mix(lit, uFogColor, fogAmount), 1.0);
  }
`;

export function buildTerrain(field: Field): TerrainHandle {
  const world = field.world;
  const step = world / SEGMENTS;
  const width = SEGMENTS + 1;
  const count = width * width;

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const burn = new Float32Array(count);
  const fire = new Float32Array(count);
  const plot = new Float32Array(count);

  for (let z = 0; z < width; z++) {
    for (let x = 0; x < width; x++) {
      const i = z * width + x;
      const wx = x * step;
      const wz = z * step;
      positions[i * 3] = wx;
      positions[i * 3 + 1] = sampleHeight(field, wx, wz);
      positions[i * 3 + 2] = wz;

      const gi = cellIndex(field, wx, wz);
      colors[i * 3] = field.red[gi]!;
      colors[i * 3 + 1] = field.green[gi]!;
      colors[i * 3 + 2] = field.blue[gi]!;
      burn[i] = field.burn[gi]!;
      fire[i] = field.fire[gi]!;
      plot[i] = field.plotId[gi]!;
    }
  }

  const indices = new Uint32Array(SEGMENTS * SEGMENTS * 6);
  let cursor = 0;
  for (let z = 0; z < SEGMENTS; z++) {
    for (let x = 0; x < SEGMENTS; x++) {
      const a = z * width + x;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aBurn', new THREE.BufferAttribute(burn, 1));
  geometry.setAttribute('aFire', new THREE.BufferAttribute(fire, 1));
  geometry.setAttribute('aPlot', new THREE.BufferAttribute(plot, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    vertexColors: true,
    uniforms: {
      uSunDirection: { value: ATMOSPHERE.sunDirection.clone() },
      uSunColor: { value: ATMOSPHERE.sunColor.clone().multiplyScalar(1.05) },
      uSkyColor: { value: ATMOSPHERE.skyZenith.clone().multiplyScalar(0.55) },
      uGroundColor: { value: ATMOSPHERE.bounce.clone() },
      uFogColor: { value: ATMOSPHERE.fog.clone() },
      uEmberColor: { value: ATMOSPHERE.ember.clone() },
      uHighlight: { value: new THREE.Color(0x8fd4ff) },
      uSelected: { value: -1 },
      uFogNear: { value: ATMOSPHERE.fogNear },
      uFogFar: { value: ATMOSPHERE.fogFar },
      uTime: { value: 0 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = 'terrain';

  return {
    mesh,
    material,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

function cellIndex(field: Field, x: number, z: number): number {
  const scale = field.grid / field.world;
  const gx = Math.min(field.grid - 1, Math.max(0, Math.floor(x * scale)));
  const gz = Math.min(field.grid - 1, Math.max(0, Math.floor(z * scale)));
  return gz * field.grid + gx;
}
