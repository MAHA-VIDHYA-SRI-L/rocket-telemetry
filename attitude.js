(function () {
  "use strict";

  if (typeof THREE === "undefined" || !THREE.OrbitControls) {
    window.RocketAttitudeView = null;
    return;
  }

  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const RAD_TO_DEG = 180 / Math.PI;
  const GRAVITY = 9.81;
  const SENSOR_AXIS_TO_ROCKET = [
    { index: 0, sign: 1 },
    { index: 2, sign: 1 },
    { index: 1, sign: 1 }
  ];
  const FILTER_CONFIG = {
    gyroNoiseThreshold: 0.012,
    stationaryAccelTolerance: 0.35,
    stationaryAccelDeltaTolerance: 0.18,
    stationaryGyroMultiplier: 2.5,
    stationaryHoldMs: 250,
    accelValidMin: 8.2,
    accelValidMax: 11.4,
    movingCorrectionTauMs: 350,
    stationaryCorrectionTauMs: 700,
    displaySmoothingMs: 45,
    maxFrameDtMs: 50,
    maxPredictedDtMs: 250,
    biasCalibrationMs: 700,
    minBiasSamples: 8,
    staleMinMs: 750,
    staleMaxMs: 5000,
    staleIntervalFactor: 4
  };

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function mapAxis(values, axis) {
    const value = values && typeof values[axis.index] === "number" ? values[axis.index] : NaN;
    return isFiniteNumber(value) ? value * axis.sign : NaN;
  }

  function mapVector(values) {
    return new THREE.Vector3(
      mapAxis(values, SENSOR_AXIS_TO_ROCKET[0]),
      mapAxis(values, SENSOR_AXIS_TO_ROCKET[1]),
      mapAxis(values, SENSOR_AXIS_TO_ROCKET[2])
    );
  }

  function isVectorValid(vector) {
    return isFiniteNumber(vector.x) && isFiniteNumber(vector.y) && isFiniteNumber(vector.z);
  }

  function applySoftDeadband(vector, threshold) {
    const speed = vector.length();
    if (speed <= threshold) {
      vector.set(0, 0, 0);
      return;
    }
    vector.multiplyScalar((speed - threshold) / speed);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  class RocketAttitudeView {
    constructor(options) {
      const settings = options || {};
      this.container = settings.container;
      if (!this.container) throw new Error("Attitude view container is required.");

      this.onState = typeof settings.onState === "function" ? settings.onState : null;
      this.onEvent = typeof settings.onEvent === "function" ? settings.onEvent : null;
      this.tracking = settings.tracking !== false;
      this.calibrated = false;
      this.hasSensorEstimate = false;
      this.sensorValid = false;
      this.stationary = false;
      this.stationarySince = 0;
      this.calibrationQuaternion = new THREE.Quaternion();
      this.sensorOrientation = new THREE.Quaternion();
      this.predictedSensorOrientation = new THREE.Quaternion();
      this.relativeOrientation = new THREE.Quaternion();
      this.targetOrientation = new THREE.Quaternion();
      this.displayQuaternion = new THREE.Quaternion();
      this.gyroBias = new THREE.Vector3();
      this.latestGyroRate = new THREE.Vector3();
      this.lastAccel = null;
      this.biasCalibration = null;
      this.lastSampleTime = null;
      this.lastSampleWallAt = 0;
      this.sampleIntervalMs = 100;
      this.lastPredictionAt = performance.now();
      this.lastUiAt = 0;
      this.lastFrameAt = performance.now();
      this.fps = 0;
      this.frameCount = 0;
      this.fpsWindowStart = this.lastFrameAt;
      this.needsRender = true;
      this.disposed = false;
      this.frame = 0;

      this.buildScene();
      this.bindResize();
      this.animate = this.animate.bind(this);
      this.frame = requestAnimationFrame(this.animate);
      this.emitState(true);
    }

    buildScene() {
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x08111e);
      this.scene.fog = new THREE.Fog(0x08111e, 8, 18);

      this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      this.defaultCameraPosition = new THREE.Vector3(4.2, 2.7, 5.4);
      this.camera.position.copy(this.defaultCameraPosition);
      this.camera.lookAt(0, 0, 0);

      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.container.appendChild(this.renderer.domElement);

      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.target.set(0, 0, 0);
      this.controls.enableDamping = false;
      this.controls.enablePan = false;
      this.controls.minDistance = 3;
      this.controls.maxDistance = 10;
      this.controls.maxPolarAngle = Math.PI * 0.92;
      this.controls.addEventListener("change", () => {
        this.needsRender = true;
      });

      const ambient = new THREE.AmbientLight(0x8fb4d2, 0.55);
      this.scene.add(ambient);

      const key = new THREE.DirectionalLight(0xffffff, 1.05);
      key.position.set(4, 7, 5);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -5;
      key.shadow.camera.right = 5;
      key.shadow.camera.top = 5;
      key.shadow.camera.bottom = -5;
      this.scene.add(key);

      const rim = new THREE.DirectionalLight(0x5b9dff, 0.55);
      rim.position.set(-5, 3, -4);
      this.scene.add(rim);

      const fill = new THREE.PointLight(0x56d7e8, 0.7, 10);
      fill.position.set(0, 2.5, -3);
      this.scene.add(fill);

      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(14, 14),
        new THREE.MeshStandardMaterial({ color: 0x0a1727, metalness: 0.05, roughness: 0.95 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -1.65;
      ground.receiveShadow = true;
      this.scene.add(ground);

      const grid = new THREE.GridHelper(14, 28, 0x2b5a72, 0x183044);
      grid.position.y = -1.64;
      this.scene.add(grid);

      const axes = new THREE.AxesHelper(1.1);
      axes.position.y = -1.62;
      this.scene.add(axes);

      this.rocket = new THREE.Group();
      this.rocket.position.y = 0.12;
      this.scene.add(this.rocket);

      const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xdfe9f3, metalness: 0.42, roughness: 0.32 });
      const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x1b2d43, metalness: 0.68, roughness: 0.28 });
      const accentMaterial = new THREE.MeshStandardMaterial({
        color: 0x56d7e8,
        emissive: 0x0d5965,
        emissiveIntensity: 0.5,
        metalness: 0.3,
        roughness: 0.35
      });
      const finMaterial = new THREE.MeshStandardMaterial({ color: 0x5b9dff, metalness: 0.35, roughness: 0.38, side: THREE.DoubleSide });
      const nozzleMaterial = new THREE.MeshStandardMaterial({ color: 0x070c14, metalness: 0.2, roughness: 0.8 });

      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 2.2, 32), bodyMaterial);
      body.castShadow = true;
      body.receiveShadow = true;
      this.rocket.add(body);

      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.62, 32), bodyMaterial);
      nose.position.y = 1.41;
      nose.castShadow = true;
      this.rocket.add(nose);

      const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.245, 0.13, 32), darkMaterial);
      shoulder.position.y = 1.08;
      shoulder.castShadow = true;
      this.rocket.add(shoulder);

      const upperBand = new THREE.Mesh(new THREE.CylinderGeometry(0.247, 0.247, 0.08, 32), accentMaterial);
      upperBand.position.y = 0.58;
      this.rocket.add(upperBand);

      const lowerBand = new THREE.Mesh(new THREE.CylinderGeometry(0.247, 0.247, 0.08, 32), accentMaterial);
      lowerBand.position.y = -0.28;
      this.rocket.add(lowerBand);

      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.19, 0.25, 32, 1, true), darkMaterial);
      nozzle.position.y = -1.22;
      nozzle.castShadow = true;
      this.rocket.add(nozzle);

      const nozzleCore = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.03, 32), nozzleMaterial);
      nozzleCore.position.y = -1.35;
      this.rocket.add(nozzleCore);

      const finShape = new THREE.Shape();
      finShape.moveTo(0, 0.34);
      finShape.lineTo(0.58, -0.26);
      finShape.lineTo(0, -0.56);
      finShape.closePath();
      const finGeometry = new THREE.ExtrudeGeometry(finShape, {
        depth: 0.045,
        bevelEnabled: true,
        bevelSize: 0.012,
        bevelThickness: 0.012,
        bevelSegments: 1
      });
      for (let index = 0; index < 4; index += 1) {
        const finPivot = new THREE.Group();
        finPivot.rotation.y = (index * Math.PI) / 2;
        const fin = new THREE.Mesh(finGeometry, finMaterial);
        fin.position.set(0.22, -0.72, -0.0225);
        fin.castShadow = true;
        fin.receiveShadow = true;
        finPivot.add(fin);
        this.rocket.add(finPivot);
      }
    }

    bindResize() {
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.container);
      } else {
        this.handleWindowResize = () => this.resize();
        window.addEventListener("resize", this.handleWindowResize);
      }
      this.resize();
    }

    resize() {
      if (this.disposed) return;
      const width = Math.max(1, this.container.clientWidth || 640);
      const height = Math.max(1, this.container.clientHeight || 420);
      if (width === this.width && height === this.height) return;
      this.width = width;
      this.height = height;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.needsRender = true;
    }

    staleLimitMs() {
      return clamp(
        this.sampleIntervalMs * FILTER_CONFIG.staleIntervalFactor,
        FILTER_CONFIG.staleMinMs,
        FILTER_CONFIG.staleMaxMs
      );
    }

    isFresh() {
      if (!this.lastSampleWallAt || !this.sensorValid) return false;
      return Date.now() - this.lastSampleWallAt <= this.staleLimitMs();
    }

    updateStationary(accel, correctedGyro, accelMagnitude, now) {
      const accelStable = Math.abs(accelMagnitude - GRAVITY) <= FILTER_CONFIG.stationaryAccelTolerance;
      const accelSimilar = !this.lastAccel || accel.distanceTo(this.lastAccel) <= FILTER_CONFIG.stationaryAccelDeltaTolerance;
      const gyroQuiet = correctedGyro.length() <= FILTER_CONFIG.gyroNoiseThreshold * FILTER_CONFIG.stationaryGyroMultiplier;
      if (accelStable && accelSimilar && gyroQuiet) {
        if (!this.stationarySince) this.stationarySince = now;
        this.stationary = now - this.stationarySince >= FILTER_CONFIG.stationaryHoldMs;
      } else {
        this.stationarySince = 0;
        this.stationary = false;
      }
    }

    updateBiasCalibration(rawGyro, now) {
      if (!this.biasCalibration) return;
      if (this.stationary || rawGyro.length() <= FILTER_CONFIG.gyroNoiseThreshold * FILTER_CONFIG.stationaryGyroMultiplier) {
        this.biasCalibration.sum.add(rawGyro);
        this.biasCalibration.count += 1;
      }
      if (now - this.biasCalibration.startedAt >= FILTER_CONFIG.biasCalibrationMs || this.biasCalibration.count >= 60) {
        const count = this.biasCalibration.count;
        if (count >= FILTER_CONFIG.minBiasSamples) {
          this.gyroBias.copy(this.biasCalibration.sum).divideScalar(count);
          this.notify("Stationary gyro bias updated.");
        } else {
          this.notify("Gyro bias update skipped; sensor was not stationary long enough.");
        }
        this.biasCalibration = null;
      }
    }

    updatePrediction(now) {
      const elapsed = now - this.lastPredictionAt;
      this.lastPredictionAt = now;
      const fresh = this.isFresh();
      const usable = this.calibrated && this.tracking && this.hasSensorEstimate;
      const canPredict = fresh && usable;
      if (!canPredict) {
        if (!usable || (!fresh && this.lastSampleWallAt === 0)) {
          this.predictedSensorOrientation.copy(this.sensorOrientation);
        }
        if (this.calibrated) {
          this.relativeOrientation.copy(this.calibrationQuaternion).invert().multiply(this.predictedSensorOrientation).normalize();
          this.targetOrientation.copy(this.relativeOrientation);
        } else {
          this.relativeOrientation.identity();
          this.targetOrientation.identity();
        }
        return;
      }

      const deltaMs = clamp(elapsed, 0, FILTER_CONFIG.maxPredictedDtMs);
      const speed = this.latestGyroRate.length();
      if (speed > 1e-5 && deltaMs > 0) {
        const axis = this.latestGyroRate.clone().divideScalar(speed);
        const increment = new THREE.Quaternion().setFromAxisAngle(axis, speed * deltaMs / 1000);
        this.predictedSensorOrientation.multiply(increment).normalize();
      }

      this.relativeOrientation.copy(this.calibrationQuaternion).invert().multiply(this.predictedSensorOrientation).normalize();
      this.targetOrientation.copy(this.relativeOrientation);
    }

    initializeSensorEstimate(accel) {
      if (!isVectorValid(accel) || accel.lengthSq() < 1) return false;
      const up = accel.clone().normalize();
      this.sensorOrientation.setFromUnitVectors(up, WORLD_UP).normalize();
      this.predictedSensorOrientation.copy(this.sensorOrientation);
      this.hasSensorEstimate = true;
      return true;
    }

    calibrateFromCurrent() {
      if (this.disposed) return false;
      if (!this.hasSensorEstimate || !this.isFresh()) {
        this.notify("Cannot calibrate: fresh IMU data unavailable.");
        this.emitState(true);
        return false;
      }

      this.updatePrediction(performance.now());
      this.sensorOrientation.copy(this.predictedSensorOrientation);
      this.calibrationQuaternion.copy(this.predictedSensorOrientation).normalize();
      this.calibrated = true;
      this.relativeOrientation.identity();
      this.targetOrientation.identity();
      this.displayQuaternion.identity();
      this.rocket.quaternion.identity();
      this.lastPredictionAt = performance.now();
      this.latestGyroRate.set(0, 0, 0);
      this.biasCalibration = { startedAt: performance.now(), sum: new THREE.Vector3(), count: 0 };
      this.needsRender = true;
      this.notify("Reference orientation captured; rocket is upright at the current physical attitude.");
      this.emitState(true);
      return true;
    }

    clearCalibration() {
      if (this.disposed) return;
      this.biasCalibration = null;
      this.calibrated = false;
      this.calibrationQuaternion.identity();
      this.relativeOrientation.identity();
      this.targetOrientation.identity();
      this.displayQuaternion.identity();
      this.rocket.quaternion.identity();
      this.needsRender = true;
      this.notify("Attitude calibration cleared.");
      this.emitState(true);
    }

    resetOrientation() {
      return this.calibrateFromCurrent();
    }

    update(accelValues, gyroValues, sampleTimeMs) {
      if (this.disposed || !this.tracking) return;

      const accel = mapVector(accelValues);
      const gyro = mapVector(gyroValues);
      if (!isVectorValid(accel) || !isVectorValid(gyro)) {
        this.markInvalidSample();
        return;
      }

      const now = performance.now();
      this.updatePrediction(now);
      this.sensorOrientation.copy(this.predictedSensorOrientation);

      this.lastSampleWallAt = Date.now();
      const sampleTime = isFiniteNumber(sampleTimeMs) ? sampleTimeMs : now;
      if (this.lastSampleTime !== null) {
        const rawIntervalMs = sampleTime - this.lastSampleTime;
        if (isFiniteNumber(rawIntervalMs) && rawIntervalMs >= 10 && rawIntervalMs <= 2000) {
          this.sampleIntervalMs = clamp(this.sampleIntervalMs * 0.8 + rawIntervalMs * 0.2, 20, 2000);
        }
      }
      this.lastSampleTime = sampleTime;

      if (!this.hasSensorEstimate && !this.initializeSensorEstimate(accel)) return;

      const accelMagnitude = accel.length();
      const correctedGyro = gyro.clone().sub(this.gyroBias);
      this.updateStationary(accel, correctedGyro, accelMagnitude, now);
      this.updateBiasCalibration(gyro, now);

      const gyroRate = gyro.clone().sub(this.gyroBias);
      if (this.stationary) applySoftDeadband(gyroRate, FILTER_CONFIG.gyroNoiseThreshold);
      this.latestGyroRate.copy(gyroRate);

      if (accelMagnitude >= FILTER_CONFIG.accelValidMin && accelMagnitude <= FILTER_CONFIG.accelValidMax) {
        const tau = this.stationary ? FILTER_CONFIG.stationaryCorrectionTauMs : FILTER_CONFIG.movingCorrectionTauMs;
        const correctionAlpha = 1 - Math.exp(-clamp(this.sampleIntervalMs, 10, 500) / tau);
        const measuredUp = accel.clone().normalize().applyQuaternion(this.sensorOrientation);
        const correction = new THREE.Quaternion().setFromUnitVectors(measuredUp, WORLD_UP);
        const corrected = correction.multiply(this.sensorOrientation.clone()).normalize();
        this.sensorOrientation.slerp(corrected, correctionAlpha);
      }

      this.lastAccel = accel.clone();
      this.predictedSensorOrientation.copy(this.sensorOrientation);
      this.lastPredictionAt = now;
      this.sensorValid = true;
      this.updatePrediction(now);
      this.needsRender = true;
      this.emitState(true);
    }

    markInvalidSample() {
      if (this.disposed) return;
      const now = performance.now();
      this.updatePrediction(now);
      this.sensorOrientation.copy(this.predictedSensorOrientation);
      this.sensorValid = false;
      this.lastSampleWallAt = 0;
      this.lastSampleTime = null;
      this.latestGyroRate.set(0, 0, 0);
      this.stationary = false;
      this.stationarySince = 0;
      this.emitState(true);
    }

    setTracking(enabled) {
      this.tracking = Boolean(enabled);
      this.notify(this.tracking ? "Live attitude tracking enabled." : "Live attitude tracking disabled.");
      this.emitState(true);
    }

    resetCamera() {
      if (this.disposed) return;
      this.camera.position.copy(this.defaultCameraPosition);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      this.needsRender = true;
    }

    getState(force = false) {
      const now = Date.now();
      if (!force && now - this.lastUiAt < 100) return null;
      this.lastUiAt = now;

      const freshnessMs = this.lastSampleWallAt ? now - this.lastSampleWallAt : null;
      const staleLimitMs = this.staleLimitMs();
      const fresh = freshnessMs !== null && freshnessMs <= staleLimitMs;
      const calibrationStatus = this.calibrated ? "CALIBRATED" : "NOT CALIBRATED";
      let status;
      if (!this.tracking) status = "LIVE ATTITUDE DISABLED";
      else if (!fresh) status = "SENSOR DATA UNAVAILABLE";
      else if (!this.calibrated) status = "NOT CALIBRATED";
      else status = "LIVE";

      let pitch = 0;
      let yaw = 0;
      let roll = 0;
      if (this.calibrated) {
        const euler = new THREE.Euler().setFromQuaternion(this.relativeOrientation, "YXZ");
        pitch = euler.x * RAD_TO_DEG;
        yaw = euler.y * RAD_TO_DEG;
        roll = euler.z * RAD_TO_DEG;
      }

      return {
        status,
        calibrationStatus,
        pitch,
        roll,
        yaw,
        freshnessMs,
        calibrated: this.calibrated,
        tracking: this.tracking,
        sensorValid: fresh && this.sensorValid,
        stationary: this.stationary,
        biasCalibrating: Boolean(this.biasCalibration),
        gyroBias: { x: this.gyroBias.x, y: this.gyroBias.y, z: this.gyroBias.z },
        fps: this.fps,
        sampleIntervalMs: this.sampleIntervalMs,
        staleLimitMs
      };
    }

    emitState(force = false) {
      if (!this.onState) return;
      const state = this.getState(force);
      if (state) this.onState(state);
    }

    notify(message) {
      if (this.onEvent) this.onEvent(message);
    }

    animate() {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(this.animate);
      if (document.hidden) return;

      const now = performance.now();
      const frameMs = clamp(now - this.lastFrameAt, 1, FILTER_CONFIG.maxFrameDtMs);
      this.lastFrameAt = now;
      this.frameCount += 1;
      if (now - this.fpsWindowStart >= 1000) {
        this.fps = this.frameCount * 1000 / (now - this.fpsWindowStart);
        this.frameCount = 0;
        this.fpsWindowStart = now;
      }

      this.updatePrediction(now);

      const blend = 1 - Math.exp(-frameMs / FILTER_CONFIG.displaySmoothingMs);
      const delta =
        Math.abs(this.displayQuaternion.x - this.targetOrientation.x) +
        Math.abs(this.displayQuaternion.y - this.targetOrientation.y) +
        Math.abs(this.displayQuaternion.z - this.targetOrientation.z) +
        Math.abs(this.displayQuaternion.w - this.targetOrientation.w);
      if (delta > 1e-5) {
        this.displayQuaternion.slerp(this.targetOrientation, blend);
        this.rocket.quaternion.copy(this.displayQuaternion);
        this.needsRender = true;
      }

      if (this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
      }
      this.emitState();
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      cancelAnimationFrame(this.frame);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.handleWindowResize) window.removeEventListener("resize", this.handleWindowResize);
      if (this.controls) this.controls.dispose();
      if (this.scene) {
        this.scene.traverse((object) => {
          if (object.geometry) object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((item) => item.dispose());
          else if (material) material.dispose();
        });
      }
      if (this.renderer) {
        this.renderer.dispose();
        if (this.renderer.domElement.parentNode === this.container) {
          this.container.removeChild(this.renderer.domElement);
        }
      }
    }
  }

  window.ROCKET_ATTITUDE_AXIS_CONFIG = SENSOR_AXIS_TO_ROCKET;
  window.ROCKET_ATTITUDE_FILTER_CONFIG = FILTER_CONFIG;
  window.RocketAttitudeView = RocketAttitudeView;
})();
