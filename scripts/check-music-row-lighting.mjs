import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { MUSIC_COLUMN_SPACING } from '../src/music-model.ts';
import { ROW_LIGHTING, DEFAULT_ROW_LIGHTING, DEFAULT_LIGHTING_PRESET, normalizeRowLighting, sampleRowLighting, ROW_LIGHTING_GLSL } from '../src/music-row-lighting.ts';

function sourceModule(path, overrides = {}) {
  const url = new URL(path, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(overrides[specifier] ?? (specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)))}`);
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
const { MusicSelectionLighting } = await import(sourceModule('../src/music-lighting.ts', {
  './theme-transition.ts': sourceModule('../src/theme-transition.ts'),
}));
const { ThemeTransition } = await import(sourceModule('../src/theme-transition.ts'));

// Execute the actual scalar GLSL field expression, not merely a separately
// restated JS approximation. Real WebGL shader compilation is browser-verified.
const body = ROW_LIGHTING_GLSL.match(/float musicRowField\(vec3 origin, vec3 column\) \{([\s\S]*?)\n  \}/)[1];
const glslField = new Function('origin', 'column', 'musicRowSettings',
  `const exp = Math.exp; ${body.replace(/\bfloat\b/g, 'const')}`);
const uniforms = (settings) => new THREE.Vector4(ROW_LIGHTING.modes[settings.mode], settings.strength, settings.width, settings.offset);
const sample = (dx, dz, settings = DEFAULT_ROW_LIGHTING) =>
  glslField(new THREE.Vector3(dx, 0, dz), new THREE.Vector3(), uniforms(settings));

assert.equal(ROW_LIGHTING.laneSpacing, MUSIC_COLUMN_SPACING,
  'Shader field width uses the same physical column spacing as shell placement and camera travel');
assert.equal(sample(0, 0), 1, 'The intended row is the peak, not the selected lane alone');
assert.ok(Math.abs(sample(0, ROW_LIGHTING.rowSpacing) - 1 / 16) < 1e-12,
  'At a one-row FWHM, the next row receives 1/16 of the core field');
assert.ok(sample(2 * ROW_LIGHTING.laneSpacing, 0) > 0.996,
  'Five neighboring lanes share an almost uniform illuminated row');
assert.ok(sample(3 * ROW_LIGHTING.laneSpacing, 0) > 0.96,
  'The ribbon remains continuous across seven lanes');
assert.ok(sample(0, 2 * ROW_LIGHTING.rowSpacing) < 0.00002,
  'Two rows away has no visually meaningful synthetic highlight');
for (const width of [0.6, 1, 2.5]) for (const offset of [-6, -1.5, 0, 6]) {
  const settings = { ...DEFAULT_ROW_LIGHTING, width, offset };
  const center = offset * ROW_LIGHTING.rowSpacing;
  assert.ok(Math.abs(sample(0, center, settings) - 1) < 1e-12, 'Offset is in physical row units');
  assert.ok(Math.abs(sample(0, center + 0.5 * width * ROW_LIGHTING.rowSpacing, settings) - 0.5) < 1e-12,
    'Width control is the measurable full width at half maximum');
  for (const dx of [-4 * MUSIC_COLUMN_SPACING, -MUSIC_COLUMN_SPACING, 0, MUSIC_COLUMN_SPACING, 4 * MUSIC_COLUMN_SPACING]) for (const dz of [-2, -0.31, 0, 0.31, 2])
    assert.ok(Math.abs(sample(dx, dz, settings) - sampleRowLighting(dx, dz, settings)) < 1e-12,
      'Published sampler matches the production shader at multiple widths and offsets');
}

function setup() {
  const scene = new THREE.Scene();
  const model = new THREE.Group(); scene.add(model);
  const camera = new THREE.PerspectiveCamera(); camera.position.set(-62,36,43); camera.lookAt(0,0,0);
  const light = new MusicSelectionLighting(scene);
  const shell = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  const print = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  light.shade(shell, 'Frosted_Polymer');
  light.shadePrint(print);
  light.update(model, camera, 0, true, true);
  return { scene, model, camera, light, shell, print };
}
const a = setup();
assert.deepEqual(a.light.getExperiment(), DEFAULT_ROW_LIGHTING, 'An unconfigured controller remains V0.3.0 baseline');
assert.equal(a.light.area.intensity, 0, 'Baseline adds no real light energy');
assert.equal(a.print.uniforms.musicRowSettings, a.shell.uniforms.musicRowSettings, 'Print and shell controls share one uniform');
assert.equal(a.print.uniforms.musicPrintLightColumn, a.shell.uniforms.musicLightColumn, 'Print and shell have the same world-space anchor');
const originalShellSource = a.shell.fragmentShader;
const originalPrintSource = a.print.fragmentShader;
const originalUniform = a.shell.uniforms.musicRowSettings;
const originalObjects = a.scene.children.slice();
for (const mode of ['area', 'guided', 'hybrid', 'baseline']) {
  a.light.setExperiment({ mode, strength: 1, width: 1, offset: 0 });
  a.light.update(a.model, a.camera, 1 / 60, true, false);
  assert.equal(originalUniform.value.x, ROW_LIGHTING.modes[mode], 'A mode switch updates existing uniforms');
  assert.equal(a.shell.fragmentShader, originalShellSource, 'Mode switching does not rebuild shell shaders');
  assert.equal(a.print.fragmentShader, originalPrintSource, 'Mode switching does not rebuild print shaders');
  assert.deepEqual(a.scene.children, originalObjects, 'Mode switching adds no geometry or scene objects');
  assert.equal(a.light.area.visible, true, 'Light enumeration stays stable while switching modes');
  assert.equal(a.light.spot.visible, true);
  assert.equal(a.light.area.intensity > 0, mode === 'area' || mode === 'hybrid');
}
assert.equal(a.light.area.castShadow, false, 'RectAreaLight introduces no shadow-map render');
assert.ok(a.light.area.width / a.light.area.height > 200, 'Physical emitter is a horizontal strip');
assert.equal(a.scene.children.filter(o => o.isMesh).length, 0, 'Lighting adds no draw-call geometry');

// Execute the production print exposure block. This checks the final exposure
// contrast, including the readable ambient floor, not only Gaussian ratios.
const printBody = a.print.fragmentShader.match(/float ambient =([\s\S]*?)\/\/ A lifted CD/)[0].split('// A lifted CD')[0];
const printExposure = new Function('musicPrintAmbient', 'musicRowSettings', 'rowField', 'musicRowFill = 1', 'printLight = 0', `
  const max = Math.max;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const mix = (a, b, t) => a + (b - a) * t;
  ${printBody.replace(/\bfloat\b/g, 'const')}
  return shelfExposure;
