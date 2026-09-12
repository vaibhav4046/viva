"use client";
import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { orbBands } from "@/components/orb/orbState";

/*
 * The VoiceOrb — VIVA's one piece of 3D, and the same object on the landing
 * and in the app (src/components/orb/Orb.tsx moves it between the two).
 *
 * It used to be a filled ball: a soft green sphere with a darker sphere inside
 * it and one blown-out white highlight. Sampled off the rendered PNG, the mean
 * lit pixel came out #85ac56 — a muddy olive nowhere near the product's
 * #b8ff5a — and none of the shader's internal detail survived at silence,
 * which is the only state most people ever see it in. The 700-byte SVG
 * icosahedron it falls back to on phones out-designed it, for three reasons
 * worth naming, because the rebuild is aimed at each:
 *
 *   1. it draws LINES, not a fill, so it is mostly dark and the lime is a
 *      stroke rather than a wash;
 *   2. those lines sit at full accent strength, never bleached toward white;
 *   3. the lines are crisp at any size, so there are real edges to read.
 *
 * So this is now dark glass carrying bright accent features rather than a lit
 * green solid. Four of them, all additive over the obsidian ground, all in
 * #b8ff5a:
 *
 *   - a limb: two nested fresnel rings, a wide one for the thickening of the
 *     glass toward the silhouette and a hard narrow one for the edge. Drawn
 *     double sided, so the far rim reads through the near one and the orb has
 *     an inside;
 *   - caustic filaments: ridged noise sampled along the refracted ray,
 *     sharpened to thin veins. These exist and drift at silence, on their own
 *     clock, which is the "something moving slowly" the object was missing;
 *   - isolines etched on the surface, antialiased with fwidth so they stay
 *     one pixel wide however big the orb is drawn. Their sample point is the
 *     DISPLACED position, so a travelling wave drags the whole pattern across
 *     the face. That is the visible difference between a ball that inflates
 *     when you talk and a surface that moves when you talk;
 *   - one tight specular, and a small core behind the glass for the caustics
 *     to imply a source for.
 *
 * The shell is displaced by three octaves of simplex noise, one per audio
 * band. Normals are rebuilt per vertex from the displaced surface (two finite
 * differences across the tangent plane); lighting the displaced mesh with the
 * undisplaced normal is why an earlier version read as a shaded ball with a
 * wobbling outline.
 *
 * The three bands come from src/components/orb/orbState.ts, driven by the one
 * microphone VIVA already opens. Nothing here touches getUserMedia.
 */

/* Ashima / Stefan Gustavson 3D simplex noise (MIT). Compact and branch-free. */
const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(
      i.z+vec4(0.0,i1.z,i2.z,1.0))
    + i.y+vec4(0.0,i1.y,i2.y,1.0))
    + i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

/*
 * One displacement field, three octaves, one per band. Each octave carries its
 * own clock and each clock accelerates with its own band — that is the whole
 * difference between a ball that inflates when you talk and a surface that
 * travels when you talk.
 */
const FIELD = /* glsl */ `
uniform float uT1; uniform float uT2; uniform float uT3;
uniform float uALow; uniform float uAMid; uniform float uAHigh;
float field(vec3 n) {
  return snoise(n * 0.95 + vec3(0.0, 0.0, uT1)) * uALow
       + snoise(n * 2.70 + vec3(uT2, 0.0, 0.0)) * uAMid
       + snoise(n * 5.60 + vec3(0.0, uT3, 0.0)) * uAHigh;
}
`;

