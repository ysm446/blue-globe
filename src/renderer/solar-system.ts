// 太陽系の場面。地球ビューから引いていくと、太陽と惑星と軌道が見える。
// 座標は AU で、星のデータと同じ J2000 の赤道座標 (向きは equatorialToScene)。地球の場面とは別に描いて重ねる。
// 地球の場面は地球を原点に置き、星を恒星時の分だけ回しているので、その回転で 2 つの場面のカメラを対応させる
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { easeInOut, smoothstep, type Vec3 } from './math';
import { PlanetLabels } from './planet-labels';
import { heliocentricPositions, orbitPoints, PLANETS } from './planets';
import { createSun, SUN_SIZE_RATIO, type Sky } from './sky';
import {
  AU_IN_EARTH_RADII,
  ECLIPTIC_NORTH,
  equatorialToScene,
  overviewPose,
  solarFlightPose,
  type SolarPose,
} from './solar-flight';

const FLY_SECONDS = 4.5;
const OVERVIEW_DISTANCE = 5; // 火星の軌道まで大きく見え、木星の軌道もかかる距離 (AU)
const OVERVIEW_ELEVATION = 35; // 黄道から見下ろす角度
const MIN_DISTANCE = 0.5;
const MAX_DISTANCE = 80; // 海王星の軌道 (約 30 AU) が収まる
const ORBIT_SEGMENTS = 256;
const DOT_SIZE = 7; // 惑星の点の大きさ (CSS ピクセル)
const SUN_DOT_SIZE = 11;
const FADE_NEAR = 0.002; // 地球からこの距離 (AU) を過ぎると点と軌道が現れ始め、
const FADE_FAR = 0.05; // ここで出そろう。地球のすぐそばでは地球ビューの見た目のまま引き始める
const EARTH_DOT_PIXELS = 6; // 地球がこれより小さく写ると、地球の場面の代わりに点で描く
const EARTH_LABEL_PIXELS = 40;

// 見分けやすさを優先した表示の色
const PLANET_COLORS = ['#b8b1a8', '#f2e3b3', '#e0754a', '#e3c89c', '#e8d08a', '#9fe0e6', '#7f9cff'];
const EARTH_COLOR = '#6fa8ff';

const DOT_VS = /* glsl */ `
attribute vec3 dotColor;
uniform float uSize;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vColor = dotColor;
  gl_PointSize = uSize * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOT_FS = /* glsl */ `
