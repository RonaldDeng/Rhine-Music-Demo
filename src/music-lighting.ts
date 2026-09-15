import * as THREE from "three";

/** A soft pool of light follows the physical album, including its lift/return. */
export class MusicSelectionLighting {
  readonly spot = new THREE.SpotLight("#ffe3b2", 560, 22, 0.4, 0.85, 2);
  private readonly aim = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private initialized = false;

  constructor(private readonly scene: THREE.Scene) {
    this.spot.name = "Selected album soft key";
    // Reuse the main key's existing shadows. A second shadow render across the
    // entire glass array would be a poor trade for this broad local fill.
    this.spot.castShadow = false;
    this.spot.visible = false;
    scene.add(this.spot, this.spot.target);
  }

  setTheme(theme: "day" | "night" | "dusk", key: THREE.DirectionalLight) {
    const night = theme === "night";
    this.scene.environmentIntensity = night ? 0.3 : 0.32;
    key.intensity = night ? 0.72 : 0.82;
    for (const child of this.scene.children) {
      if (child instanceof THREE.HemisphereLight) child.intensity = night ? 0.32 : 0.34;
      if (child instanceof THREE.DirectionalLight && child !== key) child.intensity = 0.18;
    }
    this.spot.color.set(night ? "#dbe9ff" : "#ffe3b2");
    this.spot.intensity = night ? 340 : 560;
  }

  update(model: THREE.Object3D, camera: THREE.Camera, dt: number, visible: boolean, reduced: boolean) {
    this.spot.visible = visible;
    if (!visible) {
      this.initialized = false;
      return;
    }
    // Use the rendered world position, never a library row/index: the array
    // scrolls and periodically rebases its coordinates during infinite browsing.
    model.updateWorldMatrix(true, false);
    this.aim.set(-1.95, 2.3, 0).applyMatrix4(model.matrixWorld);
    if (!this.initialized || reduced) this.anchor.copy(this.aim);
    else this.anchor.lerp(this.aim, 1 - Math.exp(-dt * 8));
    this.initialized = true;
    this.spot.target.position.copy(this.anchor);
    // Camera-local -X/-Y: light enters from the lower-left of the picture and
    // grazes the spine, rather than illuminating the album face from above.
    this.offset.set(-6, -2.2, 4.5).applyQuaternion(camera.quaternion);
    this.spot.position.copy(this.anchor).add(this.offset);
  }
}
