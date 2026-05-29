import * as THREE from 'three';
import { CONFIG, PART_DEFS } from './config.js';

export class Part {
    constructor(type) {
        const def = PART_DEFS[type];
        Object.assign(this, {
            type, name: def.name, dryMass: def.dryMass, fuel: def.fuelCapacity,
            fuelCapacity: def.fuelCapacity, thrust: def.thrust, isp: def.isp,
            dragArea: def.dragArea, height: def.height, width: def.width,
            color: def.color, stageType: def.stageType, active: false,
            deployedDragArea: def.deployedDragArea || 0, deployed: false,
        });
    }
    get mass() { return this.dryMass + this.fuel; }
    get isEngine() { return this.stageType === 'engine'; }
    get isDecoupler() { return this.stageType === 'decoupler'; }
    get isFuelTank() { return this.stageType === 'fuel'; }
    get isParachute() { return this.stageType === 'parachute'; }
    canThrust() { return this.isEngine && this.active; }
}

export class Rocket {
    constructor() {
        this.parts = []; this.stages = []; this.currentStage = 0;
        this.throttle = 0; this.orientation = new THREE.Quaternion();
        this.meshGroup = new THREE.Group(); this.sasEnabled = false;
    }

    static createFromParts(partTypes) {
        const r = new Rocket();
        for (const t of partTypes) r.parts.push(new Part(t));
        r._buildMesh(); r._autoStage(); return r;
    }

    _buildMesh() {
        while (this.meshGroup.children.length) this.meshGroup.remove(this.meshGroup.children[0]);
        let y = 0;
        this.flameMeshes = [];
        for (const part of this.parts) {
            const def = PART_DEFS[part.type];
            const geo = this._geo(part.type, def);
            const mat = new THREE.MeshPhongMaterial({ color: def.color, shininess: 30, flatShading: true });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.y = y + def.height / 2;
            this.meshGroup.add(mesh);
            // Add flame cone for engines
            if (part.isEngine) {
                const flameGeo = new THREE.ConeGeometry(def.width * 0.35, 2.0, 8);
                const flameMat = new THREE.MeshBasicMaterial({
                    color: 0xff6600, transparent: true, opacity: 0,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                });
                const flame = new THREE.Mesh(flameGeo, flameMat);
                flame.position.y = y - 0.5;
                flame.rotation.z = Math.PI; // point downward
                flame.visible = false;
                this.meshGroup.add(flame);
                this.flameMeshes.push(flame);
                // Inner core (brighter)
                const coreGeo = new THREE.ConeGeometry(def.width * 0.18, 1.5, 6);
                const coreMat = new THREE.MeshBasicMaterial({
                    color: 0xffffaa, transparent: true, opacity: 0,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                });
                const core = new THREE.Mesh(coreGeo, coreMat);
                core.position.y = y - 0.3;
                core.rotation.z = Math.PI;
                core.visible = false;
                this.meshGroup.add(core);
                this.flameMeshes.push(core);
            }
            y += def.height;
        }
        // Kerbal head on top
        if (this.parts.some(p => p.stageType === 'command')) {
            const headGeo = new THREE.SphereGeometry(0.25, 8, 8);
            const headMat = new THREE.MeshPhongMaterial({ color: 0x66cc66 });
            const head = new THREE.Mesh(headGeo, headMat);
            head.position.y = y + 0.3;
            head.scale.set(1, 1.2, 1);
            this.meshGroup.add(head);
            // Visor
            const visorGeo = new THREE.SphereGeometry(0.15, 8, 8, 0, Math.PI);
            const visorMat = new THREE.MeshPhongMaterial({ color: 0x333333 });
            const visor = new THREE.Mesh(visorGeo, visorMat);
            visor.position.set(0, y + 0.3, 0.2);
            this.meshGroup.add(visor);
        }
    }

    _geo(type, def) {
        const w = def.width / 2, h = def.height;
        switch (type) {
            case 'CommandPod': case 'CommandPodSmall': return new THREE.ConeGeometry(w, h, 8);
            case 'LargeTank': case 'SmallTank': case 'TinyTank': return new THREE.CylinderGeometry(w, w, h, 12);
            case 'LargeEngine': return new THREE.CylinderGeometry(w * 0.6, w, h, 12);
            case 'SmallEngine': return new THREE.CylinderGeometry(w * 0.5, w, h, 8);
            case 'VacuumEngine': return new THREE.CylinderGeometry(w * 0.4, w * 0.9, h, 12);
            case 'SolidBooster': return new THREE.CylinderGeometry(w * 0.8, w, h, 8);
            case 'Decoupler': return new THREE.CylinderGeometry(w + 0.02, w + 0.02, h, 12);
            case 'Parachute': {
                const g = new THREE.Group();
                const base = new THREE.CylinderGeometry(w * 0.5, w * 0.5, h, 8);
                return base;
            }
            case 'Fairing': return new THREE.CylinderGeometry(w, w * 0.3, h, 8);
            case 'SolarPanel': return new THREE.BoxGeometry(w * 2, h, 0.05);
            case 'LandingLeg': return new THREE.CylinderGeometry(0.05, 0.05, h, 4);
            default: return new THREE.CylinderGeometry(w, w, h, 8);
        }
    }

