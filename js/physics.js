import { CONFIG } from './config.js';

export class PhysicsEngine {
    constructor() {
        this.g0 = 9.81;
        this.munAngle = 0;
    }

    updateMunAngle(dt) {
        this.munAngle += CONFIG.MUN_ANGULAR_VELOCITY * dt;
    }

    getMunPosition() {
        return {
            x: CONFIG.MUN_ORBIT_RADIUS * Math.cos(this.munAngle),
            y: 0,
            z: CONFIG.MUN_ORBIT_RADIUS * Math.sin(this.munAngle),
        };
    }

    gravityAcceleration(position) {
        const r2 = position.x ** 2 + position.y ** 2 + position.z ** 2;
        const r = Math.sqrt(r2);
        if (r < 1) return { x: 0, y: 0, z: 0 };
        const gMag = CONFIG.PLANET_MU / r2;
        return { x: -gMag * position.x / r, y: -gMag * position.y / r, z: -gMag * position.z / r };
    }

    munGravityAcceleration(position) {
        const mun = this.getMunPosition();
        const dx = position.x - mun.x, dy = position.y - mun.y, dz = position.z - mun.z;
        const r2 = dx * dx + dy * dy + dz * dz;
        const r = Math.sqrt(r2);
        if (r < 1) return { x: 0, y: 0, z: 0 };
        const gMag = CONFIG.MUN_MU / r2;
        return { x: -gMag * dx / r, y: -gMag * dy / r, z: -gMag * dz / r };
    }

    isInMunSOI(position) {
        const mun = this.getMunPosition();
        const dx = position.x - mun.x, dy = position.y - mun.y, dz = position.z - mun.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return dist < CONFIG.MUN_SOI;
    }

    totalGravity(position) {
        const gPlanet = this.gravityAcceleration(position);
        const gMun = this.munGravityAcceleration(position);
        return {
            x: gPlanet.x + gMun.x,
            y: gPlanet.y + gMun.y,
            z: gPlanet.z + gMun.z,
        };
    }

    atmosphericDensity(position) {
        const r = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
        const alt = r - CONFIG.PLANET_RADIUS;
        if (alt < 0 || alt > CONFIG.ATMOSPHERE_HEIGHT) return 0;
        return CONFIG.ATMOSPHERE_DENSITY_SEA * Math.exp(-alt / CONFIG.ATMOSPHERE_SCALE_HEIGHT);
    }

    computeDragForce(position, velocity, dragArea) {
        const rho = this.atmosphericDensity(position);
        if (rho <= 0) return { x: 0, y: 0, z: 0 };
        const vMag = Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
        if (vMag < 0.01) return { x: 0, y: 0, z: 0 };
        const dragMag = 0.5 * rho * vMag * vMag * CONFIG.DRAG_COEFFICIENT * dragArea;
        return { x: -dragMag * velocity.x / vMag, y: -dragMag * velocity.y / vMag, z: -dragMag * velocity.z / vMag };
    }

    // RK4 integration for better accuracy
    update(state, dt, thrustForce, timeWarp = 1) {
        const effectiveDt = dt * timeWarp;
        const substeps = timeWarp > CONFIG.MAX_PHYSICS_WARP ? 4 : 2;
        const subDt = effectiveDt / substeps;

        for (let i = 0; i < substeps; i++) {
            this._rk4Step(state, subDt, thrustForce);
        }
    }

