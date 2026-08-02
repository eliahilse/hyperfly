"use client";

import { useEffect, useRef } from "react";

const GLYPHS = ["{", "}", ":", ",", '"', "[", "]", "0", "1", "0", "1", "A", "F", "3", "E", "▚", "▓", "█"];
const JSON_SET = 7;
const HEX_SET = 8;
const ATLAS_CELL = 64;

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2 uResolution;
uniform vec2 uCell;
uniform vec2 uPointer;
uniform float uTime;
uniform float uCount;
uniform float uMotion;
uniform sampler2D uGlyphs;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy / uCell);
  vec2 center = (cell + 0.5) * uCell;
  vec2 uv = center / uResolution;
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  float x = uv.x;
  float t = uTime * uMotion;

  // the duct contracts downstream, so the same stream has to travel faster and denser
  float axis = mix(0.52, 0.34, smoothstep(0.0, 1.0, x));
  float throat = mix(0.30, 0.055, smoothstep(0.02, 0.94, x));
  float lane = (uv.y - axis) / throat;
  float duct = 1.0 - smoothstep(0.62, 1.0, abs(lane));

  float speed = mix(0.30, 1.35, smoothstep(0.0, 1.0, x));
  float flow = fbm(vec2(x * 2.6 - t * speed * 0.55, lane * 1.7 + 4.0));
  float density = mix(0.46, 1.0, smoothstep(0.05, 0.9, x));
  float core = clamp((flow * 1.55 - 0.34), 0.0, 1.0) * duct * density;

  // what the schema already knows is shed before the throat, never entering the stream
  float shedFade = 1.0 - smoothstep(0.1, 0.62, x);
  float shedBand = smoothstep(2.1, 0.85, abs(lane)) * (1.0 - duct);
  float shed = clamp(fbm(vec2(x * 3.8 - t * 0.2, uv.y * 8.0)) * 1.35 - 0.72, 0.0, 1.0);
  shed *= shedFade * shedBand * 0.5;

  float intensity = clamp(core + shed, 0.0, 1.0);

  vec2 pointer = uPointer / uResolution;
  float d = distance(vec2(uv.x * aspect, uv.y), vec2(pointer.x * aspect, pointer.y));
  intensity += 0.22 * exp(-d * 9.0) * step(0.02, intensity);

  vec2 fromCenter = (uv - vec2(0.25, 0.52)) / vec2(0.38, 0.46);
  float clearing = smoothstep(0.7, 1.26, length(fromCenter));
  float edges = smoothstep(0.0, 0.04, uv.x) * smoothstep(0.0, 0.03, 1.0 - uv.x)
              * smoothstep(0.0, 0.05, uv.y);
  intensity *= clearing * edges;

  if (intensity < 0.015) discard;

  float march = floor(t * 7.0 * speed);
  vec2 seed = vec2(cell.x - march, cell.y);
  float r = hash(seed);
  float r2 = hash(seed + 17.3);

  float jsonIdx = floor(r * ${JSON_SET}.0);
  float hexIdx = ${JSON_SET}.0 + floor(r * ${HEX_SET}.0);
  float blockIdx = uCount - 3.0 + floor(r * 3.0);

  float compiled = step(r2, smoothstep(0.18, 0.62, x));
  float index = mix(jsonIdx, hexIdx, compiled);
  index = mix(index, blockIdx, step(0.74, core) * step(0.62, x));

  vec2 inCell = fract(gl_FragCoord.xy / uCell);
  vec2 atlas = vec2((index + inCell.x) / uCount, 1.0 - inCell.y);
  float glyph = texture2D(uGlyphs, atlas).r;

  vec3 raw = vec3(0.52, 0.56, 0.66);
  vec3 compiledTint = vec3(0.36, 0.80, 0.98);
  vec3 tint = mix(raw, compiledTint, smoothstep(0.4, 0.95, x) * 0.9);

  gl_FragColor = vec4(tint * glyph * (0.14 + intensity * 0.76), 1.0);
}
`;

function glyphFontFamily(): string {
  const resolved = getComputedStyle(document.body)
    .fontFamily.split(",")
    .map((part) => part.trim())
    .filter((part) => !part.startsWith("var("))
    .join(", ");
  return resolved || "ui-monospace, monospace";
}

function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_CELL * GLYPHS.length;
  canvas.height = ATLAS_CELL;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(ATLAS_CELL * 0.66)}px ${glyphFontFamily()}`;
  for (let i = 0; i < GLYPHS.length; i++) {
    ctx.fillText(GLYPHS[i]!, i * ATLAS_CELL + ATLAS_CELL / 2, ATLAS_CELL / 2 + 1);
  }
  return canvas;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function StreamField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const gl = (canvas.getContext("webgl2", { antialias: false, alpha: true }) ??
      canvas.getContext("webgl", { antialias: false, alpha: true })) as WebGLRenderingContext | null;
    if (!gl) return;

    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vert || !frag) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const uploadAtlas = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buildAtlas());
    };
    uploadAtlas();
    void document.fonts?.ready.then(uploadAtlas).catch(() => {});

    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const uResolution = uniform("uResolution");
    const uCell = uniform("uCell");
    const uPointer = uniform("uPointer");
    const uTime = uniform("uTime");
    const uMotion = uniform("uMotion");
    gl.uniform1i(uniform("uGlyphs"), 0);
    gl.uniform1f(uniform("uCount"), GLYPHS.length);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let motion = reduced.matches ? 0 : 1;
    const onMotionChange = () => {
      motion = reduced.matches ? 0 : 1;
    };
    reduced.addEventListener("change", onMotionChange);

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      pointer.tx = (event.clientX - rect.left) * dpr;
      pointer.ty = (rect.height - (event.clientY - rect.top)) * dpr;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.floor(canvas.clientWidth * dpr);
      const height = Math.floor(canvas.clientHeight * dpr);
      if (width === 0 || height === 0) return;
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uResolution, width, height);
      const size = Math.max(8, Math.round(10 * dpr));
      gl.uniform2f(uCell, size, Math.round(size * 1.35));
      pointer.x = width * 0.5;
      pointer.y = height * 0.4;
      pointer.tx = pointer.x;
      pointer.ty = pointer.y;
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let raf = 0;
    let running = true;
    const start = performance.now();
    const frame = (now: number) => {
      if (!running) return;
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      gl.uniform2f(uPointer, pointer.x, pointer.y);
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform1f(uMotion, motion);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const pause = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
    };
    const resume = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.hidden) pause();
      else resume();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // the field only exists behind the hero; keep the GPU idle once it scrolls away
    const inView = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) resume();
        else pause();
      },
      { rootMargin: "120px" },
    );
    inView.observe(canvas);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      inView.disconnect();
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotionChange);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
    };
  }, []);

  return <canvas ref={ref} className="stream-field" aria-hidden="true" />;
}
