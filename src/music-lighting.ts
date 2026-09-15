import * as THREE from "three";

/** Side key plus a bounded approximation of light scattered inside the CD shell. */
export class MusicSelectionLighting {
  readonly spot = new THREE.SpotLight("#ffe3b2", 220, 24, 0.28, 0.9, 2);
  private readonly aim = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private initialized = false;
  private readonly column = { value: new THREE.Vector3() };
  private readonly scatterColor = { value: new THREE.Color("#ffe2b5") };
  private readonly scatterStrength = { value: 1 };

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
    this.scene.environmentIntensity = night ? 0.16 : 0.25;
    key.intensity = night ? 0.30 : 0.45;
    for (const child of this.scene.children) {
      if (child instanceof THREE.HemisphereLight) child.intensity = night ? 0.21 : 0.32;
      if (child instanceof THREE.DirectionalLight && child !== key) child.intensity = 0.045;
    }
    this.spot.color.set(night ? "#dbe9ff" : "#ffe3b2");
    this.spot.intensity = night ? 155 : 220;
    this.scatterColor.value.set(night ? "#c6dfff" : "#ffe2b5");
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
      float laneLight = exp(-pow(laneDistance / 2.0, 4.0));
      float rowDistance = (vMusicOrigin.z - musicLightColumn.z) / 14.0;
      float rowLight = exp(-rowDistance * rowDistance);
      float guidedLight = laneLight * mix(0.28, 1.0, rowLight);
      outgoingLight *= mix(0.9, 1.15, guidedLight);
      ${glass || spine ? `
        // Strong at the illuminated narrow edge, then absorbed across the sheet.
        float fromSpine = max(0.0, vMusicLocal.x + 1.9);
        float edgeTransport = exp(-fromSpine * 1.6);
        float lowerLight = mix(1.0, 0.52, clamp(vMusicLocal.y / 3.7, 0.0, 1.0));
        float edgeScatter = ${spine ? '0.52' : '0.32'} * edgeTransport + ${spine ? '0.09' : '0.035'};
        outgoingLight += musicScatterColor * musicScatterStrength * guidedLight * edgeScatter * lowerLight;
      ` : `outgoingLight += diffuseColor.rgb * guidedLight * 0.22;`}
      #include <opaque_fragment>
    `);
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
    if (!this.initialized || reduced) this.column.value.copy(model.position);
    else this.column.value.lerp(model.position, 1 - Math.exp(-dt * 8));
    this.initialized = true;
    this.spot.target.position.copy(this.anchor);
    // Camera-local -X/-Y: light enters from the lower-left of the picture and
    // grazes the spine, rather than illuminating the album face from above.
    this.offset.set(-6, -2.2, 4.5).applyQuaternion(camera.quaternion);
    this.spot.position.copy(this.anchor).add(this.offset);
  }
}
