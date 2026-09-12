"use client";
import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { orbBands } from "@/components/orb/orbState";

/*
 * The VoiceOrb — VIVA's one piece of 3D, and the same object on the landing
 * and in the app (src/components/orb/Orb.tsx moves it between the two).
 *
 * Two procedural meshes, no post-processing, no GLB, no environment map:
 *
 *   1. a glass shell — an icosahedron displaced by three octaves of simplex
 *      noise, one per audio band, shaded as glass rather than as a lit solid:
 *      chromatic fresnel at the silhouette, one tight specular, and two steps
 *      of a refracted ray through a noise volume for internal depth. Drawn
 *      double sided with the far faces dimmed, so you read the back rim
 *      through the front one, which is most of what makes glass look glass;
 *   2. a small additive core behind it that swells with loudness, so the
 *      shell has something to refract and the orb has a centre.
 *
 * Normals are rebuilt per vertex from the displaced surface (two finite
 * differences across the tangent plane). The previous version lit the
 * displaced mesh with the undisplaced normal, which is why it read as a
 * shaded ball with a wobbling outline rather than as a deformed surface.
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
${SIMPLEX}
${FIELD}
void main() {
  // icosahedronGeometry(1, n) puts every vertex on the unit sphere, so the
  // position doubles as the sample direction.
  vec3 n = normalize(position);
  vec3 p = n * (1.0 + field(n));

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
  gl_Position = projectionMatrix * mv;
}
`;

const SHELL_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uRim;
uniform vec3 uDeep;
uniform vec3 uSpec;
uniform float uTime;
uniform float uLevel;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
${SIMPLEX}
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vV);
  float ndv = clamp(dot(N, V), 0.0, 1.0);

  // Chromatic fresnel. Glass is bright at the limb and thin at the centre;
  // three exponents give the edge a prism cast for two extra pow().
  float rim = 1.0 - ndv;
  vec3 fres = vec3(pow(rim, 2.0), pow(rim, 2.45), pow(rim, 3.1));

  // One hard light, up and to the left. Tight specular plus a wide sheen.
  vec3 L = normalize(vec3(-0.55, 0.75, 0.62));
  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  // Only the near surface gets a highlight. Letting the flipped back-face
  // normal produce one too put a second white spot in the middle of the orb,
  // which read as a defect rather than as depth.
  float facing = gl_FrontFacing ? 1.0 : 0.0;
  float spec = pow(ndh, 90.0) * facing;
  float sheen = pow(ndh, 10.0) * 0.16 * facing;

  // Internal depth: one low-frequency field sampled along the refracted ray.
  // Low frequency and low contrast on purpose — at higher settings this reads
  // as camouflage rather than as light moving inside a solid.
  vec3 R = refract(-V, N, 0.72);
  float inner = snoise(vP * 1.30 + R * 0.85 + vec3(0.0, 0.0, uTime * 0.11)) * 0.5 + 0.5;
  inner = 0.34 + 0.52 * smoothstep(0.22, 0.92, inner + uLevel * 0.18);

  // Thicker glass through the middle absorbs more, so the centre stays deep
  // and the limb carries the light.
  // Light focused through the lens onto the far wall.
  float caustic = pow(max(dot(-N, L), 0.0), 5.0) * 0.35;

  // A plain diffuse term off the rebuilt normal. Without it the travelling
  // ripples only ever showed at the silhouette, and a wide soft fresnel band
  // swallowed most of that: the surface has to catch the light across its
  // whole face before a wave reads as a wave.
  float diff = max(dot(N, L), 0.0);

  // The far wall of the shell carries its own fresnel, and reading it through
  // the near wall is what gives the orb thickness — a second, smaller ring
  // inside the first. Dimming the back faces into invisibility was what made
  // the middle look like a dead grey annulus.
  float wall = gl_FrontFacing ? 1.0 : 0.85;

  vec3 tint = mix(uDeep, uRim, inner);
  vec3 col = tint * (0.34 + 0.78 * inner) * (0.80 + 0.20 * rim) * (0.80 + uLevel * 0.75)
           + uRim * fres * wall * (2.30 + uLevel * 1.6)
           + uRim * diff * diff * 0.30 * wall
           + uRim * caustic
           + uSpec * spec * 1.7
           + uRim * sheen;

  // Lime is far off white, so summed emission clips green first and the orb
  // turns poster-paint. Bleach the hottest parts toward white the way a real
  // light source does, and the accent stays lime where it is dim.
  float hot = max(max(col.r, col.g), col.b);
  col = mix(col, vec3(hot), clamp((hot - 0.75) * 0.9, 0.0, 0.7));

  float alpha = clamp(0.16 + inner * 0.14 + fres.g * 1.05 + spec, 0.0, 1.0);
  // The far side of the shell reads through the near side, but quietly.
  if (!gl_FrontFacing) alpha *= 0.8;
  gl_FragColor = vec4(col, alpha);
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
  // Falls to nothing well inside its own silhouette, so the core reads as
  // light suspended in the glass rather than as a second ball with an edge.
  float c = pow(clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 2.6);
  vec3 col = uRim * c * (0.62 + uLevel * 1.6);
  float hot = max(max(col.r, col.g), col.b);
  gl_FragColor = vec4(mix(col, vec3(hot), clamp((hot - 0.7) * 0.9, 0.0, 0.75)), 1.0);
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
      uDeep: { value: new THREE.Color("#0a2a1a") },
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
        <icosahedronGeometry args={[0.62, Math.max(2, detail - 2)]} />
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