const SHELL_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
varying float vF;
${SIMPLEX}
${FIELD}
void main() {
  // icosahedronGeometry(1, n) puts every vertex on the unit sphere, so the
  // position doubles as the sample direction.
  vec3 n = normalize(position);
  float f = field(n);
  vec3 p = n * (1.0 + f);

  // Rebuild the normal from the displaced surface: two steps across the
  // tangent plane, displace both, cross the resulting edges.
  vec3 t1 = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : vec3(1.0, 0.0, 0.0));
  vec3 t2 = cross(n, t1);
  vec3 na = normalize(n + t1 * 0.06);
  vec3 nb = normalize(n + t2 * 0.06);
  vec3 a = na * (1.0 + field(na));
  vec3 b = nb * (1.0 + field(nb));
  vec3 nrm = normalize(cross(a - p, b - p));
  if (dot(nrm, n) < 0.0) nrm = -nrm;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * nrm);
  vV = normalize(-mv.xyz);
  vP = p;
  vF = f;
  gl_Position = projectionMatrix * mv;
}
`;

const SHELL_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uRim;
uniform vec3 uSpec;
uniform float uTime;
uniform float uLevel;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
varying float vF;
${SIMPLEX}
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vV);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float rim = 1.0 - ndv;
  // The far wall is the same glass seen through the near one, so it is dimmer
  // but never absent — reading it through the front is most of what makes an
  // orb feel hollow rather than solid.
  float back = gl_FrontFacing ? 1.0 : 0.5;

  // Two nested limbs. The wide one is the glass thickening toward the
  // silhouette; the narrow one is the hard edge that makes this an object and
  // not a fog. Both at full accent — bleaching these to white is exactly what
  // used to leave the orb with no colour anywhere it was bright.
  float limb = pow(rim, 3.2);
  float edge = pow(rim, 13.0);

  // Light focused through the lens. Ridged noise along the refracted ray,
  // sharpened into veins, on its own slow clock so the inside of the orb is
  // never still even when nobody is talking.
  vec3 R = refract(-V, N, 0.62);
  float n1 = snoise(vP * 1.05 + R * 0.80 + vec3(0.0, 0.0, uTime * 0.14));
  float caustic = pow(1.0 - abs(n1), 7.0);

  // Isolines etched on the surface, one pixel wide at any size because the
  // band is measured in screen-space derivatives rather than in field units.
  // The sample point is the DISPLACED position and the field is added on top,
  // so a travelling wave drags the whole pattern across the face instead of
  // the orb simply getting bigger.
  float s = vP.y * 4.6 + uTime * 0.07 + vF * 10.0;
  float w = max(fwidth(s), 1e-4);
  float line = 1.0 - smoothstep(0.0, 1.35 * w, abs(fract(s) - 0.5));

  // A few meridians under the latitudes. Two families of lines is what turns
  // a striped ball into a globe with a front and a back, and it is the read
  // the SVG fallback gets for free from having actual edges.
  float m = atan(vP.x, vP.z) * 1.43 + vF * 4.0;
  float mw = max(fwidth(m), 1e-4);
  float mer = 1.0 - smoothstep(0.0, 1.1 * mw, abs(fract(m) - 0.5));

  // One hard light, up and to the left, and only on the near surface: letting
  // the flipped back-face normal make a highlight too put a second white spot
  // in the middle, which read as a defect rather than as depth.
  vec3 L = normalize(vec3(-0.55, 0.75, 0.62));
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 220.0) * (gl_FrontFacing ? 1.0 : 0.0);

  vec3 col = uRim * limb * (0.16 + uLevel * 0.30) * back
           + uRim * edge * (2.60 + uLevel * 1.40) * back
           + uRim * caustic * (0.26 + uLevel * 0.85) * back * (0.42 + 0.58 * rim)
           + uRim * line * (1.55 + uLevel * 1.20) * back * (0.74 + 0.26 * rim) * (0.72 + 0.55 * caustic)
           + uRim * mer * (0.52 + uLevel * 0.62) * back * (0.74 + 0.26 * rim) * (0.72 + 0.55 * caustic)
           + uRim * (0.050 + 0.10 * caustic)
           + uSpec * spec * 1.15;

  // Lime is far off white (184, 255, 90), so a naive sum clips green long
  // before red and every bright pixel drifts to a poster-paint yellow-green.
  // Divide the whole triple by its own peak instead: overdriven pixels land
  // exactly on the accent rather than on a clipped version of it, which is the
  // difference between "the accent lit through glass" and "some green". Only
  // what is genuinely far over one is then bleached, the way a light source is.
  float hot = max(max(col.r, col.g), col.b);
  col /= max(hot, 1.0);
  col = mix(col, vec3(1.0), clamp((hot - 1.35) * 0.30, 0.0, 0.60));

  // Additive over obsidian: order independent with no depth sort, and it is
  // what "the accent lit through glass" actually is. The middle of the orb
  // adds almost nothing, so the ground and the halo show through it.
  gl_FragColor = vec4(col, 1.0);
}
`;

