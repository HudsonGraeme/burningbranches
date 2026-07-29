import * as THREE from 'three';
import { sampleHeight, type Field } from './field.js';

/**
 * Creative mode movement, at the scale a person would actually experience the map. Speeds
 * are the Minecraft values in metres per second, which is why the forest reads at the right
 * size: a twenty five metre stand takes as long to walk past as it should.
 */
const EYE_HEIGHT = 1.72;
const WALK_SPEED = 4.3;
const SPRINT_SPEED = 5.6;
const FLY_SPEED = 10.9;
const FLY_SPRINT_SPEED = 21.8;
const VERTICAL_SPEED = 7.5;
const GRAVITY = 26;
const JUMP_VELOCITY = 8.2;
const LOOK_SENSITIVITY = 0.0022;
const DOUBLE_TAP_MS = 320;
const MAX_STEP = 0.1;

export class WalkController {
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private velocityY = 0;
  private grounded = false;
  private flying = true;
  private lastSpaceAt = 0;
  private lastForwardReleaseAt = -Infinity;
  private sprintLatch = false;
  private active = false;

  onExit: (() => void) | null = null;
  onFlyChange: ((flying: boolean) => void) | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get isFlying(): boolean {
    return this.flying;
  }

  enter(field: Field, from: THREE.Vector3, lookAt: THREE.Vector3): void {
    this.active = true;
    this.flying = true;
    this.velocityY = 0;
    this.keys.clear();
    this.sprintLatch = false;
    this.lastSpaceAt = 0;
    this.lastForwardReleaseAt = -Infinity;
    this.onFlyChange?.(true);

    const size = field.world;
    const x = THREE.MathUtils.clamp(from.x, 4, size - 4);
    const z = THREE.MathUtils.clamp(from.z, 4, size - 4);
    const ground = sampleHeight(field, x, z);
    this.camera.position.set(x, Math.max(from.y, ground + EYE_HEIGHT), z);

    const direction = new THREE.Vector3().subVectors(lookAt, this.camera.position);
    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.pitch = 0;
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(0, this.yaw, 0);

    // A person's eye needs to focus on nearby bark, not on a map seen from altitude.
    this.camera.near = 0.1;
    this.camera.updateProjectionMatrix();

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    document.addEventListener('mousemove', this.handleMouseMove);
    void this.canvas.requestPointerLock();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    document.removeEventListener('mousemove', this.handleMouseMove);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();

    this.camera.near = 1;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.set(0, 0, 0);
  }

  update(delta: number, field: Field): void {
    if (!this.active) return;
    const dt = Math.min(delta, MAX_STEP);
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const sprinting =
      this.keys.has('ControlLeft') ||
      this.keys.has('ControlRight') ||
      (this.sprintLatch && forward > 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);

    if (forward !== 0 || strafe !== 0) {
      const speed = this.flying
        ? sprinting
          ? FLY_SPRINT_SPEED
          : FLY_SPEED
        : sprinting
          ? SPRINT_SPEED
          : WALK_SPEED;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Heading is taken from yaw alone, so looking at the sky does not slow you down.
      const dx = -sin * forward + cos * strafe;
      const dz = -cos * forward - sin * strafe;
      const length = Math.hypot(dx, dz) || 1;
      this.camera.position.x += (dx / length) * speed * dt;
      this.camera.position.z += (dz / length) * speed * dt;
    }

    if (this.flying) {
      const lift =
        (this.keys.has('Space') ? 1 : 0) -
        (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1 : 0);
      this.camera.position.y += lift * VERTICAL_SPEED * (sprinting ? 2 : 1) * dt;
      this.velocityY = 0;
    } else {
      this.velocityY -= GRAVITY * dt;
      this.camera.position.y += this.velocityY * dt;
    }

    const size = field.world;
    this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, 1, size - 1);
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, 1, size - 1);

    const floor = sampleHeight(field, this.camera.position.x, this.camera.position.z) + EYE_HEIGHT;
    if (this.camera.position.y <= floor) {
      this.camera.position.y = floor;
      this.velocityY = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private handleMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.canvas) return;
    this.yaw -= event.movementX * LOOK_SENSITIVITY;
    this.pitch -= event.movementY * LOOK_SENSITIVITY;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -limit, limit);
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') return;
    this.keys.add(event.code);

    // Holding a key emits keydown continuously. Those repeats are not taps, and treating
    // them as taps made every held space read as a double tap and flip flight repeatedly.
    if (event.repeat) {
      if (event.code === 'Space') event.preventDefault();
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      const now = performance.now();
      if (now - this.lastSpaceAt < DOUBLE_TAP_MS) {
        this.flying = !this.flying;
        this.velocityY = 0;
        this.onFlyChange?.(this.flying);
        this.lastSpaceAt = 0;
        return;
      }
      this.lastSpaceAt = now;
      if (!this.flying && this.grounded) this.velocityY = JUMP_VELOCITY;
      return;
    }

    // Tap forward, then press and hold it again, and you sprint until you let go.
    if (event.code === 'KeyW' && performance.now() - this.lastForwardReleaseAt < DOUBLE_TAP_MS) {
      this.sprintLatch = true;
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
    if (event.code === 'KeyW') {
      this.sprintLatch = false;
      this.lastForwardReleaseAt = performance.now();
    }
  };

  private handleLockChange = (): void => {
    if (document.pointerLockElement !== this.canvas) this.onExit?.();
  };
}
