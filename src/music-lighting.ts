import * as THREE from "three";

/** Side key plus a bounded approximation of light scattered inside the CD shell. */
export class MusicSelectionLighting {
  readonly spot = new THREE.SpotLight("#ffe3b2", 180, 24, 0.25, 0.9, 2);
  private readonly aim = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly anchorVelocity = new THREE.Vector3();
  private readonly columnVelocity = new THREE.Vector3();
  private initialized = false;
  private readonly column = { value: new THREE.Vector3() };
  private readonly scatterColor = { value: new THREE.Color("#ffdba3") };
  private readonly scatterStrength = { value: 1 };

  constructor(private readonly scene: THREE.Scene) {
    this.spot.name = "Selected album soft key";
    // Existing soft contact shadows are sufficient; the local key adds no
    // second shadow-map render across the entire glass array.
    this.spot.castShadow = false;
    this.spot.visible = false;
    scene.add(this.spot, this.spot.target);
  }

  setTheme(theme: "day" | "night" | "dusk", key: THREE.DirectionalLight) {
    const night = theme === "night";
    this.scene.environmentIntensity = night ? 0.16 : 0.25;
    key.intensity = night ? 0.30 : 0.45;
    for (const child of this.scene.children) {
      if (child instanceof THREE.HemisphereLight) child.intensity = night ? 0.21 : 0.32;
      if (child instanceof THREE.DirectionalLight && child !== key) child.intensity = 0.045;
    }
    this.spot.color.set(night ? "#dbe9ff" : "#ffe3b2");
    this.spot.intensity = night ? 130 : 180;
    this.scatterColor.value.set(night ? "#cee5ff" : "#ffdba3");
    this.scatterStrength.value = night ? 0.72 : 1;
  }

  /** Shared by instances, the lifted CD and returning copies; no extra render pass.
   * WebGL transmission cannot propagate light between glass layers. This bounded
   * scattering term approximates that transport from the spine into the panel.
   */
  shade(shader: THREE.WebGLProgramParametersWithUniforms, surface: string) {
    shader.uniforms.musicLightColumn = this.column;
    shader.uniforms.musicScatterColor = this.scatterColor;
    shader.uniforms.musicScatterStrength = this.scatterStrength;
    const declarations = `
      varying vec3 vMusicLocal;
      varying vec3 vMusicOrigin;
    `;
    shader.vertexShader = declarations + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `
      #include <begin_vertex>
      vMusicLocal = position;
      vec4 musicOrigin = vec4(0.0, 0.0, 0.0, 1.0);
      #ifdef USE_INSTANCING
        musicOrigin = instanceMatrix * musicOrigin;
      #endif
      vMusicOrigin = (modelMatrix * musicOrigin).xyz;
    `);
    shader.fragmentShader = declarations + `
      uniform vec3 musicLightColumn;
      uniform vec3 musicScatterColor;
      uniform float musicScatterStrength;
    ` + shader.fragmentShader;
    const glass = surface === "Frosted_Polymer";
    const spine = surface === "Ivory_Edges";
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
      float laneDistance = abs(vMusicOrigin.x - musicLightColumn.x);
      float laneRadius = laneDistance / 3.2;
      float laneLight = exp(-laneRadius * laneRadius * laneRadius * laneRadius);
      float rowDistance = (vMusicOrigin.z - musicLightColumn.z) / 5.5;
      float rowLight = exp(-rowDistance * rowDistance);
      float hotDistance = (vMusicOrigin.z - musicLightColumn.z) / 1.1;
      float hotLight = exp(-hotDistance * hotDistance);
      // The reference has a warm local ribbon, not uniformly glowing spines.
      float guidedLight = laneLight * mix(0.12, 1.0, rowLight);
      outgoingLight *= mix(0.94, 1.08, guidedLight);
      ${glass || spine ? `
        float fromSpine = max(0.0, vMusicLocal.x + 1.9);
        float edgeTransport = exp(-fromSpine * 1.35);
        float lowerLight = mix(1.0, 0.62, clamp(vMusicLocal.y / 3.7, 0.0, 1.0));
        float topRim = exp(-max(0.0, 3.7 - vMusicLocal.y) * 22.0);
        float grazing = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
        float edgeScatter = ${spine ? '0.34' : '0.17'} * edgeTransport + ${spine ? '0.055' : '0.008'};
        outgoingLight += musicScatterColor * musicScatterStrength * guidedLight * edgeScatter * lowerLight;
        // A narrow glint at the top and the lit spine changes with viewing angle.
        // The cover interior receives very little additive light, preserving ink.
        float ribbon = topRim * (0.22 + 0.78 * edgeTransport) + ${spine ? '0.18' : '0.035'} * edgeTransport * grazing;
        outgoingLight += musicScatterColor * musicScatterStrength * laneLight * hotLight * ribbon * 0.8;
      ` : surface === "Album_Print" ? `outgoingLight += diffuseColor.rgb * guidedLight * 0.20;` : ''}
      #include <opaque_fragment>
    `);
  }

  private follow(value: THREE.Vector3, velocity: THREE.Vector3, target: THREE.Vector3, dt: number) {
    const rate = 5.0;
    const decay = Math.exp(-rate * dt);
    for (const axis of ["x", "y", "z"] as const) {
      const delta = value[axis] - target[axis];
      const impulse = velocity[axis] + rate * delta;
      value[axis] = target[axis] + (delta + impulse * dt) * decay;
      velocity[axis] = (velocity[axis] - rate * impulse * dt) * decay;
    }
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
    if (!this.initialized || reduced) {
      this.anchor.copy(this.aim);
      this.column.value.copy(model.position);
      this.anchorVelocity.set(0, 0, 0);
      this.columnVelocity.set(0, 0, 0);
    } else {
      // Preserve velocity on repeated input. A critically damped start follows
      // the soft lift; the wider lane footprint crossfades neighboring columns
      // while travelling between them instead of extinguishing both midway.
      this.follow(this.anchor, this.anchorVelocity, this.aim, dt);
      this.follow(this.column.value, this.columnVelocity, model.position, dt);
    }
    this.initialized = true;
    this.spot.target.position.copy(this.anchor);
    // Camera-local -X/-Y: light enters from the lower-left of the picture and
    // grazes the spine, rather than illuminating the album face from above.
    this.offset.set(-6, -2.2, 4.5).applyQuaternion(camera.quaternion);
    this.spot.position.copy(this.anchor).add(this.offset);
  }
}