`);
for (const ambient of [0.5, 0.38, 0.12]) {
  const guided = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'guided' });
  const center = printExposure(ambient, guided, sample(0, 0), 0);
  const neighbor = printExposure(ambient, guided, sample(0, ROW_LIGHTING.rowSpacing), 0);
  assert.equal(center, 1, 'Core never exceeds the incoming diffuse ink color');
  assert.ok(center / neighbor > 3.3, 'Fill zero preserves the initial high-contrast experiment');
  assert.ok(neighbor >= 0.08, 'Unlit rows retain a nonzero fraction of their real diffuse detail');
  for (const spatialLight of [0, 0.25, 0.75, 1]) {
    const reference = ambient + (1 - ambient) * spatialLight;
    assert.ok(Math.abs(printExposure(ambient, guided, 0, 1, spatialLight) - reference) < 1e-12,
      'At fill 1, unlit B covers recover the actual original spatial exposure');
    const dark = printExposure(ambient, guided, 0, 0, spatialLight);
    const half = printExposure(ambient, guided, 0, 0.5, spatialLight);
    assert.ok(dark <= half && half <= reference, 'Fill raises unlit covers continuously toward the original');
    assert.equal(printExposure(ambient, guided, 1, 1, spatialLight), 1, 'Restoring neighbors leaves the core unchanged');
    const hybrid = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'hybrid' });
    assert.equal(printExposure(ambient, hybrid, 0.3, 0, spatialLight), printExposure(ambient, hybrid, 0.3, 1, spatialLight),
      'C retains its original exposure when B fill changes');
  }
  const area = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'area' });
  assert.equal(printExposure(ambient, area, 1), printExposure(ambient, area, 0),
    'Physical-only mode does not secretly synthesize a print ribbon');
}

// Moon-white raises only the light theme's unselected diffuse floor. Execute
// the injected exposure expression, including its real fill/ribbon controls.
const dayGuided = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'guided' });
for (const field of [0, 0.0625, 0.5, 1]) for (const spatialLight of [0, 0.25, 0.75, 1]) {
  const previous = printExposure(0.88, dayGuided, field, 1, spatialLight);
  const moonwhite = printExposure(0.94, dayGuided, field, 1, spatialLight);
  assert.ok(moonwhite >= previous && moonwhite <= 1,
    'Light-theme neighbors recover exposure without exceeding the original ink peak');
  assert.ok(moonwhite >= 0.94, 'Unselected light-theme prints keep at least 94% of incoming diffuse color');
}
assert.equal(printExposure(0.94, dayGuided, 1, 1, 0), 1, 'Selected-row peak stays unchanged');

// Evaluate the production shell exposure as well as the cover path.
const shellBody = a.shell.fragmentShader.match(/float fillAmount =([\s\S]*?)outgoingLight \*= shelfExposure;/)[0].split('outgoingLight *=')[0];
const shellExposure = new Function('musicRowSettings', 'musicRowFill', 'guidedLight', 'rowGain', `
  const mix = (a, b, t) => a + (b - a) * t;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  ${shellBody.replace(/\bfloat\b/g, 'const')}
  return shelfExposure;
