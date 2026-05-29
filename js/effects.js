import * as THREE from 'three';

export class EffectsEngine {
    constructor(scene) {
        this.scene = scene;
        this.audioCtx = null;
        this.engineGain = null;
        this.engineOsc = null;
        this.engineNoise = null;
        this.particles = [];
        this.flameGroup = new THREE.Group();
        this.scene.add(this.flameGroup);
        this.smokeGroup = new THREE.Group();
        this.scene.add(this.smokeGroup);
        this._initFlamePool();
    }

    _initFlamePool() {
        const count = 80;
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 4);
        const sizes = new Float32Array(count);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
        geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
        const mat = new THREE.PointsMaterial({
            size: 1, vertexColors: true, transparent: true, opacity: 0.8,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
        });
        this.flamePoints = new THREE.Points(geo, mat);
        this.flameGroup.add(this.flamePoints);
        this.flameData = Array.from({ length: count }, () => ({ life: 0, vx: 0, vy: 0, vz: 0 }));
        this.flameIndex = 0;

        const sCount = 40;
        const sPos = new Float32Array(sCount * 3);
        const sCol = new Float32Array(sCount * 4);
        const sSize = new Float32Array(sCount);
        const sGeo = new THREE.BufferGeometry();
        sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
        sGeo.setAttribute('color', new THREE.BufferAttribute(sCol, 4));
        sGeo.setAttribute('size', new THREE.BufferAttribute(sSize, 1));
        const sMat = new THREE.PointsMaterial({
            size: 2, vertexColors: true, transparent: true, opacity: 0.3,
            depthWrite: false, sizeAttenuation: true,
        });
        this.smokePoints = new THREE.Points(sGeo, sMat);
        this.smokeGroup.add(this.smokePoints);
        this.smokeData = Array.from({ length: sCount }, () => ({ life: 0, vx: 0, vy: 0, vz: 0 }));
        this.smokeIndex = 0;
    }

    emitFlame(position, direction, throttle, scale) {
        if (throttle <= 0) return;
        const posAttr = this.flamePoints.geometry.attributes.position;
        const colAttr = this.flamePoints.geometry.attributes.color;
        const sizeAttr = this.flamePoints.geometry.attributes.size;

        for (let i = 0; i < Math.ceil(throttle * 3); i++) {
            const idx = this.flameIndex % this.flameData.length;
            this.flameIndex++;
            const d = this.flameData[idx];
            d.life = 1.0;
            const spread = 0.3 * scale;
            d.vx = -direction.x * (2 + Math.random() * 3) * scale + (Math.random() - 0.5) * spread;
            d.vy = -direction.y * (2 + Math.random() * 3) * scale + (Math.random() - 0.5) * spread;
            d.vz = -direction.z * (2 + Math.random() * 3) * scale + (Math.random() - 0.5) * spread;

            posAttr.array[idx * 3] = position.x + (Math.random() - 0.5) * 0.2 * scale;
            posAttr.array[idx * 3 + 1] = position.y + (Math.random() - 0.5) * 0.2 * scale;
            posAttr.array[idx * 3 + 2] = position.z + (Math.random() - 0.5) * 0.2 * scale;

            const heat = Math.random();
            colAttr.array[idx * 4] = 1.0;
            colAttr.array[idx * 4 + 1] = 0.3 + heat * 0.5;
            colAttr.array[idx * 4 + 2] = heat * 0.3;
            colAttr.array[idx * 4 + 3] = 1.0;

            sizeAttr.array[idx] = (0.3 + throttle * 0.5) * scale;
        }
    }

    emitSmoke(position, throttle, scale) {
        if (throttle <= 0.1 || Math.random() > 0.3) return;
        const posAttr = this.smokePoints.geometry.attributes.position;
        const colAttr = this.smokePoints.geometry.attributes.color;
        const idx = this.smokeIndex % this.smokeData.length;
        this.smokeIndex++;
        const d = this.smokeData[idx];
        d.life = 1.0;
        d.vx = (Math.random() - 0.5) * 0.5 * scale;
        d.vy = -0.5 * scale;
        d.vz = (Math.random() - 0.5) * 0.5 * scale;

        posAttr.array[idx * 3] = position.x + (Math.random() - 0.5) * 0.3 * scale;
        posAttr.array[idx * 3 + 1] = position.y - 0.5 * scale;
        posAttr.array[idx * 3 + 2] = position.z + (Math.random() - 0.5) * 0.3 * scale;

        colAttr.array[idx * 4] = 0.7; colAttr.array[idx * 4 + 1] = 0.7; colAttr.array[idx * 4 + 2] = 0.7; colAttr.array[idx * 4 + 3] = 0.4;
    }

    update(dt) {
        this._updateFlame(dt);
        this._updateSmoke(dt);
    }

    _updateFlame(dt) {
        const posAttr = this.flamePoints.geometry.attributes.position;
        const colAttr = this.flamePoints.geometry.attributes.color;
        for (let i = 0; i < this.flameData.length; i++) {
            const d = this.flameData[i];
            if (d.life <= 0) { posAttr.array[i * 3 + 1] = -9999; continue; }
            d.life -= dt * 3.0;
            posAttr.array[i * 3] += d.vx * dt;
            posAttr.array[i * 3 + 1] += d.vy * dt;
            posAttr.array[i * 3 + 2] += d.vz * dt;
            colAttr.array[i * 4 + 3] = d.life;
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
    }

    _updateSmoke(dt) {
        const posAttr = this.smokePoints.geometry.attributes.position;
        const colAttr = this.smokePoints.geometry.attributes.color;
        for (let i = 0; i < this.smokeData.length; i++) {
            const d = this.smokeData[i];
            if (d.life <= 0) { posAttr.array[i * 3 + 1] = -9999; continue; }
            d.life -= dt * 3.0;
            posAttr.array[i * 3] += d.vx * dt;
            posAttr.array[i * 3 + 1] += d.vy * dt;
            posAttr.array[i * 3 + 2] += d.vz * dt;
            colAttr.array[i * 4 + 3] = d.life * 0.3;
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
    }

    // Audio
    initAudio() {
        try {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            // Engine sound
            this.engineOsc = this.audioCtx.createOscillator();
            this.engineOsc.type = 'sawtooth';
            this.engineOsc.frequency.value = 60;
            const noise = this.audioCtx.createBufferSource();
            const buf = this.audioCtx.createBuffer(1, this.audioCtx.sampleRate * 2, this.audioCtx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
            noise.buffer = buf;
            noise.loop = true;
            this.engineNoise = noise;
            this.engineGain = this.audioCtx.createGain();
            this.engineGain.gain.value = 0;
            const filter = this.audioCtx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 200;
            this.engineOsc.connect(this.engineGain);
            noise.connect(filter);
            filter.connect(this.engineGain);
            this.engineGain.connect(this.audioCtx.destination);
            this.engineOsc.start();
            noise.start();
        } catch (e) {}
    }

    updateEngineSound(throttle) {
        if (!this.engineGain) return;
        const t = this.audioCtx.currentTime;
        this.engineGain.gain.linearRampToValueAtTime(throttle * 0.15, t + 0.05);
        if (this.engineOsc) this.engineOsc.frequency.linearRampToValueAtTime(60 + throttle * 80, t + 0.05);
    }

    playStagingSound() {
        if (!this.audioCtx) return;
        try {
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            osc.type = 'square';
            osc.frequency.value = 200;
            gain.gain.setValueAtTime(0.2, this.audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.15);
            osc.connect(gain);
            gain.connect(this.audioCtx.destination);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.15);
        } catch (e) {}
    }
}
