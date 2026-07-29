import * as THREE from 'three';
import { mulberry32, type BiomeManifest } from '@burningbranches/schema';
import { sampleHeight, type Field } from './field.js';

const MAX_EMBERS = 26_000;
const MAX_SMOKE = 9_000;

export interface FireHandle {
  objects: THREE.Points[];
  update: (time: number) => void;
  dispose: () => void;
}

const EMBER_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aSpeed;
  attribute float aRise;
  attribute float aSize;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vLife;
  varying float vSeed;

  void main() {
    float life = fract(uTime * aSpeed + aSeed);
    vLife = life;
    vSeed = aSeed;

    vec3 offset = position;
    offset.y += life * aRise;
    // Drift widens as the ember cools and climbs, so columns fan out instead of rising flat.
    float drift = life * life * aRise * 0.42;
    offset.x += sin(uTime * 1.6 + aSeed * 41.0) * drift;
    offset.z += cos(uTime * 1.27 + aSeed * 27.0) * drift;

    vec4 mv = modelViewMatrix * vec4(offset, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (1.0 - life * 0.55) * (260.0 / max(-mv.z, 1.0));
  }
`;

const EMBER_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uHot;
  uniform vec3 uCool;
  varying float vLife;
  varying float vSeed;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv);
    if (d > 0.25) discard;
    float core = smoothstep(0.25, 0.0, d);
    float flicker = 0.7 + 0.3 * sin(vSeed * 60.0 + vLife * 30.0);
    vec3 color = mix(uHot, uCool, vLife);
    gl_FragColor = vec4(color * flicker, core * (1.0 - vLife) * 0.9);
  }
`;

const SMOKE_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uSmoke;
  varying float vLife;
  varying float vSeed;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv);
    if (d > 0.25) discard;
    float soft = smoothstep(0.25, 0.02, d);
    float fade = sin(vLife * 3.14159);
    gl_FragColor = vec4(uSmoke * (0.7 + vSeed * 0.3), soft * fade * 0.16);
  }
`;

export function buildFire(manifest: BiomeManifest, field: Field): FireHandle {
  const embers = collect(manifest, field, 'ember');
  const smoke = collect(manifest, field, 'smoke');

  const objects: THREE.Points[] = [];
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
  };

  if (embers.count > 0) {
    const material = new THREE.ShaderMaterial({
      vertexShader: EMBER_VERTEX,
      fragmentShader: EMBER_FRAGMENT,
      uniforms: {
        ...uniforms,
        uHot: { value: new THREE.Color(0xffd08a) },
        uCool: { value: new THREE.Color(0xd83a12) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(embers.geometry, material);
    points.frustumCulled = false;
    objects.push(points);
    disposables.push(embers.geometry, material);
  }

  if (smoke.count > 0) {
    const material = new THREE.ShaderMaterial({
      vertexShader: EMBER_VERTEX,
      fragmentShader: SMOKE_FRAGMENT,
      uniforms: {
        ...uniforms,
        uSmoke: { value: new THREE.Color(0x8e8b86) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const points = new THREE.Points(smoke.geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 2;
    objects.push(points);
    disposables.push(smoke.geometry, material);
  }

  return {
    objects,
    update: (time) => {
      uniforms.uTime.value = time;
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    },
  };
}

function collect(
  manifest: BiomeManifest,
  field: Field,
  kind: 'ember' | 'smoke',
): { geometry: THREE.BufferGeometry; count: number } {
  const budget = kind === 'ember' ? MAX_EMBERS : MAX_SMOKE;
  const positions: number[] = [];
  const seeds: number[] = [];
  const speeds: number[] = [];
  const rises: number[] = [];
  const sizes: number[] = [];

  const sources = manifest.plots.filter((plot) =>
    kind === 'ember' ? plot.biome.fire > 0.04 : plot.biome.fire > 0.02 || plot.biome.burn > 0.45,
  );
  const demand = sources.reduce(
    (sum, plot) => sum + intensity(plot.biome.fire, plot.biome.burn, plot.rect[2] * plot.rect[3], kind),
    0,
  );
  const thinning = demand > budget ? budget / demand : 1;

  for (const plot of sources) {
    const wanted = Math.round(
      intensity(plot.biome.fire, plot.biome.burn, plot.rect[2] * plot.rect[3], kind) * thinning,
    );
    if (wanted <= 0) continue;
    const random = mulberry32(plot.id * 40503 + (kind === 'ember' ? 1 : 7));
    const [rx, rz, rw, rh] = plot.rect;

    for (let i = 0; i < wanted; i++) {
      const x = rx + random() * rw;
      const z = rz + random() * rh;
      positions.push(x, sampleHeight(field, x, z) + 0.2, z);
      seeds.push(random());
      if (kind === 'ember') {
        speeds.push(0.13 + random() * 0.22);
        rises.push(9 + random() * 26);
        sizes.push(1.4 + random() * 2.6);
      } else {
        speeds.push(0.035 + random() * 0.05);
        rises.push(38 + random() * 70);
        sizes.push(14 + random() * 26);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speeds, 1));
  geometry.setAttribute('aRise', new THREE.Float32BufferAttribute(rises, 1));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  return { geometry, count: seeds.length };
}

function intensity(fire: number, burn: number, area: number, kind: 'ember' | 'smoke'): number {
  const hectares = area / 10_000;
  return kind === 'ember'
    ? Math.round(hectares * 5200 * fire)
    : Math.round(hectares * 900 * Math.max(fire, burn * 0.35));
}
