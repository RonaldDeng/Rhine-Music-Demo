import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

const source = fs.readFileSync(new URL('../src/music-lighting.ts', import.meta.url), 'utf8');
const moduleUrl = new URL('../node_modules/three/build/three.module.js', import.meta.url).href;
const code = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace('"three"', JSON.stringify(moduleUrl));
const { MusicSelectionLighting } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
function setup() {
  const light = new MusicSelectionLighting(new THREE.Scene());
  const model = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(); camera.position.set(-62,36,43); camera.lookAt(0,0,0);
  light.update(model,camera,0,true,true);
  const shader = {uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <opaque_fragment>'};
  light.shade(shader,'Frosted_Polymer');
  return {light,model,camera,column:shader.uniforms.musicLightColumn.value};
}
const a=setup(), b=setup();
a.model.position.x=b.model.position.x=5.2;
a.light.update(a.model,a.camera,.1,true,false);
assert.ok(a.column.x>0 && a.column.x<.5,'Light begins gradually with the lift');
for(let i=0;i<12;i++)b.light.update(b.model,b.camera,1/120,true,false);
assert.ok(a.column.distanceTo(b.column)<1e-9,'Light transition is independent of frame rate');
const before=a.column.clone();
a.model.position.x=-5.2;
a.light.update(a.model,a.camera,1/60,true,false);
assert.ok(a.column.distanceTo(before)<.2,'Rapid reversal preserves position and velocity continuity');
a.light.update(a.model,a.camera,0,true,true);
assert.equal(a.column.x,-5.2,'Reduced motion snaps to the selected location');
for(const position of [[-62,36,43],[-20,17,67]]) {
  a.camera.position.set(...position);a.camera.lookAt(0,0,0);
  a.light.update(a.model,a.camera,0,true,true);
  const delta=a.light.spot.position.clone().sub(a.light.spot.target.position).applyQuaternion(a.camera.quaternion.clone().invert());
  assert.ok(delta.x<0 && delta.y<0,'Key remains screen lower-left in shelf and detail');
}
a.light.update(a.model,a.camera,0,false,false);
assert.equal(a.light.spot.visible,false);
assert.equal(a.light.spot.castShadow,false);
console.log('Music lighting passed: gradual start, frame-rate independence, rapid reversal, reduced motion, lower-left direction, empty-library disable.');
