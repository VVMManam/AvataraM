// "Chinna" mode: turns the adult 3D models into kids and dresses them per language.
// Runs after TalkingHead.showAvatar(). Settings live in config/personas.json:
//   avatars.<F|M>.child  -> body proportions, hidden meshes, skin/hair tint, material names
//   languages.<code>.<F|M>.outfit -> { top, bottom, shoes } colours for that language
import * as THREE from "three";

const original = new WeakMap();   // material -> { map, color } as loaded
const grayCache = new WeakMap();  // texture  -> brightened grayscale copy

export function makeChild(head, child) {
  if (!child || !head.armature) return;
  const a = head.armature;
  for (const [bone, s] of Object.entries(child.bones || {})) {
    const o = a.getObjectByName(bone);
    if (o) o.scale.setScalar(s);
  }
  for (const name of child.hide || []) {
    const o = a.getObjectByName(name);
    if (o) o.visible = false;
  }
  tint(a, child.parts?.skin, child.skin, false);
  tint(a, child.parts?.hair, child.hair, true);

  // Re-frame the camera for the new (shorter) eye level
  a.updateMatrixWorld(true);
  const eye = new THREE.Vector3();
  head.objectLeftEye.getWorldPosition(eye);
  head.avatarHeight = eye.y + 0.2;
  head.setView(head.viewName || "upper");
}

export function dress(head, child, outfit) {
  if (!child || !head.armature) return;
  for (const part of ["top", "bottom", "shoes"]) {
    tint(head.armature, child.parts?.[part], outfit?.[part], true);
  }
}

// Recolour the materials named in `names`. recolor=true replaces the garment colour
// (keeps its folds/pattern as shading); false multiplies the colour over the texture.
function tint(root, names, hex, recolor) {
  if (!names) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!names.includes(m.name)) continue;
      if (!original.has(m)) original.set(m, { map: m.map, color: m.color.clone() });
      const orig = original.get(m);
      if (!hex) { m.map = orig.map; m.color.copy(orig.color); }
      else {
        m.map = recolor && orig.map ? grayscale(orig.map) : orig.map;
        m.color.set(hex);
      }
      m.needsUpdate = true;
    }
  });
}

function grayscale(tex) {
  if (grayCache.has(tex)) return grayCache.get(tex);
  const img = tex.image;
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  const lum = new Float32Array(p.length / 4);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < p.length; i += 4, j++) {
    lum[j] = 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
    if (p[i + 3] > 10) hist[lum[j] | 0]++;
  }
  // 95th percentile -> white, so dark clothes still take a bright new colour
  let total = hist.reduce((s, x) => s + x, 0), acc = 0, p95 = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.95) { p95 = Math.max(v, 1); break; } }
  for (let i = 0, j = 0; i < p.length; i += 4, j++) {
    const v = 255 * Math.min(1, 0.3 + 0.75 * (lum[j] / p95));
    p[i] = p[i + 1] = p[i + 2] = v;
  }
  g.putImageData(d, 0, 0);
  const t = tex.clone();
  t.image = c;
  t.needsUpdate = true;
  grayCache.set(tex, t);
  return t;
}
