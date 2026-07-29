import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  DEAD_SPECIES,
  SPECIES,
  hashUnit,
  mulberry32,
  speciesIndexForPath,
  type BiomeManifest,
  type Plot,
  type Species,
} from '@burningbranches/schema';
import { plotIdAt, sampleHeight, type Field } from './field.js';

/** Ceiling on planted instances. Beyond this the frame budget, not the data, is the limit. */
const MAX_TREES = 90_000;

export interface TreeHandle {
  meshes: THREE.InstancedMesh[];
  materials: THREE.Material[];
  dispose: () => void;
}

function painted(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  const count = flat.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return flat;
}

function place(
  geometry: THREE.BufferGeometry,
  y: number,
  scale?: [number, number, number],
): THREE.BufferGeometry {
  if (scale) geometry.scale(scale[0], scale[1], scale[2]);
  geometry.translate(0, y, 0);
  return geometry;
}

/** Every silhouette is authored at unit height so an instance's scale is its metre height. */
function coniferGeometry(species: Species): THREE.BufferGeometry {
  const parts = [
    painted(place(new THREE.CylinderGeometry(0.022, 0.038, 0.3, 6), 0.15), species.trunk),
    painted(place(new THREE.ConeGeometry(0.2, 0.42, 7), 0.36), species.foliage),
    painted(place(new THREE.ConeGeometry(0.155, 0.36, 7), 0.6), species.foliage),
    painted(place(new THREE.ConeGeometry(0.1, 0.3, 7), 0.83), species.foliage),
  ];
  return mergeGeometries(parts, false)!;
}

function broadleafGeometry(species: Species): THREE.BufferGeometry {
  const parts = [
    painted(place(new THREE.CylinderGeometry(0.035, 0.06, 0.5, 6), 0.25), species.trunk),
    painted(
      place(new THREE.IcosahedronGeometry(0.3, 0), 0.72, [1.05, 0.82, 1.05]),
      species.foliage,
    ),
    painted(
      place(new THREE.IcosahedronGeometry(0.19, 0), 0.55, [1, 0.9, 1]),
      species.foliage,
    ),
  ];
  return mergeGeometries(parts, false)!;
}

function birchGeometry(species: Species): THREE.BufferGeometry {
  const parts = [
    painted(place(new THREE.CylinderGeometry(0.018, 0.028, 0.66, 6), 0.33), species.trunk),
    painted(
      place(new THREE.IcosahedronGeometry(0.2, 0), 0.76, [0.8, 1.25, 0.8]),
      species.foliage,
    ),
  ];
  return mergeGeometries(parts, false)!;
}

function palmGeometry(species: Species): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    painted(place(new THREE.CylinderGeometry(0.024, 0.05, 0.78, 6), 0.39), species.trunk),
  ];
  for (let i = 0; i < 6; i++) {
    const frond = new THREE.ConeGeometry(0.07, 0.42, 4);
    frond.scale(1, 1, 0.28);
    frond.rotateZ(Math.PI * 0.42);
    frond.rotateY((i / 6) * Math.PI * 2);
    frond.translate(0, 0.8, 0);
    parts.push(painted(frond, species.foliage));
  }
  return mergeGeometries(parts, false)!;
}

function snagGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    painted(place(new THREE.CylinderGeometry(0.012, 0.05, 0.8, 6), 0.4), DEAD_SPECIES.trunk),
  ];
  for (let i = 0; i < 2; i++) {
    const branch = new THREE.CylinderGeometry(0.006, 0.014, 0.22, 5);
    branch.rotateZ(i === 0 ? 0.9 : -1.05);
    branch.translate(i === 0 ? 0.07 : -0.08, 0.52 + i * 0.14, 0);
    parts.push(painted(branch, DEAD_SPECIES.trunk));
  }
  return mergeGeometries(parts, false)!;
}

function geometryFor(index: number): THREE.BufferGeometry {
  const species = SPECIES[index]!;
  switch (species.canopy) {
    case 'conifer':
      return coniferGeometry(species);
    case 'broadleaf':
      return broadleafGeometry(species);
    case 'birch':
      return birchGeometry(species);
    default:
      return palmGeometry(species);
  }
}

interface Instance {
  x: number;
  y: number;
  z: number;
  height: number;
  rotation: number;
  tint: number;
}