`);
for (const localLight of [0, 0.5, 1]) {
  const settings = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'guided' });
  assert.equal(shellExposure(settings, 0, localLight, 0), 0.56);
  assert.equal(shellExposure(settings, 1, localLight, 0), 0.96 + 0.08 * localLight,
    'Unlit B shells restore original diffuse exposure at default fill');
  assert.equal(shellExposure(settings, 1, localLight, 1), 1.08, 'Core shell exposure is preserved');
}
assert.equal(a.print.uniforms.musicRowFill, a.shell.uniforms.musicRowFill, 'Fill updates shell and art through the same uniform');
a.light.setExperiment({fill: -4}); assert.equal(a.light.getExperiment().fill, 0);
a.light.setExperiment({fill: 4}); assert.equal(a.light.getExperiment().fill, 1);
a.light.setExperiment({transitionDuration: 0}); assert.equal(a.light.getExperiment().transitionDuration, 0.4);
a.light.setExperiment({transitionDuration: 10}); assert.equal(a.light.getExperiment().transitionDuration, 2.4);
a.light.setExperiment({transitionDuration: NaN}); assert.equal(a.light.getExperiment().transitionDuration, 2.4);
a.light.setExperiment({transitionDuration: DEFAULT_ROW_LIGHTING.transitionDuration});

const b = setup();
a.light.setExperiment({ mode: 'guided' }); b.light.setExperiment({ mode: 'guided' });
a.light.update(a.model, a.camera, 0, true, false);
b.light.update(b.model, b.camera, 0, true, false);
a.model.position.z = b.model.position.z = 0.62;
a.light.update(a.model, a.camera, 0.1, true, false);
for (let i = 0; i < 12; i++) b.light.update(b.model, b.camera, 1 / 120, true, false);
const aColumn = a.shell.uniforms.musicRowColumn.value;
const bColumn = b.shell.uniforms.musicRowColumn.value;
assert.ok(aColumn.distanceTo(bColumn) < 1e-12, 'Row following remains frame-rate independent');
assert.ok(aColumn.z > 0 && aColumn.z < 0.62, 'Row changes start continuously');
const before = aColumn.clone();
a.model.position.z = -0.62;
a.light.update(a.model, a.camera, 1 / 60, true, false);
assert.ok(aColumn.z < before.z && aColumn.z > -0.62, 'Rapid row reversal turns immediately without overshooting');
a.light.update(a.model, a.camera, 0, true, true);
assert.equal(aColumn.z, -0.62, 'Reduced motion anchors immediately');

// Parent transforms are real world-space inputs in experimental modes. Moving
// the model to another owner with its world transform preserved changes no field.
const parent = new THREE.Group(); parent.position.set(11, 2, 4); a.scene.add(parent);
parent.attach(a.model);
a.light.update(a.model, a.camera, 0, true, true);
assert.ok(aColumn.distanceTo(a.model.getWorldPosition(new THREE.Vector3())) < 1e-12);
const movedWorld = a.model.getWorldPosition(new THREE.Vector3());
const instanceMatrix = new THREE.Matrix4().makeTranslation(movedWorld.x, movedWorld.y, movedWorld.z);
const instanceOrigin = new THREE.Vector3().applyMatrix4(instanceMatrix);
assert.equal(glslField(instanceOrigin, aColumn, originalUniform.value),
  glslField(movedWorld, aColumn, originalUniform.value), 'Instance/extracted ownership gives identical row exposure');
const liftedOrigin = movedWorld.clone().add(new THREE.Vector3(0, 6, 0));
assert.equal(glslField(liftedOrigin, aColumn, originalUniform.value), 1, 'Lifting does not leave the row field');

a.light.setExperiment({ mode: 'hybrid', strength: 2, width: 2.5, offset: 6 });
const snapshot = a.light.getExperiment(); snapshot.width = 100;
assert.equal(a.light.getExperiment().width, 2.5, 'Diagnostics cannot mutate live controls');
a.light.setExperiment({ strength: -5, width: 99, offset: -99 });
assert.deepEqual(a.light.getExperiment(), { mode: 'hybrid', strength: 0, dayGain: 11, width: 2.5, offset: -6, fill: 1, transitionDuration: 1.2 });
assert.equal(a.light.area.intensity, 0, 'Strength zero extinguishes the physical contribution');
assert.deepEqual(normalizeRowLighting({ width: NaN, strength: Infinity, offset: NaN, mode: 'bad' }), DEFAULT_ROW_LIGHTING,
  'Nonfinite and invalid settings never reach shader uniforms');
assert.equal(DEFAULT_ROW_LIGHTING.dayGain, 11, 'Unconfigured controllers use the new 11x daylight compensation');
assert.equal(DEFAULT_LIGHTING_PRESET.dayGain, 11, 'First use and reset share the new 11x daylight gain');
const { dayGain: _oldMissingGain, ...oldPreferences } = DEFAULT_LIGHTING_PRESET;
assert.deepEqual(normalizeRowLighting(oldPreferences), DEFAULT_LIGHTING_PRESET,
  'Saved preferences from before the gain control migrate without changing existing values');
assert.deepEqual(normalizeRowLighting({}, oldPreferences), DEFAULT_LIGHTING_PRESET,
  'An older previous-settings object without the new field also gets the 11x fallback');
for (const dayGain of [0, 1, 3, 4.2, 6, 9.5, 11, 15, 20]) {
  const saved = { ...DEFAULT_LIGHTING_PRESET, dayGain };
  assert.deepEqual(normalizeRowLighting(saved), saved, 'Existing valid saved gains are retained when the default changes');
  assert.deepEqual(normalizeRowLighting({}, saved), saved, 'An unrelated edit preserves the previously chosen gain');
}
for (const dayGain of [NaN, Infinity, -Infinity, undefined]) {
  assert.equal(normalizeRowLighting({ dayGain }).dayGain, 11, 'Nonfinite gain uses the safe default');
  assert.equal(normalizeRowLighting({ dayGain }, { ...DEFAULT_LIGHTING_PRESET, dayGain: 4.2 }).dayGain, 4.2,
    'An invalid edit preserves the current gain instead of resetting the user choice');
}
for (const [input, expected] of [[-100, 0], [0, 0], [1, 1], [3, 3], [4.2, 4.2], [6, 6], [11, 11], [15, 15], [20, 20], [20.1, 20], [100, 20]]) {
  assert.equal(normalizeRowLighting({ dayGain: input }).dayGain, expected,
    'Day gain accepts fractional tuning and clamps to the 0–20 slider range');
}

a.light.setExperiment({ mode: 'area', strength: 1, width: 1, offset: 0 });
const key = new THREE.DirectionalLight();
const transition = new ThemeTransition(0);
a.light.setTheme('night', key, transition); transition.finish();
a.light.update(a.model, a.camera, 0, true, true);
assert.equal(a.light.area.intensity, 24, 'Theme transition controls physical strip energy');
assert.equal(a.light.area.color.getHex(), new THREE.Color('#dbe9ff').getHex());
a.light.update(a.model, a.camera, 0, true, true, false, 0.5);
assert.equal(a.shell.uniforms.musicRowDetail.value, 0.5, 'Detail handoff is continuous');
assert.equal(a.light.area.intensity, 12, 'Physical strip fades while detail lighting takes over');
a.light.update(a.model, a.camera, 0, true, true, false, 1);
assert.equal(a.light.area.intensity, 0, 'Full detail uses the established inspection lighting');
assert.equal(a.shell.uniforms.musicRowDetail.value, 1);

// Execute all actual additive terms, checking both the broad selected glow and
// guided ribbon. A global detail gate would darken the entire transmitted shelf.
const scatterTerms = [...a.shell.fragmentShader.matchAll(/outgoingLight \+= ([^;]+);/g)].map((match) =>
  new Function('musicScatterColor', 'musicScatterStrength', 'guidedLight', 'edgeScatter', 'lowerLight',
    'laneLight', 'hotLight', 'ribbon', 'rowGain', 'scatter', 'hybridGain', 'musicRowDetail', `return ${match[1]};`));
assert.equal(scatterTerms.length, 3, 'Both selected scatter terms and the guided term are checked');
const detailPrintBody = a.print.fragmentShader.match(/float detailExposure = ([\s\S]*?)outgoingLight \*= ([^;]+);/);
const detailPrintExposure = new Function('musicPrintAmbient', 'printLight', 'shelfExposure', 'musicRowDetail', `
  const mix = (a, b, t) => a + (b - a) * t;
  const detailExposure = ${detailPrintBody[1]}
  return ${detailPrintBody[2]};