    _autoStage() {
        this.stages = [];
        let eng = [];
        for (const p of this.parts) if (p.isEngine) p.active = false;
        for (const p of this.parts) {
            if (p.isEngine) { eng.push(p); }
            else if (p.isDecoupler && eng.length > 0) {
                this.stages.push({ engines: eng, decoupler: p });
                eng = [];
            }
        }
        if (eng.length > 0) this.stages.push({ engines: eng, decoupler: null });
        this.currentStage = 0;
        if (this.stages.length > 0) for (const p of this.stages[0].engines) p.active = true;
    }

    activateStage() {
        if (this.currentStage >= this.stages.length) return;
        const stage = this.stages[this.currentStage];
        if (!stage) return;
        for (const p of stage.engines) p.active = false;
        if (stage.decoupler) {
            const idx = this.parts.indexOf(stage.decoupler);
            if (idx >= 0) { this.parts.splice(0, idx + 1); this._buildMesh(); this.stages.shift(); }
        } else { this.currentStage++; }
        if (this.currentStage < this.stages.length) for (const p of this.stages[this.currentStage].engines) p.active = true;
    }

    deployParachutes() {
        for (const p of this.parts) if (p.isParachute) p.deployed = true;
    }

    get totalMass() { return this.parts.reduce((s, p) => s + p.mass, 0); }
    get totalFuel() { return this.parts.reduce((s, p) => s + p.fuel, 0); }
    get totalFuelCapacity() { return this.parts.reduce((s, p) => s + p.fuelCapacity, 0); }
    get fuelFraction() { const c = this.totalFuelCapacity; return c > 0 ? this.totalFuel / c : 1; }
    get currentThrust() { return this.parts.filter(p => p.canThrust()).reduce((s, p) => s + p.thrust * this.throttle, 0); }
    get totalDragArea() {
        let a = this.parts.reduce((s, p) => s + p.dragArea, 0);
        for (const p of this.parts) if (p.isParachute && p.deployed) a += p.deployedDragArea;
        return a;
    }

    computeThrustForce(dt) {
        const active = this.parts.filter(p => p.canThrust());
        if (active.length === 0 || this.throttle <= 0) return { x: 0, y: 0, z: 0 };
        let totalT = 0, totalF = 0;
        for (const e of active) {
            const f = e.thrust * this.throttle;
            totalT += f;
            if (e.isp > 0) totalF += (f / (e.isp * 9.81)) * dt;
        }
        if (totalT <= 0) return { x: 0, y: 0, z: 0 };
        const consumed = this._drainFuel(totalF);
        if (consumed <= 0) return { x: 0, y: 0, z: 0 };
        const eff = totalT * Math.min(1, consumed / totalF);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.orientation);
        return { x: up.x * eff, y: up.y * eff, z: up.z * eff };
    }

    _drainFuel(amount) {
        let rem = amount, got = 0;
        for (const p of this.parts) {
            if (p.isEngine && p.fuel > 0) { const t = Math.min(rem, p.fuel); p.fuel -= t; rem -= t; got += t; if (rem <= 0) return got; }
        }
        // Only drain from fuel tanks in the current stage (below next decoupler)
        let stageEnd = this.parts.length;
        const stage = this.stages[this.currentStage];
        if (stage && stage.decoupler) {
            const decIdx = this.parts.indexOf(stage.decoupler);
            if (decIdx >= 0) stageEnd = decIdx;
        }
        for (let i = 0; i < stageEnd; i++) {
            const p = this.parts[i];
            if (p.isFuelTank && p.fuel > 0) { const t = Math.min(rem, p.fuel); p.fuel -= t; rem -= t; got += t; if (rem <= 0) break; }
        }
        return got;
    }

    applyRotation(pitch, yaw, roll, dt) {
        const s = this.sasEnabled ? 2.5 : 1.5;
        if (pitch) this.orientation.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), pitch * s * dt));
        if (yaw) this.orientation.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), yaw * s * dt));
        if (roll) this.orientation.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), roll * s * dt));
        this.orientation.normalize();
        if (this.sasEnabled && !pitch && !yaw && !roll) this.orientation.slerp(new THREE.Quaternion().identity(), dt * 0.5);
    }

    getStageInfo() {
        return this.stages.map((s, i) => ({
            num: i, active: i === this.currentStage, spent: i < this.currentStage,
            engines: s.engines.length, decoupler: !!s.decoupler,
        }));
    }

    getExhaustPosition() {
        // Find the bottom engine part and return its world position offset
        let bottomY = 0;
        for (const p of this.parts) {
            if (p.isEngine) break;
            bottomY += p.height;
        }
        // Actually find the lowest part
        bottomY = 0;
        for (let i = 0; i < this.parts.length; i++) {
            if (this.parts[i].isEngine) { break; }
            bottomY += this.parts[i].height;
        }
        return new THREE.Vector3(0, bottomY - 0.5, 0);
    }
}

export class RocketBuilder {
    static buildDefault() {
        return Rocket.createFromParts(['LargeEngine','LargeTank','Decoupler','LargeTank','SmallEngine','SmallTank','CommandPod']);
    }
    static computeStats(types) {
        let m = 0, f = 0, t = 0;
        for (const tp of types) { const d = PART_DEFS[tp]; m += d.dryMass + d.fuelCapacity; f += d.fuelCapacity; t += d.thrust; }
        return { totalMass: m, totalFuel: f, totalThrust: t, twr: m > 0 ? t / (m * CONFIG.SURFACE_GRAVITY) : 0 };
    }
}