export function buildTrees(manifest: BiomeManifest, field: Field): TreeHandle {
  const buckets: Instance[][] = SPECIES.map(() => []);
  const snags: Instance[] = [];

  const projected = manifest.plots.reduce((sum, plot) => sum + plannedCount(plot), 0);
  const thinning = projected > MAX_TREES ? MAX_TREES / projected : 1;

  for (const plot of manifest.plots) {
    const count = Math.round(plannedCount(plot) * thinning);
    if (count <= 0) continue;

    const charred = !plot.metrics.alive || plot.biome.burn > 0.3;
    const speciesIndex = speciesIndexForPath(plot.path);
    const target = charred ? snags : buckets[speciesIndex]!;
    scatter(plot, count, field, target, charred);
  }

  const meshes: THREE.InstancedMesh[] = [];
  const materials: THREE.Material[] = [];

  for (let i = 0; i < buckets.length; i++) {
    const instances = buckets[i]!;
    if (instances.length === 0) continue;
    const mesh = instanceMesh(geometryFor(i), instances, materials);
    meshes.push(mesh);
  }
  if (snags.length > 0) {
    meshes.push(instanceMesh(snagGeometry(), snags, materials, true));
  }

  return {
    meshes,
    materials,
    dispose: () => {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
      for (const material of materials) material.dispose();
    },
  };
}

function plannedCount(plot: Plot): number {
  if (plot.biome.density < 0.04 || plot.biome.treeHeight < 0.35) return 0;
  const species = plot.metrics.alive ? SPECIES[speciesIndexForPath(plot.path)]! : DEAD_SPECIES;
  const hectares = (plot.rect[2] * plot.rect[3]) / 10_000;
  return Math.min(400, Math.round(hectares * species.stemsPerHa * plot.biome.density));
}

function scatter(
  plot: Plot,
  count: number,
  field: Field,
  out: Instance[],
  charred: boolean,
): void {
  const [rx, rz, rw, rh] = plot.rect;
  const random = mulberry32(plot.id * 2654435761);

  // A jittered grid keeps stems apart the way real spacing competition would, without the
  // cost of a full Poisson disc pass over a hundred thousand trees.
  const columns = Math.max(1, Math.round(Math.sqrt((count * rw) / Math.max(rh, 0.001))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const cellW = rw / columns;
  const cellH = rh / rows;

  let planted = 0;
  for (let row = 0; row < rows && planted < count; row++) {
    for (let column = 0; column < columns && planted < count; column++) {
      const x = rx + (column + 0.15 + random() * 0.7) * cellW;
      const z = rz + (row + 0.15 + random() * 0.7) * cellH;

      // The ground boundaries are warped, so a stem sitting inside the raw rectangle can
      // still land on a neighbour's soil. Drop those rather than have species bleed across.
      if (plotIdAt(field, x, z) !== plot.id) continue;

      const variation = 0.68 + random() * 0.62;
      out.push({
        x,
        y: sampleHeight(field, x, z) - 0.15,
        z,
        height: Math.max(0.3, plot.biome.treeHeight * variation),
        rotation: random() * Math.PI * 2,
        tint: charred ? 0.82 + random() * 0.3 : 0.78 + random() * 0.44,
      });
      planted++;
    }
  }
}

function instanceMesh(
  geometry: THREE.BufferGeometry,
  instances: Instance[],
  materials: THREE.Material[],
  charred = false,
): THREE.InstancedMesh {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
  });
  patchWind(material, charred);
  materials.push(material);

  const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  const axis = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i]!;
    position.set(instance.x, instance.y, instance.z);
    quaternion.setFromAxisAngle(axis, instance.rotation);
    const girth = instance.height * (0.9 + hashUnit(String(i), 3) * 0.25);
    scale.set(girth, instance.height, girth);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
    color.setScalar(instance.tint);
    mesh.setColorAt(i, color);
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  return mesh;
}

const WIND_UNIFORM = { value: 0 };

export function advanceWind(time: number): void {
  WIND_UNIFORM.value = time;
}

function patchWind(material: THREE.MeshLambertMaterial, charred: boolean): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = WIND_UNIFORM;
    shader.uniforms.uSway = { value: charred ? 0.012 : 0.055 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform float uSway;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         #ifdef USE_INSTANCING
           float swayPhase = instanceMatrix[3].x * 0.07 + instanceMatrix[3].z * 0.05;
           float lean = pow(max(position.y, 0.0), 1.7) * uSway;
           transformed.x += sin(uTime * 1.35 + swayPhase) * lean;
           transformed.z += cos(uTime * 1.1 + swayPhase * 1.3) * lean * 0.7;
         #endif`,
      );
  };
}