const CORE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
${SIMPLEX}
${FIELD}
void main() {
  vec3 n = normalize(position);
  // Half the shell's deformation, so the core drifts inside it instead of
  // moving with it. That parallax is what the glass has to hold.
  vec3 p = position * (1.0 + field(n) * 0.5);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * n);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const CORE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uRim;
uniform float uLevel;
varying vec3 vN;
varying vec3 vV;
void main() {
  // Falls away well inside its own silhouette, so it reads as the source the
  // caustics imply rather than as a second ball with an edge of its own.
  float c = pow(clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 7.0);
  vec3 col = uRim * c * (0.48 + uLevel * 1.9);
  float hot = max(max(col.r, col.g), col.b);
  gl_FragColor = vec4(mix(col, vec3(hot), clamp((hot - 1.0) * 0.7, 0.0, 0.6)), 1.0);
}
`;

/** Breathing amplitude at silence, and the ceiling a shouted phrase reaches. */
const IDLE_AMP = 0.022;
const LOUD_AMP = 0.44;

function Orb({ detail }: { detail: number }) {
  const group = useRef<THREE.Group>(null);

  // Both materials share these objects, so one write per frame moves both.
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uT1: { value: 0 },
      uT2: { value: 0 },
      uT3: { value: 0 },
      uALow: { value: IDLE_AMP },
      uAMid: { value: 0 },
      uAHigh: { value: 0 },
      uLevel: { value: 0 },
      uRim: { value: new THREE.Color("#b8ff5a") },
      uSpec: { value: new THREE.Color("#eaffd0") },
    }),
    []
  );

  useFrame((_, rawDelta) => {
    // A backgrounded tab hands back one enormous delta on return; clamp it or
    // the surface teleports.
    const delta = Math.min(rawDelta, 1 / 20);
    const { level, low, mid, high } = orbBands;

    uniforms.uTime.value += delta;
    const t = uniforms.uTime.value;

    uniforms.uT1.value += delta * (0.18 + low * 0.5);
    uniforms.uT2.value += delta * (0.35 + mid * 1.1);
    uniforms.uT3.value += delta * (0.7 + high * 2.4);

    // At rest: a slow breath. Under a voice: broad lobes from the phrase,
    // ripples from the syllables, chop from the consonants.
    uniforms.uALow.value = IDLE_AMP + Math.sin(t * 0.9) * 0.012 + low * (LOUD_AMP - IDLE_AMP);
    uniforms.uAMid.value = mid * 0.22;
    uniforms.uAHigh.value = high * 0.105;
    uniforms.uLevel.value = level;

    if (group.current) group.current.rotation.y += delta * 0.12;
  });

  return (
    <group ref={group} rotation={[0.18, 0, 0.08]}>
      <mesh renderOrder={0}>
        <icosahedronGeometry args={[0.46, Math.max(2, detail - 2)]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={CORE_VERT}
          fragmentShader={CORE_FRAG}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh renderOrder={1}>
        <icosahedronGeometry args={[1, detail]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={SHELL_VERT}
          fragmentShader={SHELL_FRAG}
          transparent
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

/**
 * @param detail Icosahedron subdivision. 5 on a desktop GPU, 4 when the mount
 *               judges the machine modest.
 * @param paused Stops the loop outright when the orb is off screen.
 *               `frameloop="never"` costs nothing; a `useFrame` early return
 *               would still clear and redraw the buffer sixty times a second.
 */
export default function VoiceOrb({ detail = 5, paused = false }: { detail?: number; paused?: boolean }) {
  return (
    <Canvas
      dpr={[1, 2]}
      /*
       * Measure the layout box, not the painted one.
       *
       * The host scales this canvas with a CSS transform to move it between
       * slots, and r3f's default measurement is getBoundingClientRect — the
       * post-transform size. It then set the canvas to that many CSS pixels
       * inside an already scaled parent, so the orb rendered at the square of
       * the scale (90 px inside a 147 px box) and the drawing buffer was
       * reallocated on every frame of the move. offsetSize reads
       * offsetWidth/offsetHeight instead, which the transform does not touch:
       * one 240 px buffer, allocated once, scaled by the compositor.
       */
      resize={{ offsetSize: true }}
      frameloop={paused ? "never" : "always"}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 3.1], fov: 42 }}
      style={{ width: "100%", height: "100%" }}
    >
      <Orb detail={detail} />
    </Canvas>
  );
}
