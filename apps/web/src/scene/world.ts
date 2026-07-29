import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import type { BiomeManifest, Plot } from '@burningbranches/schema';
import { ATMOSPHERE } from './atmosphere.js';
import { buildField, plotAt, sampleHeight, type Field } from './field.js';
import { buildTerrain, type TerrainHandle } from './terrain.js';
import { advanceWind, buildTrees, type TreeHandle } from './trees.js';
import { buildFire, type FireHandle } from './fire.js';
import { buildSky, type SkyHandle } from './sky.js';
import { WalkController } from './walk.js';

export interface HoverEvent {
  plot: Plot | null;
  x: number;
  y: number;
}

export class World {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: MapControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly startedAt = performance.now();

  private manifest: BiomeManifest | null = null;
  private field: Field | null = null;
  private terrain: TerrainHandle | null = null;
  private trees: TreeHandle | null = null;
  private fire: FireHandle | null = null;
  private sky: SkyHandle | null = null;

  private frame = 0;
  private lastFrameAt = performance.now();
  private disposed = false;
  private pointerActive = false;
  private lastHoverId = -3;
  private walk: WalkController;

  onHover: ((event: HoverEvent) => void) | null = null;
  onSelect: ((plot: Plot | null) => void) | null = null;
  onWalkChange: ((state: { active: boolean; flying: boolean }) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(ATMOSPHERE.fog);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = ATMOSPHERE.exposure;

    this.scene.fog = new THREE.Fog(ATMOSPHERE.fog, ATMOSPHERE.fogNear, ATMOSPHERE.fogFar);

    this.camera = new THREE.PerspectiveCamera(52, 1, 1, 12000);
    this.camera.position.set(120, 520, 1180);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 18;
    this.controls.maxDistance = 2400;
    this.controls.maxPolarAngle = Math.PI * 0.475;
    this.controls.target.set(500, 0, 500);

    const sun = new THREE.DirectionalLight(ATMOSPHERE.sunColor, 2.6);
    sun.position.copy(ATMOSPHERE.sunDirection).multiplyScalar(2000);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(ATMOSPHERE.skyHorizon, ATMOSPHERE.bounce, 1.6));

    this.sky = buildSky();
    this.scene.add(this.sky.mesh);

    this.walk = new WalkController(this.camera, canvas);
    this.walk.onExit = () => this.leaveWalk();
    this.walk.onFlyChange = (flying) => this.onWalkChange?.({ active: true, flying });

    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
    canvas.addEventListener('click', this.handleClick);
    window.addEventListener('resize', this.handleResize);

    this.handleResize();
    this.renderLoop();
  }

  load(manifest: BiomeManifest): void {
    this.leaveWalk();
    this.clear();
    this.manifest = manifest;

    const field = buildField(manifest);
    this.field = field;

    this.terrain = buildTerrain(field);
    this.scene.add(this.terrain.mesh);

    this.trees = buildTrees(manifest, field);
    for (const mesh of this.trees.meshes) this.scene.add(mesh);

    this.fire = buildFire(manifest, field);
    for (const points of this.fire.objects) this.scene.add(points);

    this.frameCamera(field);
  }

  /** Opening shot: centred on the map, high enough to read it, angled to show the canopy. */
  private frameCamera(field: Field): void {
    const size = field.world;
    const centre = sampleHeight(field, size / 2, size / 2);
    this.controls.target.set(size / 2, centre, size / 2);
    this.camera.position.set(size / 2, centre + size * 0.58, size * 1.42);
    this.controls.update();
  }

  /** Lights the selected plot's ground and draws a rim along its border. */
  highlight(plot: Plot | null): void {
    if (!this.terrain) return;
    this.terrain.material.uniforms.uSelected!.value = plot ? plot.id : -1;
  }

  focus(plot: Plot): void {
    if (!this.field) return;
    const [x, z, w, h] = plot.rect;
    const cx = x + w / 2;
    const cz = z + h / 2;
    const y = sampleHeight(this.field, cx, cz);
    const distance = Math.max(60, Math.max(w, h) * 3.2);
    this.controls.target.set(cx, y, cz);
    this.camera.position.set(cx - distance * 0.35, y + distance * 0.75, cz + distance);
    this.controls.update();
  }

  clear(): void {
    if (this.terrain) {
      this.scene.remove(this.terrain.mesh);
      this.terrain.dispose();
      this.terrain = null;
    }
    if (this.trees) {
      for (const mesh of this.trees.meshes) this.scene.remove(mesh);
      this.trees.dispose();
      this.trees = null;
    }
    if (this.fire) {
      for (const points of this.fire.objects) this.scene.remove(points);
      this.fire.dispose();
      this.fire = null;
    }
    this.manifest = null;
    this.field = null;
    this.lastHoverId = -3;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.walk.exit();
    this.clear();
    if (this.sky) {
      this.scene.remove(this.sky.mesh);
      this.sky.dispose();
      this.sky = null;
    }
    this.controls.dispose();
    this.renderer.dispose();
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('click', this.handleClick);
    window.removeEventListener('resize', this.handleResize);
  }

  /** Drops the viewer into the map at human scale, looking out from where they were. */
  enterWalk(): void {
    if (!this.field || this.walk.isActive) return;
    this.controls.enabled = false;
    const from = new THREE.Vector3(
      this.controls.target.x,
      sampleHeight(this.field, this.controls.target.x, this.controls.target.z) + 1.72,
      this.controls.target.z,
    );
    this.walk.enter(this.field, from, this.controls.target);
    this.onWalkChange?.({ active: true, flying: this.walk.isFlying });
  }

  leaveWalk(): void {
    if (!this.walk.isActive) return;
    this.walk.exit();
    this.controls.enabled = true;
    if (this.field) {
      // Return the orbit view to whatever the walker was standing over.
      const { x, z } = this.camera.position;
      this.controls.target.set(x, sampleHeight(this.field, x, z), z);
      this.camera.position.set(x, this.controls.target.y + 320, z + 420);
      this.controls.update();
    }
    this.onWalkChange?.({ active: false, flying: false });
  }

  get walking(): boolean {
    return this.walk.isActive;
  }

  private renderLoop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.renderLoop);

    const now = performance.now();
    const delta = (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;

    const time = (now - this.startedAt) / 1000;
    advanceWind(time);
    if (this.terrain) this.terrain.material.uniforms.uTime!.value = time;
    if (this.fire) this.fire.update(time);

    if (this.walk.isActive && this.field) this.walk.update(delta, this.field);
    else this.controls.update();

    this.renderer.render(this.scene, this.camera);
  };

  private handleResize = (): void => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    // Under pointer lock the cursor has no position, so picking is meaningless.
    if (this.walk.isActive) return;
    this.pointerActive = true;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const plot = this.pick();
    const id = plot?.id ?? -1;
    if (id !== this.lastHoverId) {
      this.lastHoverId = id;
      this.onHover?.({ plot, x: event.clientX, y: event.clientY });
    } else if (plot) {
      this.onHover?.({ plot, x: event.clientX, y: event.clientY });
    }
  };

  private handlePointerLeave = (): void => {
    this.pointerActive = false;
    this.lastHoverId = -3;
    this.onHover?.({ plot: null, x: 0, y: 0 });
  };

  private handleClick = (): void => {
    if (this.walk.isActive || !this.pointerActive) return;
    this.onSelect?.(this.pick());
  };

  private pick(): Plot | null {
    if (!this.terrain || !this.field || !this.manifest) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.terrain.mesh, false);
    const hit = hits[0];
    if (!hit) return null;
    return plotAt(this.field, this.manifest.plots, hit.point.x, hit.point.z);
  }
}