`);
const moonwhite = setup();
const hemisphere = new THREE.HemisphereLight();
const extraKey = new THREE.DirectionalLight();
const themeKey = new THREE.DirectionalLight();
moonwhite.scene.add(hemisphere, extraKey, themeKey);
moonwhite.light.setExperiment({ mode: 'area', strength: 1 });
for (const [theme, values] of [
  ['day', { ambient: 0.94, hemi: 0.70, key: 0.38, area: 18 * 11, spot: 70 * 64, scatter: 0.12,
    lightColor: '#ffe3b2', scatterColor: '#ffdba3', environment: 0.30 }],
  ['night', { ambient: 0.12, hemi: 0.21, key: 0.30, area: 24, spot: 130 * 64, scatter: 0.72,
    lightColor: '#dbe9ff', scatterColor: '#cee5ff', environment: 0.16 }],
  ['dusk', { ambient: 0.38, hemi: 0.32, key: 0.45, area: 34, spot: 180 * 64, scatter: 1,
    lightColor: '#ffe3b2', scatterColor: '#ffdba3', environment: 0.25 }],
]) {
  moonwhite.light.setTheme(theme, themeKey);
  assert.equal(moonwhite.print.uniforms.musicPrintAmbient.value, values.ambient);
  assert.equal(moonwhite.shell.uniforms.musicScatterStrength.value, values.scatter);
  assert.equal(moonwhite.shell.uniforms.musicScatterColor.value.getHex(), new THREE.Color(values.scatterColor).getHex());
  assert.equal(moonwhite.scene.environmentIntensity, values.environment);
  assert.equal(hemisphere.intensity, values.hemi);
  assert.equal(themeKey.intensity, values.key);
  assert.equal(extraKey.intensity, 0.045, 'Secondary directional light retains its original energy');
  assert.equal(moonwhite.light.spot.color.getHex(), new THREE.Color(values.lightColor).getHex());
  assert.equal(moonwhite.light.area.color.getHex(), new THREE.Color(values.lightColor).getHex());
  // Enter, reverse midway, complete inspection and return; all broad lighting
  // remains steady. The separate physical strip keeps its established handoff.
  for (const detail of [0, 0.1, 0.25, 0.5, 0.3, 0.75, 1, 0.9, 0.5, 0.25, 0]) {
    moonwhite.light.update(moonwhite.model, moonwhite.camera, 0, true, true, false, detail);
    const easedDetail = moonwhite.shell.uniforms.musicRowDetail.value;
    assert.equal(moonwhite.light.area.intensity, values.area * (1 - easedDetail));
    assert.equal(moonwhite.light.spot.intensity, values.spot, `${theme} side light is stable through inspection and reversal`);
    assert.equal(hemisphere.intensity, values.hemi, `${theme} diffuse lighting never follows the inspection camera`);
    assert.equal(moonwhite.scene.environmentIntensity, values.environment, `${theme} environment energy remains steady`);
    const incomingColor = 0.7;
    const actualScatter = moonwhite.shell.uniforms.musicScatterStrength.value;
    const expectedTerms = [
      incomingColor * values.scatter * 0.4 * 0.2 * 0.85,
      incomingColor * values.scatter * 0.6 * 0.3 * 0.15 * 0.8,
      incomingColor * values.scatter * 0.5 * 0.25 * 0.86,
    ];
    for (const [index, term] of scatterTerms.entries()) {
      assert.equal(term(incomingColor, actualScatter, 0.4, 0.2, 0.85, 0.6, 0.3, 0.15, 0.5, 0.25, 0.86, easedDetail),
        expectedTerms[index], `${theme} production shell contribution ${index} retains its fixed theme energy`);
    }
    const shelfFloor = printExposure(moonwhite.print.uniforms.musicPrintAmbient.value, dayGuided, 0, 1, 0);
    assert.equal(detailPrintExposure(moonwhite.print.uniforms.musicPrintAmbient.value, 0, shelfFloor, easedDetail),
      values.ambient, `${theme} background print floor is identical before, during and after inspection`);
  }
}

moonwhite.light.setTheme('day', themeKey);
const reverse = new ThemeTransition(1);
const start = performance.now() / 1000;
moonwhite.light.setTheme('night', themeKey, reverse);
assert.equal(moonwhite.light.spot.intensity, 70 * 64, 'Registering theme targets does not jump the side light');
assert.equal(moonwhite.shell.uniforms.musicScatterStrength.value, 0.12, 'Registering theme targets leaves current scatter intact');
reverse.update(start + 0.3);
moonwhite.light.update(moonwhite.model, moonwhite.camera, 0, true, true, false, 0.5);
assert.ok(moonwhite.light.spot.intensity > 70 * 64 && moonwhite.light.spot.intensity < 130 * 64,
  'Side light shares the continuous theme clock');
assert.ok(moonwhite.shell.uniforms.musicScatterStrength.value > 0.12 && moonwhite.shell.uniforms.musicScatterStrength.value < 0.72,
  'Scatter shares the continuous theme clock without an inspection multiplier');
assert.ok(moonwhite.print.uniforms.musicPrintAmbient.value > 0.12 && moonwhite.print.uniforms.musicPrintAmbient.value < 0.94,
  'Print floor interpolates continuously with the lighting palette');
reverse.finish();
moonwhite.light.update(moonwhite.model, moonwhite.camera, 0, true, true, false, 1);
assert.equal(moonwhite.shell.uniforms.musicScatterStrength.value, 0.72);
assert.equal(moonwhite.light.spot.intensity, 130 * 64, 'Night endpoint restores its exact original detail source');
a.light.update(a.model, a.camera, 0, false, false);
assert.equal(a.light.spot.visible, false);
assert.equal(a.light.area.visible, false, 'Empty/hidden shelves disable both real lights');

// Daylight compensation belongs to the moving row's effective strength, not
// saved preferences or the scene's broad sources. Drive the actual controller
// through every advanced mode and both physical/shader representations.
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10,
  `${message}: expected ${expected}, received ${actual}`);
const rowGainExpression = a.shell.fragmentShader.match(/float rowGain = ([^;]+);/)[1];
const productionRowGain = new Function('musicRowSettings', 'rowField', `return ${rowGainExpression};`);
for (const [theme, areaBase, spot, ambient, scatter] of [
  ['day', 18, 70 * 64, 0.94, 0.12],
  ['night', 24, 130 * 64, 0.12, 0.72],
  ['dusk', 34, 180 * 64, 0.38, 1],
]) for (const dayGain of [0, 1, 6, 11, 15, 20]) {
  const gain = theme === 'day' ? dayGain : 1;
  const f = setup();
  const themeKey = new THREE.DirectionalLight(); f.scene.add(themeKey);
  const shared = f.shell.uniforms.musicRowSettings;
  const spine = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  const returning = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  f.light.shade(spine, 'Ivory_Edges'); f.light.shade(returning, 'Frosted_Polymer');
  f.light.setTheme(theme, themeKey);
  const broad = { environment: f.scene.environmentIntensity, key: themeKey.intensity,
    spotColor: f.light.spot.color.getHex(), scatterColor: f.shell.uniforms.musicScatterColor.value.getHex() };
  for (const strength of [0, 0.5, 1.3, 2]) for (const mode of ['baseline', 'area', 'guided', 'hybrid']) {
    const settings = { mode, strength, dayGain, width: 1.35, offset: 0.3, fill: 1, transitionDuration: 1.1 };
    f.light.setExperiment(settings);
    assert.deepEqual(f.light.getExperiment(), settings, 'Theme compensation never overwrites the stored/user-facing strength');
    assert.equal(f.shell.uniforms.musicRowSettings, shared, 'Theme/strength edits retain the shared uniform object');
    assert.equal(f.print.uniforms.musicRowSettings, shared);
    assert.equal(spine.uniforms.musicRowSettings, shared, 'Side spines use the same day multiplier as the main shell');
    assert.equal(returning.uniforms.musicRowSettings, shared, 'Returning copies use the same effective row strength');
    close(shared.value.y, strength * gain, `${theme} effective strength for ${mode}`);
    close(shared.value.z, settings.width, 'Day compensation leaves ribbon width unchanged');
    close(shared.value.w, settings.offset, 'Day compensation leaves ribbon offset unchanged');
    for (const detail of [0, 0.5, 1, 0]) {
      f.light.update(f.model, f.camera, 1 / 60, true, false, false, detail);
      const modeGain = mode === 'area' ? 1 : mode === 'hybrid' ? 0.3 : 0;
      close(f.light.area.intensity, areaBase * strength * gain * modeGain *
        (1 - f.shell.uniforms.musicRowDetail.value), `${theme} real area source shares the compensated strength`);
      close(shared.value.y, strength * gain, 'Detail handoff does not rewrite raw or effective strength');
      assert.equal(f.light.spot.intensity, spot, 'The broad spotlight receives no extra multiplier');
      assert.equal(f.shell.uniforms.musicScatterStrength.value, scatter, 'The old theme scatter coefficient remains unchanged');
      assert.equal(f.print.uniforms.musicPrintAmbient.value, ambient, 'Printed-art ambient floor remains unchanged');
      assert.deepEqual({ environment: f.scene.environmentIntensity, key: themeKey.intensity,
        spotColor: f.light.spot.color.getHex(), scatterColor: f.shell.uniforms.musicScatterColor.value.getHex() }, broad,
      'Strength edits do not change broad illumination or theme colours');
    }
    for (const field of [0, 0.0625, 0.5, 1]) {
      const rawSettings = uniforms(settings);
      const rowGain = productionRowGain(shared.value, field);
      close(rowGain, productionRowGain(rawSettings, field) * gain,
        'The actual guided shader expression multiplies row contribution only');
      const rawTerm = scatterTerms[2](0.7, scatter, 0, 0, 0, 0, 0, 0,
        productionRowGain(rawSettings, field), 0.25, 0.86, 0);
      const effectiveTerm = scatterTerms[2](0.7, scatter, 0, 0, 0, 0, 0, 0, rowGain, 0.25, 0.86, 0);
      close(effectiveTerm, rawTerm * gain, `${theme} actual additive ribbon receives exactly its theme multiplier`);
      assert.ok(printExposure(ambient, shared.value, field, 1, 0.25) <= 1,
        'Compensated strength never exceeds the incoming printed-art colour');
    }
  }
}

// Repeated day/night reversals start from the current palette and multiplier.
// Editing the raw strength during that blend uses the current gain immediately,
// without restarting either the row-follow spring or the theme clock.
{
  const f = setup(), key = new THREE.DirectionalLight(); f.scene.add(key);
  f.light.setExperiment({ mode: 'hybrid', strength: 1.3, width: 1.35, offset: 0.3, transitionDuration: 1.1 });
  f.light.setTheme('day', key);
  const effective = () => f.shell.uniforms.musicRowSettings.value.y;
  close(effective(), 1.3 * 11, 'Warm-day start uses exactly eleven times the raw setting');
  const nightward = new ThemeTransition(1), time = performance.now() / 1000;
  const startArea = f.light.area.intensity;
  f.light.setTheme('night', key, nightward);
  close(effective(), 1.3 * 11, 'Registering a theme transition does not jump the shader uniform');
  close(f.light.area.intensity, startArea, 'Registering a theme transition does not jump real light energy');
  let previousGain = 11;
  for (const elapsed of [0.04, 0.1, 0.18, 0.3]) {
    nightward.update(time + elapsed);
    f.light.update(f.model, f.camera, 1 / 60, true, false);
    const gain = effective() / 1.3;
    assert.ok(gain > 1 && gain < previousGain, 'Day-to-night gain decreases continuously between the exact endpoints');
    previousGain = gain;
  }
  const gain = effective() / 1.3, areaPerStrength = f.light.area.intensity / 1.3;
  const motion = f.light.getRowMotion();
  for (const strength of [0, 0.5, 2, 1.3]) {
    f.light.setExperiment({ strength });
    close(effective(), strength * gain, 'A strength edit uses the current interpolated day multiplier');
    close(f.light.area.intensity, strength * areaPerStrength, 'Physical and shader updates use the same current theme state');
    assert.deepEqual(f.light.getRowMotion(), motion, 'A lighting strength edit does not reset opening/row-follow motion');
    assert.equal(f.light.getExperiment().strength, strength);
  }
  const dayward = new ThemeTransition(1), reverseStart = performance.now() / 1000;
  const before = { effective: effective(), area: f.light.area.intensity, spot: f.light.spot.intensity };
  f.light.setTheme('day', key, dayward);
  assert.deepEqual({ effective: effective(), area: f.light.area.intensity, spot: f.light.spot.intensity }, before,
    'Reversing the theme captures its current light levels without an endpoint snap');
  previousGain = gain;
  for (const elapsed of [0.04, 0.12, 0.25, 0.5]) {
    dayward.update(reverseStart + elapsed);
    f.light.update(f.model, f.camera, 1 / 60, true, false);
    const nextGain = effective() / 1.3;
    assert.ok(nextGain > previousGain && nextGain < 11, 'Reversal moves continuously back toward daylight gain');
    previousGain = nextGain;
  }
  dayward.finish(); f.light.update(f.model, f.camera, 0, true, true);
  close(effective(), 1.3 * 11, 'Reduced/finished theme reaches the exact day gain');
  close(f.light.area.intensity, 18 * (1.3 * 11) * 0.3, 'Finished day theme restores exact physical hybrid energy');
  const nightFinish = new ThemeTransition(1); f.light.setTheme('night', key, nightFinish);
  nightFinish.finish(); f.light.update(f.model, f.camera, 0, true, true);
  close(effective(), 1.3, 'Night restores the unmultiplied raw strength');
  close(f.light.area.intensity, 24 * 1.3 * 0.3, 'Night retains the original physical hybrid energy');
}

// Keep an untouched controller on exactly the same theme clock and row path.
// Its default 11x strength exposes the current day fraction without depending
// on private transition state. Moving the gain slider must not alter that
// fraction, reset the colour blend, or restart a moving row's trajectory.
for (const opening of [false, true]) {
  const f = setup(), reference = setup();
  const key = new THREE.DirectionalLight(), referenceKey = new THREE.DirectionalLight();
  f.scene.add(key); reference.scene.add(referenceKey);
  const raw = 1.3;
  const frame = { row: 17, lane: 2, ...(opening ? { introTime: 23.4 } : {}) };
  for (const [fixture, source] of [[f, key], [reference, referenceKey]]) {
    fixture.light.setExperiment({ mode: 'hybrid', strength: raw, transitionDuration: 1.1 });
    fixture.light.setTheme('day', source);
    fixture.model.position.set(2 * ROW_LIGHTING.laneSpacing, 0, 17 * ROW_LIGHTING.rowSpacing);
    fixture.light.update(fixture.model, fixture.camera, 0, true, true, opening, 0, frame);
  }
  const blend = new ThemeTransition(1), start = performance.now() / 1000;
  f.light.setTheme('night', key, blend);
  reference.light.setTheme('night', referenceKey, blend);
  const advance = (elapsed) => {
    blend.update(start + elapsed);
    if (opening) frame.introTime += 1 / 60;
    else frame.row += 0.5;
    for (const fixture of [f, reference]) {
      fixture.model.position.z = frame.row * ROW_LIGHTING.rowSpacing;
      fixture.light.update(fixture.model, fixture.camera, 1 / 60, true, false, opening, 0, frame);
    }
  };
  advance(0.15);
  let previousDayMix = 1;
  for (const [index, dayGain] of [0, 1, 6, 11, 15, 20, 0].entries()) {
    const dayMix = (reference.shell.uniforms.musicRowSettings.value.y / raw - 1) / 10;
    assert.ok(dayMix > 0 && dayMix < previousDayMix, 'The unchanged reference moves continuously toward night');
    previousDayMix = dayMix;
    const motion = f.light.getRowMotion();
    const palette = {
      spot: f.light.spot.intensity, colour: f.light.spot.color.getHex(),
      ambient: f.print.uniforms.musicPrintAmbient.value, environment: f.scene.environmentIntensity,
    };
    f.light.setExperiment({ dayGain });
    close(f.shell.uniforms.musicRowSettings.value.y, raw * (1 + (dayGain - 1) * dayMix),
      'Live gain edits scale the existing day fraction rather than replacing its theme interpolation');
    assert.equal(f.light.getExperiment().dayGain, dayGain, 'The user gain remains separate from the effective shader strength');
    assert.equal(f.light.getExperiment().strength, raw, 'Live daylight gain never modifies advanced raw strength');
    assert.deepEqual(f.light.getRowMotion(), motion, 'Editing daylight gain does not restart intro or row-follow state');
    assert.deepEqual({
      spot: f.light.spot.intensity, colour: f.light.spot.color.getHex(),
      ambient: f.print.uniforms.musicPrintAmbient.value, environment: f.scene.environmentIntensity,
    }, palette, 'Gain edits do not jump the current theme palette');
    const areaPerStrength = reference.light.area.intensity / reference.shell.uniforms.musicRowSettings.value.y;
    close(f.light.area.intensity, areaPerStrength * raw * (1 + (dayGain - 1) * dayMix),
      'Live gain edits update physical and shader strengths on the same current theme fraction');
    advance(0.22 + index * 0.1);
    const nextMix = (reference.shell.uniforms.musicRowSettings.value.y / raw - 1) / 10;
    close(f.shell.uniforms.musicRowSettings.value.y, raw * (1 + (dayGain - 1) * nextMix),
      'The next frame continues the existing theme clock with the edited gain');
    assert.deepEqual(f.light.getRowMotion(), reference.light.getRowMotion(),
      'The next frame follows the unchanged reference path without a restart or phase change');
  }
  blend.finish();
  f.light.update(f.model, f.camera, 0, true, true, opening, 0, frame);
  close(f.shell.uniforms.musicRowSettings.value.y, raw, 'A zero gain entered mid-transition still reaches unchanged night strength');
  close(f.light.area.intensity, 24 * raw * 0.3, 'Night physical lighting is independent of the last chosen daylight gain');
}

// The intro and navigation supply changing row coordinates through the same
// update path. Neither resets the day compensation or changes the raw setting.
for (const [theme, gain, areaBase] of [['day', 11, 18], ['night', 1, 24], ['dusk', 1, 34]]) {
  const f = setup(), key = new THREE.DirectionalLight(); f.scene.add(key);
  f.light.setExperiment({ mode: 'hybrid', strength: 1.3, width: 1.35, offset: 0.3, transitionDuration: 1.1 });
  f.light.setTheme(theme, key);
  for (const introTime of [21.92, 22.5, 23.4, 24.4, 25.5, 27.12]) {
    f.model.position.set(2 * ROW_LIGHTING.laneSpacing, 0, 17 * ROW_LIGHTING.rowSpacing);
    f.light.update(f.model, f.camera, 1 / 60, true, false, true, 0,
      { row: 17, lane: 2, introTime });
    assert.ok(f.light.getRowMotion().opening);
    close(f.shell.uniforms.musicRowSettings.value.y, 1.3 * gain, 'Opening retains the theme-adjusted shader ribbon strength');
    close(f.light.area.intensity, areaBase * (1.3 * gain) * 0.3, 'Opening retains the matching physical strip intensity');
    assert.equal(f.light.getExperiment().strength, 1.3, 'Opening never writes compensation into saved advanced settings');
  }
  for (const [row, lane] of [[18, 2], [19, 3], [16, 1], [17, 2]]) {
    f.model.position.set(lane * ROW_LIGHTING.laneSpacing, 0, row * ROW_LIGHTING.rowSpacing);
    f.light.update(f.model, f.camera, 1 / 60, true, false, false, 0, { row, lane });
    assert.equal(f.light.getRowMotion().opening, false);
    close(f.shell.uniforms.musicRowSettings.value.y, 1.3 * gain, 'Album/column switching retains the same effective ribbon strength');
  }
  f.light.update(f.model, f.camera, 0, false, false);
  f.light.resetRowMotion();
  f.light.update(f.model, f.camera, 0, true, true, false, 0, { row: 17, lane: 2 });
  close(f.shell.uniforms.musicRowSettings.value.y, 1.3 * gain, 'Hide/reset/reduced paths retain only the configured theme gain');
}

console.log('Row lighting passed: exact FWHM/offset units, seven-lane continuity, B fill/core exposure, warm-day-only adjustable 0/1/6/11/15/20x effective strength across shared shell/spine/return/print uniforms and real area light; old-preference migration/default 11x/existing valid gains/nonfinite/clamp20; unchanged raw preferences/broad sources/scatter/material inputs; exact night/dusk, continuous theme reversal/live strength/live gain without intro or row-follow restarts, intro/navigation/reset gain, same-world ownership, frame-rate-independent follow, stable light list, reduced motion and input bounds. GPU output and performance require the separate browser review.');