    _rk4Step(state, dt, thrustForce) {
        const { position: p, velocity: v, mass, dragArea } = state;

        const accel = (pos, vel) => {
            const grav = this.totalGravity(pos);
            const drag = this.computeDragForce(pos, vel, dragArea);
            return {
                ax: grav.x + (thrustForce.x + drag.x) / mass,
                ay: grav.y + (thrustForce.y + drag.y) / mass,
                az: grav.z + (thrustForce.z + drag.z) / mass,
            };
        };

        // k1
        const a1 = accel(p, v);
        const k1v = { x: a1.ax * dt, y: a1.ay * dt, z: a1.az * dt };
        const k1p = { x: v.x * dt, y: v.y * dt, z: v.z * dt };

        // k2
        const p2 = { x: p.x + k1p.x * 0.5, y: p.y + k1p.y * 0.5, z: p.z + k1p.z * 0.5 };
        const v2 = { x: v.x + k1v.x * 0.5, y: v.y + k1v.y * 0.5, z: v.z + k1v.z * 0.5 };
        const a2 = accel(p2, v2);
        const k2v = { x: a2.ax * dt, y: a2.ay * dt, z: a2.az * dt };
        const k2p = { x: v2.x * dt, y: v2.y * dt, z: v2.z * dt };

        // k3
        const p3 = { x: p.x + k2p.x * 0.5, y: p.y + k2p.y * 0.5, z: p.z + k2p.z * 0.5 };
        const v3 = { x: v.x + k2v.x * 0.5, y: v.y + k2v.y * 0.5, z: v.z + k2v.z * 0.5 };
        const a3 = accel(p3, v3);
        const k3v = { x: a3.ax * dt, y: a3.ay * dt, z: a3.az * dt };
        const k3p = { x: v3.x * dt, y: v3.y * dt, z: v3.z * dt };

        // k4
        const p4 = { x: p.x + k3p.x, y: p.y + k3p.y, z: p.z + k3p.z };
        const v4 = { x: v.x + k3v.x, y: v.y + k3v.y, z: v.z + k3v.z };
        const a4 = accel(p4, v4);
        const k4v = { x: a4.ax * dt, y: a4.ay * dt, z: a4.az * dt };
        const k4p = { x: v4.x * dt, y: v4.y * dt, z: v4.z * dt };

        p.x += (k1p.x + 2 * k2p.x + 2 * k3p.x + k4p.x) / 6;
        p.y += (k1p.y + 2 * k2p.y + 2 * k3p.y + k4p.y) / 6;
        p.z += (k1p.z + 2 * k2p.z + 2 * k3p.z + k4p.z) / 6;

        v.x += (k1v.x + 2 * k2v.x + 2 * k3v.x + k4v.x) / 6;
        v.y += (k1v.y + 2 * k2v.y + 2 * k3v.y + k4v.y) / 6;
        v.z += (k1v.z + 2 * k2v.z + 2 * k3v.z + k4v.z) / 6;
    }

