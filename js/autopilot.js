import * as THREE from 'three';
import { CONFIG } from './config.js';

export class Autopilot {
    constructor(game) {
        this.game = game;
        this.state = 'IDLE';
        this.missionTarget = null;
        this.targetOrbitAlt = 100000;
        this.data = {};
    }

    activateOrbit() { this.state = 'LAUNCH'; this.missionTarget = null; this.data = {}; this._updateStatus(); }
    activateMunMission() { this.state = 'LAUNCH'; this.missionTarget = 'mun'; this.data = {}; this._updateStatus(); }
    activateLanding() {
        this.missionTarget = null; this.data = {};
        const g = this.game;
        if (g.physics.isInMunSOI(g.physState.position)) {
            this.state = 'MUN_LANDING'; this.data = { phase: 'deorbit' };
        } else if (g.physics.getAltitude(g.physState.position) > 50000) {
            this.state = 'DEORBIT';
        } else {
            this.state = 'REENTRY';
        }
        this._updateStatus();
    }
    deactivate() { this.state = 'IDLE'; const r = this.game.rocket; if (r) r.throttle = 0; this._updateStatus(); }

    // --- direction helpers (return plain {x,y,z} unit vectors) ---
    _prograde() {
        const v = this.game.physState.velocity;
        const s = Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z);
        return s > 1 ? { x: v.x/s, y: v.y/s, z: v.z/s } : { x: 0, y: 1, z: 0 };
    }
    _retrograde() { const p = this._prograde(); return { x: -p.x, y: -p.y, z: -p.z }; }
    _radialOut() {
        const p = this.game.physState.position;
        const s = Math.sqrt(p.x*p.x + p.y*p.y + p.z*p.z);
        return s > 1 ? { x: p.x/s, y: p.y/s, z: p.z/s } : { x: 0, y: 1, z: 0 };
    }

    _munRetro() {
        const ms = this._munRel();
        const s = ms.rs;
        return s > 1 ? { x: -ms.rv.x/s, y: -ms.rv.y/s, z: -ms.rv.z/s } : { x: 0, y: 1, z: 0 };
    }
    _munRadialOut() {
        const ms = this._munRel();
        const s = ms.rr;
        return s > 1 ? { x: ms.rp.x/s, y: ms.rp.y/s, z: ms.rp.z/s } : { x: 0, y: 1, z: 0 };
    }

    _munRel() {
        const ph = this.game.physics;
        const munPos = ph.getMunPosition();
        const vel = this.game.physState.velocity;
        const pos = this.game.physState.position;
        const munV = 2 * Math.PI * CONFIG.MUN_ORBIT_RADIUS / CONFIG.MUN_ORBIT_PERIOD;
        const a = ph.munAngle;
        const mv = { x: -munV * Math.sin(a), y: 0, z: munV * Math.cos(a) };
        const rp = { x: pos.x - munPos.x, y: pos.y - munPos.y, z: pos.z - munPos.z };
        const rv = { x: vel.x - mv.x, y: vel.y - mv.y, z: vel.z - mv.z };
        const rr = Math.sqrt(rp.x**2 + rp.y**2 + rp.z**2);
        const rs = Math.sqrt(rv.x**2 + rv.y**2 + rv.z**2);
        const ma = rr - CONFIG.MUN_RADIUS;
        const mo = ph.computeOrbitalElements(rp, rv, CONFIG.MUN_MU, CONFIG.MUN_RADIUS);
        const vr = rr > 0 ? (rp.x*rv.x + rp.y*rv.y + rp.z*rv.z) / rr : 0;
        return { rp, rv, rr, rs, ma, mo, vr };
    }

    _steer(target, dt) {
        const rocket = this.game.rocket;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rocket.orientation);
        const t = new THREE.Vector3(target.x, target.y, target.z);

        if (up.dot(t) > 0.999) return;

        if (up.dot(t) < -0.95) {
            const ref = new THREE.Vector3(0, 1, 0);
            const axis = new THREE.Vector3().crossVectors(up, ref);
            if (axis.lengthSq() < 0.001) axis.set(1, 0, 0);
            axis.normalize();
            rocket.orientation.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, 3.0 * dt));
            rocket.orientation.normalize();
            return;
        }

        const correction = new THREE.Quaternion().setFromUnitVectors(up, t);
        const slerpFactor = Math.min(1, dt * 3);
        const partial = new THREE.Quaternion().identity().slerp(correction, slerpFactor);
        rocket.orientation.premultiply(partial);
        rocket.orientation.normalize();
    }

    _autoStage() {
        const rocket = this.game.rocket;
        let stageEnd = rocket.parts.length;
        const stage = rocket.stages[rocket.currentStage];
        if (stage && stage.decoupler) {
            const decIdx = rocket.parts.indexOf(stage.decoupler);
            if (decIdx >= 0) stageEnd = decIdx;
        }
        let hasFuel = false;
        for (const p of rocket.parts) {
            if (p.isEngine && p.active && p.fuel > 0) { hasFuel = true; break; }
        }
        if (!hasFuel) {
            for (let i = 0; i < stageEnd; i++) {
                if (rocket.parts[i].isFuelTank && rocket.parts[i].fuel > 0) { hasFuel = true; break; }
            }
        }
        if (hasFuel) return;
        if (rocket.currentStage < rocket.stages.length - 1 || rocket.stages[rocket.currentStage]?.decoupler) {
            rocket.activateStage();
            this.game.effects?.playStagingSound();
        }
    }

    _maxThrust() { return this.game.rocket.parts.filter(p => p.canThrust()).reduce((s, p) => s + p.thrust, 0); }
    _hasFuel() { return this.game.rocket.totalFuel > 0 && this._maxThrust() > 0; }

    _setWarp(idx) {
        const g = this.game;
        const alt = g.physics.getAltitude(g.physState.position);
        const maxIdx = alt > CONFIG.ATMOSPHERE_HEIGHT ? CONFIG.TIME_WARP_LEVELS.length - 1 : 2;
        g.timeWarpIndex = Math.max(0, Math.min(idx, maxIdx));
        g.timeWarp = CONFIG.TIME_WARP_LEVELS[g.timeWarpIndex];
    }

    // ============ STATES ============

    _updateLAUNCH(dt) {
        const g = this.game;
        const alt = g.physics.getAltitude(g.physState.position);
        const els = g.physics.computeOrbitalElements(g.physState.position, g.physState.velocity);
        const vSpd = g.physics.getVerticalSpeed(g.physState.position, g.physState.velocity);

        g.rocket.throttle = 1;
        this._autoStage();

        // If falling back fast, point up to arrest descent
        if (vSpd < -200 && alt < 30000) {
            this._steer(this._radialOut(), dt);
        } else if (alt < 200) {
            this._steer(this._radialOut(), dt);
        } else if (alt < 5000) {
            const rad = this._radialOut();
            let ex = -rad.z, ez = rad.x;
            let eLen = Math.sqrt(ex*ex + ez*ez);
            if (eLen < 0.01) {
                if (this.missionTarget === 'mun') {
                    const mp = g.physics.getMunPosition();
                    const ml = Math.sqrt(mp.x*mp.x + mp.z*mp.z);
                    if (ml > 0.01) { ex = mp.x/ml; ez = mp.z/ml; } else { ex = 1; ez = 0; }
                } else {
                    ex = 1; ez = 0;
                }
                eLen = 1;
            }
            const t = Math.min(1, (alt - 200) / 4800);
            const tiltDeg = 5 + t * 60;
            const tilt = tiltDeg * Math.PI / 180;
            const sinT = Math.sin(tilt), cosT = Math.cos(tilt);
            const target = {
                x: rad.x * cosT + (ex/eLen) * sinT,
                y: rad.y * cosT,
                z: rad.z * cosT + (ez/eLen) * sinT,
            };
            const s = Math.sqrt(target.x**2 + target.y**2 + target.z**2);
            this._steer({ x: target.x/s, y: target.y/s, z: target.z/s }, dt);
        } else {
            this._steer(this._prograde(), dt);
        }

        if (els && els.apoapsis > this.targetOrbitAlt) {
            g.rocket.throttle = 0;
            this.state = 'ORBIT_INSERT';
            this.data = {};
            this._updateStatus();
        }
    }

    _updateORBIT_INSERT(dt) {
        const g = this.game;
        const els = g.physics.computeOrbitalElements(g.physState.position, g.physState.velocity);
        const vSpd = g.physics.getVerticalSpeed(g.physState.position, g.physState.velocity);
        const alt = g.physics.getAltitude(g.physState.position);
        if (!els) return;

        if (els.periapsis >= this.targetOrbitAlt * 0.9) {
            g.rocket.throttle = 0;
            this.state = this.missionTarget === 'mun' ? 'MUN_WAIT' : 'IDLE';
            this.data = {};
            this._updateStatus();
            return;
        }

        this._steer(this._prograde(), dt);

        if (alt > this.targetOrbitAlt * 0.7 && vSpd >= -30 && vSpd <= 80) {
            g.rocket.throttle = 1;
            this._autoStage();
        } else {
            g.rocket.throttle = 0;
        }
    }

    _updateMUN_TRANSFER(dt) {
        const g = this.game;
        if (g.physics.isInMunSOI(g.physState.position)) {
            this._setWarp(0);
            this.state = 'MUN_CAPTURE';
            this.data = {};
            this._updateStatus();
            return;
        }

        this._steer(this._prograde(), dt);
        g.rocket.throttle = 1;
        this._autoStage();

        const els = g.physics.computeOrbitalElements(g.physState.position, g.physState.velocity);
        const targetApo = CONFIG.MUN_ORBIT_RADIUS - CONFIG.PLANET_RADIUS;
        if (els && els.apoapsis >= targetApo) {
            g.rocket.throttle = 0;
            this.state = 'COAST';
            this.data = {};
            this._updateStatus();
        }
    }

    _updateCOAST(dt) {
        const g = this.game;
        g.rocket.throttle = 0;
        this._steer(this._prograde(), dt);

        const alt = g.physics.getAltitude(g.physState.position);
        if (alt > CONFIG.ATMOSPHERE_HEIGHT && g.timeWarpIndex < 4) this._setWarp(4);

        if (g.physics.isInMunSOI(g.physState.position)) {
            this._setWarp(0);
            this.state = 'MUN_CAPTURE';
            this.data = {};
            this._updateStatus();
            return;
        }

        const els = g.physics.computeOrbitalElements(g.physState.position, g.physState.velocity);
        const vSpd = g.physics.getVerticalSpeed(g.physState.position, g.physState.velocity);
        if (els && vSpd < -200 && els.periapsis < this.targetOrbitAlt) {
            this._setWarp(0);
            this.state = 'MUN_WAIT';
            this.data = {};
            this._updateStatus();
        }
    }

    _updateMUN_WAIT(dt) {
        const g = this.game;
        g.rocket.throttle = 0;
        this._steer(this._prograde(), dt);

        const pos = g.physState.position;
        const vel = g.physState.velocity;
        const TWO_PI = 2 * Math.PI;

        // Orbit node angle from angular momentum (conserved)
        const hx = pos.y * vel.z - pos.z * vel.y;
        const hz = pos.x * vel.y - pos.y * vel.x;
        const nodeAngle = Math.atan2(hx, -hz);

        // Hohmann transfer time
        const r1 = Math.sqrt(pos.x**2 + pos.y**2 + pos.z**2);
        const aT = (r1 + CONFIG.MUN_ORBIT_RADIUS) / 2;
        const tTransfer = Math.PI * Math.sqrt(aT**3 / CONFIG.PLANET_MU);
        const omegaMun = TWO_PI / CONFIG.MUN_ORBIT_PERIOD;

        // Required Mun angles for transfer at each node
        let munAng = ((g.physics.munAngle % TWO_PI) + TWO_PI) % TWO_PI;
        const need1 = ((nodeAngle + Math.PI - omegaMun * tTransfer) % TWO_PI + TWO_PI) % TWO_PI;
        const need2 = ((nodeAngle - omegaMun * tTransfer) % TWO_PI + TWO_PI) % TWO_PI;

        // Forward distance: Mun must travel this far counterclockwise
        let d1 = ((need1 - munAng) % TWO_PI + TWO_PI) % TWO_PI;
        let d2 = ((need2 - munAng) % TWO_PI + TWO_PI) % TWO_PI;
        const fwd = Math.min(d1, d2);

        // Keep high warp — never drop below 10x until very close
        const alt = g.physics.getAltitude(g.physState.position);
        if (alt > CONFIG.ATMOSPHERE_HEIGHT) {
            if (fwd > 0.3) this._setWarp(5);       // 100x
            else if (fwd > 0.03) this._setWarp(3);  // 10x
            else this._setWarp(1);                   // 2x
        }

        // When phase is close, check alignment (combines Mun angle + spacecraft position)
        // alignment = sin(θ) for this orbit geometry, peaks at ~0.99 at nodes when fwd < 0.15
        if (fwd < 0.15) {
            const apoDir = { x: -pos.x/r1, y: -pos.y/r1, z: -pos.z/r1 };
            const arrAngle = g.physics.munAngle + omegaMun * tTransfer;
            const munDir = { x: Math.cos(arrAngle), y: 0, z: Math.sin(arrAngle) };
            const alignment = apoDir.x*munDir.x + apoDir.y*munDir.y + apoDir.z*munDir.z;

            if (alignment > 0.985) {
                this._setWarp(0);
                this.state = 'MUN_TRANSFER';
                this.data = {};
                this._updateStatus();
            }
        }
    }

    _updateMUN_CAPTURE(dt) {
        const g = this.game;
        this._setWarp(0);
        this._steer(this._munRetro(), dt);
        const ms = this._munRel();
        if (ms.mo && ms.mo.energy < 0 && ms.mo.periapsis < 20000) {
            g.rocket.throttle = 0;
            this.state = 'MUN_LANDING';
            this.data = { phase: 'deorbit' };
            this._updateStatus();
            return;
        }
        g.rocket.throttle = 1;
        this._autoStage();
    }

    _updateMUN_LANDING(dt) {
        const g = this.game;
        this._setWarp(0);
        const ms = this._munRel();
        if (!this.data.phase) this.data.phase = 'deorbit';
        const maxT = this._maxThrust();
        const mass = g.rocket.totalMass;
        if (maxT <= 0 || mass <= 0) { this.state = 'IDLE'; this._updateStatus(); return; }

        const grav = CONFIG.MUN_SURFACE_GRAVITY;
        const maxDecel = maxT / mass;
        const netDecel = Math.max(0.5, maxDecel - grav);

        if (this.data.phase === 'deorbit') {
            this._steer(this._munRetro(), dt);
            g.rocket.throttle = 1;
            this._autoStage();
            if (!ms.mo || ms.mo.periapsis < 3000 || ms.ma < 5000) this.data.phase = 'descent';
            return;
        }

        // Speed limit: max speed at which we can still stop before surface
        const speedLimit = Math.sqrt(Math.max(1, 2 * netDecel * ms.ma * 0.8));

        if (ms.rs > speedLimit && ms.ma > 20) {
            // Too fast for altitude: continuous retrograde burn (no oscillation)
            this._steer(this._munRetro(), dt);
            g.rocket.throttle = 1;
        } else {
            // Speed under control: PD-controlled vertical descent
            this._steer(ms.ma > 50 ? this._munRetro() : this._munRadialOut(), dt);
            const targetVr = -Math.sqrt(Math.max(1, ms.ma * 0.5));
            const err = targetVr - ms.vr;
            g.rocket.throttle = Math.max(0, Math.min(1, (grav + err * 2) * mass / maxT));
        }

        if (ms.ma < 5 && Math.abs(ms.vr) < 2) {
            g.rocket.throttle = 0;
            this.state = 'IDLE';
            this._updateStatus();
        }
    }

    _updateDEORBIT(dt) {
        const g = this.game;
        this._steer(this._retrograde(), dt);
        g.rocket.throttle = 1;
        this._autoStage();
        const els = g.physics.computeOrbitalElements(g.physState.position, g.physState.velocity);
        if (els && els.periapsis < 30000) {
            g.rocket.throttle = 0;
            this.state = 'REENTRY';
            this.data = {};
            this._updateStatus();
        }
    }

    _updateREENTRY(dt) {
        const g = this.game;
        const alt = g.physics.getAltitude(g.physState.position);
        this._steer(this._prograde(), dt);
        g.rocket.throttle = 0;
        if (alt < 5000) {
            g.rocket.deployParachutes();
            this.state = 'LANDING';
            this.data = {};
            this._updateStatus();
        }
    }

    _updateLANDING(dt) {
        const g = this.game;
        this._setWarp(0);
        const alt = g.physics.getAltitude(g.physState.position);
        const vSpd = g.physics.getVerticalSpeed(g.physState.position, g.physState.velocity);
        this._steer(this._radialOut(), dt);
        const maxT = this._maxThrust();
        const mass = g.rocket.totalMass;
        if (maxT > 0 && mass > 0 && alt > 0) {
            const grav = CONFIG.SURFACE_GRAVITY;
            const maxDecel = maxT / mass;
            const netDecel = Math.max(1, maxDecel - grav);
            const speedLimit = Math.sqrt(Math.max(1, 2 * netDecel * alt * 0.5));
            if (-vSpd > speedLimit) {
                g.rocket.throttle = Math.min(1, (grav + Math.abs(vSpd) * 1.5) * mass / maxT);
            } else {
                const targetVr = -Math.sqrt(Math.max(1, alt * 0.3));
                const err = targetVr - vSpd;
                g.rocket.throttle = Math.max(0, Math.min(1, (grav + err * 2) * mass / maxT));
            }
        } else {
            g.rocket.throttle = 0;
        }
        if (alt <= 0) { g.rocket.throttle = 0; this.state = 'IDLE'; this._updateStatus(); }
    }

    // ============ MAIN ============
    update(dt) {
        if (this.state === 'IDLE') return;
        if (dt > 0.5) dt = 0.5;
        const fn = this['_update' + this.state];
        if (fn) fn.call(this, dt);
        if (!this._hasFuel() && ['LAUNCH','ORBIT_INSERT','MUN_TRANSFER','MUN_CAPTURE','DEORBIT'].includes(this.state)) {
            this.state = 'IDLE';
            this._updateStatus();
        }
    }

    _updateStatus() {
        const L = { IDLE:'关闭', LAUNCH:'发射上升', ORBIT_INSERT:'轨道插入',
            MUN_TRANSFER:'月球转移', COAST:'滑行中', MUN_WAIT:'等待相位',
            MUN_CAPTURE:'月球捕获', MUN_LANDING:'月球着陆',
            DEORBIT:'离轨减速', REENTRY:'再入大气', LANDING:'着陆' };
        const el = document.getElementById('ap-status');
        if (el) el.textContent = L[this.state] || this.state;
        const ind = document.getElementById('ap-indicator');
        if (ind) ind.classList.toggle('active', this.state !== 'IDLE');
    }
}
