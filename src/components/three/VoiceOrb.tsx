"use client";
import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

/*
 * The VoiceOrb — VIVA's one piece of 3D.
 *
 * Procedural, so there is no GLB to download and nothing to go soft on a 4K
 * or 8K panel: an icosahedron whose vertices are pushed along their normals by
 * 3D simplex noise, lit only by a fresnel rim in cognition lime over a near
 * black core. It breathes while idle and swells with the microphone level.
 *
 * Loaded only by src/components/VoiceOrbMount.tsx, which keeps three.js out of
 * the first paint and paints a CSS gradient instead when WebGL is missing or
 * the reader has asked for reduced motion.
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

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uAmp;
varying vec3 vNormalV;
varying vec3 vViewDir;
${SIMPLEX}
void main() {
  float n = snoise(normal * 1.6 + vec3(0.0, 0.0, uTime * 0.28));
  vec3 displaced = position + normal * n * uAmp;
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uRim;
uniform vec3 uCore;
uniform float uGlow;
varying vec3 vNormalV;
varying vec3 vViewDir;
void main() {
  float fresnel = 1.0 - max(dot(normalize(vNormalV), normalize(vViewDir)), 0.0);
  fresnel = pow(fresnel, 4.0);
  vec3 colour = mix(uCore, uRim, clamp(fresnel * uGlow, 0.0, 1.0));
  gl_FragColor = vec4(colour, 1.0);
}
`;

/** Idle breathing amplitude, and the ceiling a loud voice reaches. */
const IDLE_AMP = 0.04;
const LOUD_AMP = 0.35;

function Orb({ level, detail }: { level: number; detail: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmp: { value: IDLE_AMP },
      uGlow: { value: 1 },
      uRim: { value: new THREE.Color("#b8ff5a") },
      uCore: { value: new THREE.Color("#0a0a0b") },
    }),
    []
  );

  useFrame((_, delta) => {
    uniforms.uTime.value += delta;
    // Breathe when nothing is being said, swell towards the live level.
    const target = IDLE_AMP + level * (LOUD_AMP - IDLE_AMP);
    uniforms.uAmp.value += (target - uniforms.uAmp.value) * Math.min(1, delta * 6);
    uniforms.uGlow.value = 0.85 + level * 0.9;
    if (mesh.current) mesh.current.rotation.y += delta * 0.12;
  });

  return (
    <mesh ref={mesh}>
      <icosahedronGeometry args={[1, detail]} />
      <shaderMaterial uniforms={uniforms} vertexShader={VERTEX} fragmentShader={FRAGMENT} />
    </mesh>
  );
}

/**
 * @param level  0 to 1 microphone loudness. 0 leaves the orb breathing.
 * @param detail Icosahedron subdivision; the mount drops it to 3 on phones.
 */
export default function VoiceOrb({ level = 0, detail = 5 }: { level?: number; detail?: number }) {
  return (
    <Canvas
      dpr={[1, 2]}
      frameloop="always"
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 3.1], fov: 42 }}
      style={{ width: "100%", height: "100%" }}
    >
      <Orb level={level} detail={detail} />
    </Canvas>
  );
}
