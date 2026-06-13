import * as THREE from 'three';
import { CONFIG, KEY_MAP } from './config.js';
import { PhysicsEngine } from './physics.js';
import { CelestialBody } from './celestial.js';
import { Rocket } from './rocket.js';
import { CameraController } from './camera.js';
import { EffectsEngine } from './effects.js';
import { UI } from './ui.js';
import { Autopilot } from './autopilot.js';

class Game {
    constructor() {
        this.state = 'vab';
        this.scene = null; this.camera = null; this.renderer = null;
        this.physics = new PhysicsEngine();
        this.celestial = null; this.rocket = null; this.cameraCtrl = null;
        this.effects = null; this.ui = new UI();
        this.autopilot = null;
        this.physState = { position: { x: 0, y: CONFIG.PLANET_RADIUS, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, mass: 0, dragArea: 2, gForce: 0 };
        this.keys = {}; this.timeWarp = 1; this.timeWarpIndex = 0;
        this.orbitLine = null; this.munOrbitLine = null; this.cheatMode = false; this.crashed = false; this.lastTime = 0;
        this.init();
    }

    async init() {
        this._setupRenderer(); this._setupScene();
        this.celestial = new CelestialBody(this.scene);
        this.cameraCtrl = new CameraController(this.camera);
        this.effects = new EffectsEngine(this.scene);
        this._setupInput(); this._setupCallbacks();
        this.ui.hideLoading(); this.ui.showVAB(); this.ui.loadTemplate();
        this.celestial.setScale(0);
        this.lastTime = performance.now();
        this._loop();
    }

    _setupRenderer() {
        const canvas = document.getElementById('game-canvas');
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000000);
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    _setupScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000005);
    }

    _setupInput() {
        window.addEventListener('keydown', e => {
            this.keys[e.code] = true;
            if (e.code === 'Space' && this.state !== 'vab') { e.preventDefault(); this.rocket?.activateStage(); this.effects?.playStagingSound(); }
            if (e.code === 'KeyM' && this.state !== 'vab') this._toggleMap();
            if (e.code === 'KeyT' && this.state !== 'vab') { this.rocket.sasEnabled = !this.rocket.sasEnabled; document.getElementById('btn-sas')?.classList.toggle('active', this.rocket.sasEnabled); }
            if (e.code === 'KeyZ') this.rocket && (this.rocket.throttle = 1);
            if (e.code === 'KeyX') this.rocket && (this.rocket.throttle = 0);
            if (e.code === 'KeyP' && this.state !== 'vab') this.rocket?.deployParachutes();
            if (e.code === 'F1' && e.altKey) { this.cheatMode = !this.cheatMode; alert('作弊模式: ' + (this.cheatMode ? 'ON' : 'OFF')); }
            if (e.code === 'Period') this._changeTimeWarp(1);
            if (e.code === 'Comma') this._changeTimeWarp(-1);
        });
        window.addEventListener('keyup', e => this.keys[e.code] = false);
        // Init audio on first click
        const initAudio = () => { this.effects?.initAudio(); document.removeEventListener('click', initAudio); };
        document.addEventListener('click', initAudio);
    }

    _setupCallbacks() {
        this.ui.onLaunch = () => this._launch();
        this.ui.onToggleMap = () => this._toggleMap();
        this.ui.onToggleSAS = () => { if (this.rocket) { this.rocket.sasEnabled = !this.rocket.sasEnabled; document.getElementById('btn-sas')?.classList.toggle('active', this.rocket.sasEnabled); } };
        this.ui.onBackToVAB = () => this._backToVAB();
        this.ui.onTimeWarp = (dir) => this._changeTimeWarp(dir);
        this.ui.onAutopilot = (mode) => {
            if (!this.autopilot) return;
            if (mode === 'orbit') this.autopilot.activateOrbit();
            else if (mode === 'mun') this.autopilot.activateMunMission();
            else if (mode === 'land') this.autopilot.activateLanding();
            else if (mode === 'off') this.autopilot.deactivate();
        };
    }

    _changeTimeWarp(dir) {
        if (this.state === 'vab') return;
        const alt = this.physics.getAltitude(this.physState.position);
        const maxIdx = alt > CONFIG.ATMOSPHERE_HEIGHT ? CONFIG.TIME_WARP_LEVELS.length - 1 : 2;
        this.timeWarpIndex = Math.max(0, Math.min(maxIdx, this.timeWarpIndex + dir));
        this.timeWarp = CONFIG.TIME_WARP_LEVELS[this.timeWarpIndex];
    }

    _launch() {
        const parts = this.ui.getAssemblyParts();
        if (!parts.length) return;
        this.rocket = Rocket.createFromParts(parts);
        this.rocket.throttle = 0;
        this.rocket.orientation.identity();
        if (this.rocket.meshGroup.parent) this.scene.remove(this.rocket.meshGroup);
        this.scene.add(this.rocket.meshGroup);
        this.physState = { position: { x: 0, y: CONFIG.PLANET_RADIUS, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, mass: this.rocket.totalMass, dragArea: this.rocket.totalDragArea, gForce: 0 };
        this.timeWarp = 1; this.timeWarpIndex = 0;
        this.state = 'flight'; this.ui.showFlight();
        this.autopilot = new Autopilot(this);
        this.celestial.setScale(CONFIG.PLANET_RADIUS * CONFIG.RENDER_SCALE_FLIGHT);
        this.cameraCtrl.setMode('flight');
        this.cameraCtrl.resetFlight(this.physState.position, this.rocket.orientation, CONFIG.RENDER_SCALE_FLIGHT);
        this._removeOrbitLine();
    }

    _toggleMap() {
        if (this.state === 'flight') {
            this.state = 'map'; this.cameraCtrl.setMode('map'); this.ui.showMap();
            this.celestial.setScale(1);
        } else if (this.state === 'map') {
            this.state = 'flight'; this.cameraCtrl.setMode('flight'); this.ui.showFlight();
            this.celestial.setScale(CONFIG.PLANET_RADIUS * CONFIG.RENDER_SCALE_FLIGHT);
            this._removeOrbitLine();
        }
    }

    _crash() {
        if (this.crashed) return;
        this.crashed = true;
        this.rocket.throttle = 0;

        const pos = this.rocket.meshGroup.position.clone();
        const sharedGeo = new THREE.SphereGeometry(1, 4, 4);
        const colors = [0xff4400, 0xffaa00, 0xff0000];
        for (let i = 0; i < 30; i++) {
            const mat = new THREE.MeshBasicMaterial({ color: colors[i % 3], transparent: true, opacity: 1 });
            const p = new THREE.Mesh(sharedGeo, mat);
            p.position.copy(pos);
            const s = 0.3 + Math.random() * 0.8;
            p.scale.setScalar(s);
            p.userData.vel = new THREE.Vector3(
                (Math.random() - 0.5) * 40,
                Math.random() * 30 + 5,
                (Math.random() - 0.5) * 40
            );
            p.userData.life = 1.0;
            p.userData.baseScale = s;
            this.scene.add(p);
            if (!this.explosionParts) this.explosionParts = [];
            this.explosionParts.push(p);
        }
        const flashGeo = new THREE.SphereGeometry(1, 8, 8);
        const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffaa, transparent: true, opacity: 0.9 });
        this.explosionFlash = new THREE.Mesh(flashGeo, flashMat);
        this.explosionFlash.position.copy(pos);
        this.explosionFlash.scale.setScalar(8);
        this.scene.add(this.explosionFlash);

        // Hide rocket
        this.rocket.meshGroup.visible = false;

        // Play explosion sound
        this.effects?.playStagingSound();

        // Show crash message after 2s
        setTimeout(() => {
            if (this.crashed) {
                alert('坠毁了！速度过快撞击地面。\n\n点击确定返回组装大楼');
                this._backToVAB();
            }
        }, 2000);
    }

    _backToVAB() {
        this.state = 'vab'; this.crashed = false; this.ui.showVAB();
        this.autopilot = null;
        if (this.rocket?.meshGroup.parent) this.scene.remove(this.rocket.meshGroup);
        this.rocket = null; this._removeOrbitLine(); this.celestial.setScale(0); this.timeWarp = 1; this.timeWarpIndex = 0;
        // Cleanup explosion
        if (this.explosionParts) {
            const geo = this.explosionParts[0]?.geometry;
            for (const p of this.explosionParts) { this.scene.remove(p); p.material.dispose(); }
            if (geo) geo.dispose();
            this.explosionParts = null;
        }
        if (this.explosionFlash) { this.scene.remove(this.explosionFlash); this.explosionFlash.geometry.dispose(); this.explosionFlash.material.dispose(); this.explosionFlash = null; }
    }

    _loop() {
        requestAnimationFrame(() => this._loop());
        const now = performance.now();
        let dt = (now - this.lastTime) / 1000;
        this.lastTime = now;
        if (dt > 0.1) dt = 0.1;
        if (this.state === 'flight' || this.state === 'map') this._updateFlight(dt);

        // Update explosion particles
        if (this.explosionParts) {
            for (let i = this.explosionParts.length - 1; i >= 0; i--) {
                const p = this.explosionParts[i];
                p.userData.life -= dt * 0.8;
                if (p.userData.life <= 0) {
                    this.scene.remove(p); p.material.dispose();
                    this.explosionParts.splice(i, 1);
                    continue;
                }
                p.position.x += p.userData.vel.x * dt;
                p.position.y += p.userData.vel.y * dt;
                p.position.z += p.userData.vel.z * dt;
                p.userData.vel.y -= 20 * dt;
                p.material.opacity = p.userData.life;
                p.scale.setScalar(p.userData.baseScale * (1 + (1 - p.userData.life) * 2));
            }
            if (this.explosionParts.length === 0) this.explosionParts = null;
        }
        if (this.explosionFlash) {
            this.explosionFlash.material.opacity -= dt * 2.5;
            this.explosionFlash.scale.multiplyScalar(1 + dt * 3);
            if (this.explosionFlash.material.opacity <= 0) {
                this.scene.remove(this.explosionFlash);
                this.explosionFlash.geometry.dispose();
                this.explosionFlash.material.dispose();
                this.explosionFlash = null;
            }
        }

        this.renderer.render(this.scene, this.camera);
    }

    _updateFlight(dt) {
        if (!this.rocket) return;
        // Autopilot override
        if (this.autopilot && this.autopilot.state !== 'IDLE') {
            const simTime = dt * this.timeWarp;
            const apStep = 0.2;
            const steps = Math.min(8, Math.max(1, Math.ceil(simTime / apStep)));
            for (let i = 0; i < steps; i++) {
                this.autopilot.update(simTime / steps);
            }
        } else {
            // Manual input
            if (this.keys['ShiftLeft'] || this.keys['ShiftRight']) this.rocket.throttle = Math.min(1, this.rocket.throttle + dt * 2.0);
            if (this.keys['ControlLeft'] || this.keys['ControlRight']) this.rocket.throttle = Math.max(0, this.rocket.throttle - dt * 2.0);
            let pitch = 0, yaw = 0, roll = 0;
            if (this.keys['KeyW']) pitch = 1; if (this.keys['KeyS']) pitch = -1;
            if (this.keys['KeyA']) yaw = 1; if (this.keys['KeyD']) yaw = -1;
            if (this.keys['KeyQ']) roll = 1; if (this.keys['KeyE']) roll = -1;
            this.rocket.applyRotation(pitch, yaw, roll, dt);
        }

        // Cheat: infinite fuel
        if (this.cheatMode) {
            for (const p of this.rocket.parts) {
                if (p.fuelCapacity > 0) p.fuel = p.fuelCapacity;
            }
        }

        // Physics
        const physDt = CONFIG.PHYSICS_DT;
        const steps = Math.max(1, Math.floor(dt / physDt));
        this.physState.mass = this.rocket.totalMass;
        this.physState.dragArea = this.rocket.totalDragArea;

        let didCrash = false;
        for (let i = 0; i < steps; i++) {
            const tf = this.rocket.computeThrustForce(physDt);
            this.physState.mass = this.rocket.totalMass;
            this.physics.update(this.physState, physDt, tf, this.timeWarp);
            this.physics.updateMunAngle(physDt * this.timeWarp);

            // Ground collision after every physics step
            const stepAlt = this.physics.getAltitude(this.physState.position);
            if (stepAlt < 0) {
                const r = Math.sqrt(this.physState.position.x ** 2 + this.physState.position.y ** 2 + this.physState.position.z ** 2);
                if (r > 0) {
                    const rhat = {
                        x: this.physState.position.x / r,
                        y: this.physState.position.y / r,
                        z: this.physState.position.z / r,
                    };
                    const vr = this.physState.velocity.x * rhat.x + this.physState.velocity.y * rhat.y + this.physState.velocity.z * rhat.z;
                    const impactSpeed = Math.abs(vr);

                    // Snap to surface
                    const s = CONFIG.PLANET_RADIUS / r;
                    this.physState.position.x *= s;
                    this.physState.position.y *= s;
                    this.physState.position.z *= s;

                    if (impactSpeed > 50 && !this.crashed) {
                        this._crash();
                        didCrash = true;
                        break;
                    }

                    // Soft landing: remove vertical velocity
                    if (vr < 0) {
                        this.physState.velocity.x -= vr * rhat.x;
                        this.physState.velocity.y -= vr * rhat.y;
                        this.physState.velocity.z -= vr * rhat.z;
                    }
                    this.timeWarp = 1;
                    this.timeWarpIndex = 0;
                }
            }

            // Mun surface collision
            const munPos = this.physics.getMunPosition();
            const mdx = this.physState.position.x - munPos.x;
            const mdy = this.physState.position.y - munPos.y;
            const mdz = this.physState.position.z - munPos.z;
            const munDist = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
            if (munDist < CONFIG.MUN_RADIUS) {
                const mrhat = { x: mdx / munDist, y: mdy / munDist, z: mdz / munDist };
                const mvr = this.physState.velocity.x * mrhat.x + this.physState.velocity.y * mrhat.y + this.physState.velocity.z * mrhat.z;
                const mImpactSpeed = Math.abs(mvr);
                // Snap to Mun surface
                const ms = CONFIG.MUN_RADIUS / munDist;
                this.physState.position.x = munPos.x + mdx * ms;
                this.physState.position.y = munPos.y + mdy * ms;
                this.physState.position.z = munPos.z + mdz * ms;

                if (mImpactSpeed > 50 && !this.crashed) {
                    this._crash();
                    didCrash = true;
                    break;
                }
                if (mvr < 0) {
                    this.physState.velocity.x -= mvr * mrhat.x;
                    this.physState.velocity.y -= mvr * mrhat.y;
                    this.physState.velocity.z -= mvr * mrhat.z;
                }
                this.timeWarp = 1;
                this.timeWarpIndex = 0;
            }
        }

        if (didCrash) return;

        const alt = this.physics.getAltitude(this.physState.position);

        // Visuals
        if (this.state === 'flight') this._updateFlightVisuals(dt);
        else this._updateMapVisuals();

        // Effects - update flame meshes
        if (this.rocket.flameMeshes) {
            const t = this.rocket.throttle;
            for (let i = 0; i < this.rocket.flameMeshes.length; i++) {
                const f = this.rocket.flameMeshes[i];
                f.visible = t > 0.01;
                f.material.opacity = t * (i % 2 === 0 ? 0.8 : 0.6);
                f.scale.set(0.5 + t * 0.5, 0.3 + t * 1.2, 0.5 + t * 0.5);
            }
        }
        this.effects.update(dt);
        this.effects.updateEngineSound(this.rocket.throttle);
        if (this.rocket.throttle > 0 && this.state === 'flight') {
            const scale = CONFIG.RENDER_SCALE_FLIGHT;
            const rp = this.rocket.meshGroup.position;
            const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rocket.orientation);
            const exPos = this.rocket.getExhaustPosition();
            exPos.applyQuaternion(this.rocket.orientation);
            exPos.multiplyScalar(1); // mesh scale is 1
            exPos.add(rp);
            this.effects.emitFlame(exPos, up, this.rocket.throttle, 1.5);
            const rho = this.physics.atmosphericDensity(this.physState.position);
            if (rho > 0) this.effects.emitSmoke(exPos, this.rocket.throttle, 1.5);
        }

        // Update celestial
        this.celestial.updateClouds(dt);
        this.celestial.updateMun(this.physics.munAngle, CONFIG.PLANET_RADIUS * CONFIG.RENDER_SCALE_FLIGHT, this.state === 'map');

        // HUD — switch to Mun-relative when in Mun SOI
        let hudAlt = alt, hudSpd, hudOrbSpd, hudEls;
        if (this.physics.isInMunSOI(this.physState.position)) {
            const mp = this.physics.getMunPosition();
            const munV = 2 * Math.PI * CONFIG.MUN_ORBIT_RADIUS / CONFIG.MUN_ORBIT_PERIOD;
            const a = this.physics.munAngle;
            const mv = { x: -munV * Math.sin(a), y: 0, z: munV * Math.cos(a) };
            const rp = { x: this.physState.position.x - mp.x, y: this.physState.position.y - mp.y, z: this.physState.position.z - mp.z };
            const rv = { x: this.physState.velocity.x - mv.x, y: this.physState.velocity.y - mv.y, z: this.physState.velocity.z - mv.z };
            const rr = Math.sqrt(rp.x**2 + rp.y**2 + rp.z**2);
            hudAlt = rr - CONFIG.MUN_RADIUS;
            hudSpd = Math.sqrt(rv.x**2 + rv.y**2 + rv.z**2);
            const vr = rr > 0 ? (rp.x*rv.x + rp.y*rv.y + rp.z*rv.z) / rr : 0;
            hudOrbSpd = Math.sqrt(Math.max(0, hudSpd*hudSpd - vr*vr));
            hudEls = this.physics.computeOrbitalElements(rp, rv, CONFIG.MUN_MU, CONFIG.MUN_RADIUS);
        } else {
            hudSpd = this.physics.getSpeed(this.physState.velocity);
            hudOrbSpd = this.physics.getOrbitalSpeed(this.physState.position, this.physState.velocity);
            hudEls = this.physics.computeOrbitalElements(this.physState.position, this.physState.velocity);
        }
        this.ui.updateHUD({
            altitude: hudAlt, speed: hudSpd,
            orbitalSpeed: hudOrbSpd,
            throttle: this.rocket.throttle, fuelFraction: this.rocket.fuelFraction,
            apoapsis: hudEls?.apoapsis || 0, periapsis: hudEls?.periapsis || 0,
            gForce: this.physState.gForce, timeWarp: this.timeWarp,
        });
        this.ui.updateStaging(this.rocket.getStageInfo());
        this.ui.updateNavball(this.rocket.orientation);
        this.ui.updateMapHUD({
            apoapsis: hudEls?.apoapsis || 0, periapsis: hudEls?.periapsis || 0,
            orbitalSpeed: hudOrbSpd,
            period: hudEls?.period || 0, eccentricity: hudEls?.eccentricity || 0,
        });
    }

    _updateFlightVisuals() {
        const s = CONFIG.RENDER_SCALE_FLIGHT;
        if (this.rocket.meshGroup.parent) {
            this.rocket.meshGroup.position.set(this.physState.position.x * s, this.physState.position.y * s, this.physState.position.z * s);
            this.rocket.meshGroup.quaternion.copy(this.rocket.orientation);
            this.rocket.meshGroup.scale.setScalar(1);
        }
        this.cameraCtrl.updateFlight(this.physState.position, this.rocket.orientation, s);
    }

    _updateMapVisuals() {
        const ms = 1 / CONFIG.PLANET_RADIUS;
        if (this.rocket.meshGroup.parent) {
            this.rocket.meshGroup.position.set(this.physState.position.x * ms, this.physState.position.y * ms, this.physState.position.z * ms);
            this.rocket.meshGroup.quaternion.copy(this.rocket.orientation);
            this.rocket.meshGroup.scale.setScalar(0.02);
        }
        this.cameraCtrl.updateMap();
        this._updateOrbitLine();
        this._updateMunOrbitLine();
    }

    _updateOrbitLine() {
        const pts = this.physics.predictOrbit(this.physState.position, this.physState.velocity);
        if (pts.length < 2) return;
        const ms = 1 / CONFIG.PLANET_RADIUS;
        const verts = new Float32Array(pts.length * 3);
        for (let i = 0; i < pts.length; i++) {
            verts[i * 3] = pts[i].x * ms;
            verts[i * 3 + 1] = pts[i].y * ms;
            verts[i * 3 + 2] = pts[i].z * ms;
        }
        if (!this.orbitLine) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
            geo.setDrawRange(0, pts.length);
            this.orbitLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.7 }));
            this.scene.add(this.orbitLine);
        } else {
            const attr = this.orbitLine.geometry.attributes.position;
            if (attr.array.length < verts.length) {
                this.orbitLine.geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3));
            } else {
                attr.array.set(verts);
                attr.needsUpdate = true;
            }
            this.orbitLine.geometry.setDrawRange(0, pts.length);
        }
    }

    _updateMunOrbitLine() {
        if (this.munOrbitLine) return;
        const pts = [];
        const ms = 1 / CONFIG.PLANET_RADIUS;
        for (let i = 0; i <= 200; i++) {
            const a = (i / 200) * Math.PI * 2;
            pts.push(CONFIG.MUN_ORBIT_RADIUS * Math.cos(a) * ms, 0, CONFIG.MUN_ORBIT_RADIUS * Math.sin(a) * ms);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        this.munOrbitLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.3 }));
        this.scene.add(this.munOrbitLine);
    }

    _removeOrbitLine() {
        if (this.orbitLine) { this.scene.remove(this.orbitLine); this.orbitLine.geometry.dispose(); this.orbitLine = null; }
        if (this.munOrbitLine) { this.scene.remove(this.munOrbitLine); this.munOrbitLine.geometry.dispose(); this.munOrbitLine = null; }
    }
}

new Game();