    getAltitude(position) {
        return Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2) - CONFIG.PLANET_RADIUS;
    }

    getSpeed(velocity) {
        return Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
    }

    getOrbitalSpeed(position, velocity) {
        const r = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
        const v = this.getSpeed(velocity);
        const vr = (position.x * velocity.x + position.y * velocity.y + position.z * velocity.z) / r;
        return Math.sqrt(Math.max(0, v * v - vr * vr));
    }

    getVerticalSpeed(position, velocity) {
        const r = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
        return r > 0 ? (position.x * velocity.x + position.y * velocity.y + position.z * velocity.z) / r : 0;
    }

    computeOrbitalElements(position, velocity, mu, bodyRadius) {
        mu = mu || CONFIG.PLANET_MU;
        bodyRadius = bodyRadius != null ? bodyRadius : CONFIG.PLANET_RADIUS;
        const r = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
        const v = Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
        if (r < 1) return null;

        const energy = 0.5 * v * v - mu / r;
        const a = energy !== 0 ? -mu / (2 * energy) : Infinity;

        const hx = position.y * velocity.z - position.z * velocity.y;
        const hy = position.z * velocity.x - position.x * velocity.z;
        const hz = position.x * velocity.y - position.y * velocity.x;

        const rv = position.x * velocity.x + position.y * velocity.y + position.z * velocity.z;
        const ex = ((v * v - mu / r) * position.x - rv * velocity.x) / mu;
        const ey = ((v * v - mu / r) * position.y - rv * velocity.y) / mu;
        const ez = ((v * v - mu / r) * position.z - rv * velocity.z) / mu;
        const e = Math.sqrt(ex * ex + ey * ey + ez * ez);

        let apoapsis = 0, periapsis = 0, period = 0;
        if (e < 1 && a > 0) {
            apoapsis = a * (1 + e) - bodyRadius;
            periapsis = a * (1 - e) - bodyRadius;
            period = 2 * Math.PI * Math.sqrt(a * a * a / mu);
        } else if (e >= 1) {
            periapsis = a * (1 - e) - bodyRadius;
            apoapsis = Infinity;
        }

        return { semiMajorAxis: a, eccentricity: e, apoapsis, periapsis, period, energy };
    }

    predictOrbit(position, velocity, mu, numPoints = 300) {
        mu = mu || CONFIG.PLANET_MU;
        const els = this.computeOrbitalElements(position, velocity, mu);
        if (!els) return [];

        const { semiMajorAxis: a, eccentricity: e } = els;
        if (a <= 0 || e >= 1) return this._predictHyperbolic(position, velocity, mu, numPoints);

        const r = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
        const rv = position.x * velocity.x + position.y * velocity.y + position.z * velocity.z;

        const eMag = Math.sqrt((els.energy || 0) * 2 + 2 * mu / r) || e;
        let trueAnomaly = 0;
        if (e > 0.0001) {
            const cosTA = Math.max(-1, Math.min(1, ((position.x * ((velocity.y * velocity.z - velocity.y * velocity.z)) / mu) + (r - a) * position.x / r) / (e * r)));
            trueAnomaly = rv > 0 ? Math.acos(Math.max(-1, Math.min(1, (1/e) * (1 - r/a)))) : 2 * Math.PI - Math.acos(Math.max(-1, Math.min(1, (1/e) * (1 - r/a))));
        }

        const p = a * (1 - e * e);
        const points = [];
        for (let i = 0; i <= numPoints; i++) {
            const nu = trueAnomaly + (i / numPoints) * 2 * Math.PI;
            const denom = 1 + e * Math.cos(nu);
            if (denom <= 0.001) continue;
            const rOrbit = p / denom;
            const cosNu = Math.cos(nu), sinNu = Math.sin(nu);

            const ux = position.x / r, uy = position.y / r, uz = position.z / r;
            const hx = position.y * velocity.z - position.z * velocity.y;
            const hy = position.z * velocity.x - position.x * velocity.z;
            const hz = position.x * velocity.y - position.y * velocity.x;
            const hMag = Math.sqrt(hx * hx + hy * hy + hz * hz);

            if (e > 0.0001 && hMag > 0) {
                const ex2 = ((velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z - mu / r) * position.x - rv * velocity.x) / mu;
                const ey2 = ((velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z - mu / r) * position.y - rv * velocity.y) / mu;
                const ez2 = ((velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z - mu / r) * position.z - rv * velocity.z) / mu;
                const eDir = { x: ex2 / e, y: ey2 / e, z: ez2 / e };
                const hDir = { x: hx / hMag, y: hy / hMag, z: hz / hMag };
                const n = { x: hDir.y * eDir.z - hDir.z * eDir.y, y: hDir.z * eDir.x - hDir.x * eDir.z, z: hDir.x * eDir.y - hDir.y * eDir.x };

                points.push({
                    x: rOrbit * (cosNu * eDir.x + sinNu * n.x),
                    y: rOrbit * (cosNu * eDir.y + sinNu * n.y),
                    z: rOrbit * (cosNu * eDir.z + sinNu * n.z),
                });
            }
        }
        return points.length > 2 ? points : this._predictHyperbolic(position, velocity, mu, numPoints);
    }

    _predictHyperbolic(position, velocity, mu, numPoints) {
        const points = [];
        const dt = 10;
        const pos = { x: position.x, y: position.y, z: position.z };
        const vel = { x: velocity.x, y: velocity.y, z: velocity.z };
        for (let i = 0; i < numPoints; i++) {
            points.push({ x: pos.x, y: pos.y, z: pos.z });
            const r = Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2);
            if (r < CONFIG.PLANET_RADIUS) break;
            const gMag = mu / (r * r);
            vel.x -= gMag * pos.x / r * dt;
            vel.y -= gMag * pos.y / r * dt;
            vel.z -= gMag * pos.z / r * dt;
            pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
        }
        return points;
    }
}