precision highp float;
uniform float uOpacity;
uniform float uIntensity;
varying vec3 vColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float alpha = smoothstep(1.0, 0.7, r) * uOpacity;
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(vColor * uIntensity, alpha);
  #include <colorspace_fragment>
}
`;

type SolarState = 'off' | 'entering' | 'on' | 'leaving';

interface Flight {
  from: SolarPose;
  to: SolarPose;
  elapsed: number;
  startQuaternion: THREE.Quaternion; // 地域ビューのように地球の中心を見ていない姿勢からも、なめらかに向きを変える
  done?: () => void;
}

type Dots = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
type Orbit = THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;

function createDots(colors: string[], size: number, intensity: number, pixelRatio: { value: number }): Dots {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(colors.length * 3), 3));
  const colorArray = new Float32Array(colors.length * 3);
  colors.forEach((hex, i) => new THREE.Color(hex).toArray(colorArray, i * 3));
  geometry.setAttribute('dotColor', new THREE.BufferAttribute(colorArray, 3));
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: { uSize: { value: size }, uPixelRatio: pixelRatio, uOpacity: { value: 1 }, uIntensity: { value: intensity } },
      vertexShader: DOT_VS,
      fragmentShader: DOT_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  points.frustumCulled = false;
  return points;
}

const toVector = (v: Vec3, target = new THREE.Vector3()): THREE.Vector3 => target.set(v[0], v[1], v[2]);

export class SolarSystem {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly earth = new THREE.Vector3(); // 地球の位置 (AU)
  private readonly controls: OrbitControls;
  private readonly pixelRatio: { value: number };
  private readonly stars: THREE.Points;
  private readonly sun = createSun(SUN_SIZE_RATIO);
  private readonly sunDot: Dots;
  private readonly planetDots: Dots;
  private readonly earthDot: Dots;
  private readonly orbits: Orbit[];
  private readonly labels: PlanetLabels;
  private readonly planetPositions = PLANETS.map(() => new THREE.Vector3());
  private readonly sunPosition = new THREE.Vector3();
  private state: SolarState = 'off';
  private flight: Flight | null = null;
  private readonly rotation = new THREE.Quaternion(); // この場面から地球の場面への回転 (恒星時の分)
  private readonly matrix = new THREE.Matrix4();
  private readonly scratch = new THREE.Vector3();

  constructor(sky: Sky, background: THREE.Texture, domElement: HTMLElement, labelContainer: HTMLElement, pixelRatio: number) {
    this.scene.background = background;
    this.camera = new THREE.PerspectiveCamera(45, 1, 1e-6, 200);
    this.camera.up.set(...ECLIPTIC_NORTH); // 軌道の面を水平に見せる (OrbitControls は作るときの up を回転の軸にする)
    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = MIN_DISTANCE;
    this.controls.maxDistance = MAX_DISTANCE;
    this.pixelRatio = { value: pixelRatio };

    // 星は地球の場面と同じものを、カメラを中心に描く
    this.stars = new THREE.Points(sky.stars.geometry, sky.stars.material);
    this.stars.frustumCulled = false;
    this.sunDot = createDots(['#fff4dc'], SUN_DOT_SIZE, 4, this.pixelRatio);
    this.planetDots = createDots(PLANET_COLORS, DOT_SIZE, 1, this.pixelRatio);
    this.earthDot = createDots([EARTH_COLOR], DOT_SIZE, 1, this.pixelRatio);
    // 最後の 1 本は地球の軌道
    this.orbits = Array.from({ length: PLANETS.length + 1 }, (_, i): Orbit => {
      const earthOrbit = i === PLANETS.length;
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setAttribute(
          'position',
          new THREE.BufferAttribute(new Float32Array(ORBIT_SEGMENTS * 3), 3),
        ),
        new THREE.LineBasicMaterial({
          color: earthOrbit ? EARTH_COLOR : '#9db4d6',
          transparent: true,
          opacity: earthOrbit ? 0.6 : 0.35,
          depthTest: false,
          depthWrite: false,
        }),
      );
      line.frustumCulled = false;
      line.renderOrder = 1;
      return line;
    });
    this.sun.renderOrder = 2;
    this.sunDot.renderOrder = 3;
    this.planetDots.renderOrder = 4;
    this.earthDot.renderOrder = 5;
    this.scene.add(this.stars, ...this.orbits, this.sun, this.sunDot, this.planetDots, this.earthDot);
    this.labels = new PlanetLabels(labelContainer, [...PLANETS.map((p) => p.name), '地球', '太陽'], null);
  }

  get active(): boolean {
    return this.state !== 'off';
  }

  // 引いている途中か、太陽系を見ている間
  get entered(): boolean {
    return this.state === 'entering' || this.state === 'on';
  }

  setPixelRatio(pixelRatio: number): void {
    this.pixelRatio.value = pixelRatio;
  }

  setTime(date: Date): void {
    const { earth, planets } = heliocentricPositions(date);
    toVector(equatorialToScene(earth), this.earth);
    const dots = this.planetDots.geometry.attributes.position;
    planets.forEach((planet, i) => {
      toVector(equatorialToScene(planet), this.planetPositions[i]).toArray(dots.array, i * 3);
    });
    dots.needsUpdate = true;
    const earthDot = this.earthDot.geometry.attributes.position;
    this.earth.toArray(earthDot.array, 0);
    earthDot.needsUpdate = true;
    this.orbits.forEach((line, i) => {
      const position = line.geometry.attributes.position;
      orbitPoints(i === PLANETS.length ? -1 : i, date, ORBIT_SEGMENTS).forEach((point, j) => {
        const [x, y, z] = equatorialToScene(point);
        position.setXYZ(j, x, y, z);
      });
      position.needsUpdate = true;
    });
  }

  // 地球の場面のカメラから、この場面のカメラを合わせる。sidereal は地球の場面で星を回している角度
  private syncFromEarth(earthCamera: THREE.PerspectiveCamera, sidereal: number): void {
    this.rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, sidereal);
    const inverse = this.rotation.clone().invert();
    this.camera.position
      .copy(earthCamera.position)
      .applyQuaternion(inverse)
      .divideScalar(AU_IN_EARTH_RADII)
      .add(this.earth);
    this.camera.quaternion.copy(inverse).multiply(earthCamera.quaternion);
  }

  // この場面のカメラから、地球の場面のカメラを合わせる
  applyToEarth(earthCamera: THREE.PerspectiveCamera, sidereal: number): void {
    this.rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, sidereal);
    earthCamera.position
      .copy(this.camera.position)
      .sub(this.earth)
      .multiplyScalar(AU_IN_EARTH_RADII)
      .applyQuaternion(this.rotation);
    earthCamera.quaternion.copy(this.rotation).multiply(this.camera.quaternion);
    earthCamera.updateMatrixWorld();
  }

  // 地球ビュー (または地域ビュー) から引いていく
  enter(earthCamera: THREE.PerspectiveCamera, sidereal: number): void {
    if (this.entered) return;
    if (this.state === 'off') this.syncFromEarth(earthCamera, sidereal);
    const start = this.currentPose(this.state === 'off' ? 0 : null);
    this.startFlight(start, overviewPose(this.earth.toArray(), OVERVIEW_DISTANCE, OVERVIEW_ELEVATION));
    this.state = 'entering';
  }

  // home は地球の場面で戻る向き (地球の中心からカメラへの単位ベクトル)。done は戻り終えたときに呼ぶ
  leave(home: THREE.Vector3, distance: number, sidereal: number, done?: () => void): void {
    if (this.state === 'off') {
      done?.();
      return;
    }
    this.rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, sidereal);
    const direction = home.clone().applyQuaternion(this.rotation.clone().invert()).normalize();
    const to: SolarPose = {
      sunWeight: 0,
      distance: distance / AU_IN_EARTH_RADII,
      direction: direction.toArray(),
      up: [0, 1, 0], // 地球ビューと同じく天の北極を上にする
    };
    this.startFlight(this.currentPose(null), to, done);
    this.state = 'leaving';
  }

  // 今のカメラの姿勢を、中心 (地球か太陽) からの距離と向きで表す。sunWeight を省くと近い方を中心とみなす
  private currentPose(sunWeight: number | null): SolarPose {
    const weight = sunWeight ?? (this.camera.position.distanceTo(this.earth) < this.camera.position.length() ? 0 : 1);
    const target = weight === 0 ? this.earth : this.sunPosition;
    const offset = this.scratch.copy(this.camera.position).sub(target);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    return { sunWeight: weight, distance: offset.length(), direction: offset.normalize().toArray(), up: up.toArray() };
  }

  private startFlight(from: SolarPose, to: SolarPose, done?: () => void): void {
    this.controls.enabled = false;
    this.flight = { from, to, elapsed: 0, startQuaternion: this.camera.quaternion.clone(), done };
  }

  // 毎フレーム呼ぶ。地球の場面のカメラを合わせるのは呼ぶ側 (applyToEarth)
  update(dt: number, earthCamera: THREE.PerspectiveCamera): void {
    if (this.state === 'off') return;
    // レンズと画面の形は地球の場面のカメラに合わせる
    this.camera.fov = earthCamera.fov;
    this.camera.aspect = earthCamera.aspect;
    this.camera.view = earthCamera.view ? { ...earthCamera.view } : null;

    if (this.flight) {
      const flight = this.flight;
      flight.elapsed = Math.min(FLY_SECONDS, flight.elapsed + dt);
      const t = easeInOut(flight.elapsed / FLY_SECONDS);
      const pose = solarFlightPose(flight.from, flight.to, t, this.earth.toArray(), [0, 0, 0]);
      this.camera.position.set(...pose.position);
      this.matrix.lookAt(this.camera.position, toVector(pose.target, this.scratch), new THREE.Vector3(...pose.up));
      this.camera.quaternion.setFromRotationMatrix(this.matrix);
      const blend = smoothstep(0, 0.3, t);
      if (blend < 1) this.camera.quaternion.slerpQuaternions(flight.startQuaternion, this.camera.quaternion.clone(), blend);
      if (flight.elapsed >= FLY_SECONDS) {
        this.flight = null;
        if (this.state === 'entering') {
          this.state = 'on';
          this.controls.target.set(0, 0, 0);
          this.controls.enabled = true;
        } else {
          this.state = 'off';
        }
        flight.done?.();
      }
    } else if (this.state === 'on') {
      this.controls.update(dt);
    }

    // 地球のすぐそばも、海王星の外も描けるよう、手前の範囲は地球までの距離に合わせる
    const toEarth = this.camera.position.distanceTo(this.earth);
    this.camera.near = THREE.MathUtils.clamp(toEarth * 0.05, 1e-7, 0.01);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    this.stars.position.copy(this.camera.position);
    // 太陽は地球から見たときに地球の場面の太陽と同じ見かけになる大きさ。遠くでは小さくなるので、点を足して見失わないようにする
    const toSun = this.camera.position.length();
    this.sunDot.material.uniforms.uOpacity.value = smoothstep(1.5, 3, toSun);
    const fade = smoothstep(FADE_NEAR, FADE_FAR, toEarth);
    this.planetDots.material.uniforms.uOpacity.value = fade;
    for (const line of this.orbits) line.material.opacity = (line === this.orbits[PLANETS.length] ? 0.6 : 0.35) * fade;
    this.earthDot.visible = this.earthPixels() < EARTH_DOT_PIXELS;
  }

  // 地球が点になるほど遠いときは、地球の場面を描かずに点で代える
  get showsEarthScene(): boolean {
    return this.state === 'off' || this.earthPixels() >= EARTH_DOT_PIXELS;
  }

  // 地球の写る大きさ (画素)。地球の場面を描くかと、雲を描くかを決める
  earthPixels(): number {
    const distance = this.camera.position.distanceTo(this.earth) * AU_IN_EARTH_RADII;
    const angle = 2 * Math.asin(Math.min(1, 1 / distance));
    return (angle / THREE.MathUtils.degToRad(this.camera.fov)) * window.innerHeight;
  }

  // 露出の計算用。太陽を画面に写した位置と、カメラの前にあるか
  projectSun(ndc: THREE.Vector3): boolean {
    ndc.copy(this.sunPosition).project(this.camera);
    return this.scratch.copy(this.sunPosition).sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3())) > 0;
  }

  // 画面を描いたあとに呼ぶ。名前は太陽系を見ている間だけ出す
  updateLabels(visible: boolean): void {
    const pixels = this.earthPixels();
    const fade = smoothstep(FADE_NEAR, FADE_FAR, this.camera.position.distanceTo(this.earth));
    this.labels.update(
      [
        ...PLANETS.map((planet, i) => ({ name: planet.name, position: fade > 0.5 ? this.planetPositions[i] : null })),
        { name: '地球', position: pixels < EARTH_LABEL_PIXELS ? this.earth : null },
        { name: '太陽', position: fade > 0.5 ? this.sunPosition : null },
      ],
      this.camera,
      visible && this.state !== 'off',
    );
  }
}
