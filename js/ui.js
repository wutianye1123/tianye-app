import * as THREE from 'three';
import { CONFIG, PART_DEFS } from './config.js';

export class UI {
    constructor() {
        this.vabPanel = document.getElementById('vab-panel');
        this.flightHud = document.getElementById('flight-hud');
        this.mapHud = document.getElementById('map-hud');
        this.loadingScreen = document.getElementById('loading-screen');
        this.navballCanvas = document.getElementById('navball');
        this.navCtx = this.navballCanvas.getContext('2d');
        this.assemblyParts = [];
        this.selectedInsertIndex = -1;
        this._setupVAB();
        this._setupButtons();
    }

    _setupVAB() {
        document.querySelectorAll('.part-item').forEach(item => {
            item.addEventListener('click', () => this.addPart(item.dataset.part));
        });
        document.getElementById('btn-launch').addEventListener('click', () => this.onLaunch?.());
        document.getElementById('btn-clear').addEventListener('click', () => this.clearAssembly());
        document.getElementById('btn-template').addEventListener('click', () => this.loadTemplate());
    }

    _setupButtons() {
        document.getElementById('btn-map')?.addEventListener('click', () => this.onToggleMap?.());
        document.getElementById('btn-flight')?.addEventListener('click', () => this.onToggleMap?.());
        document.getElementById('btn-sas')?.addEventListener('click', () => this.onToggleSAS?.());
        document.getElementById('btn-back-vab')?.addEventListener('click', () => this.onBackToVAB?.());
        document.getElementById('btn-help')?.addEventListener('click', () => document.getElementById('controls-help')?.classList.toggle('hidden'));
        document.getElementById('btn-warp-up')?.addEventListener('click', () => this.onTimeWarp?.(1));
        document.getElementById('btn-warp-down')?.addEventListener('click', () => this.onTimeWarp?.(-1));
        document.getElementById('btn-ap-orbit')?.addEventListener('click', () => this.onAutopilot?.('orbit'));
        document.getElementById('btn-ap-mun')?.addEventListener('click', () => this.onAutopilot?.('mun'));
        document.getElementById('btn-ap-land')?.addEventListener('click', () => this.onAutopilot?.('land'));
        document.getElementById('btn-ap-off')?.addEventListener('click', () => this.onAutopilot?.('off'));
    }

    hideLoading() { this.loadingScreen?.classList.add('fade-out'); }
    showVAB() { this.vabPanel?.classList.remove('hidden'); this.flightHud?.classList.add('hidden'); this.mapHud?.classList.add('hidden'); }
    showFlight() { this.vabPanel?.classList.add('hidden'); this.flightHud?.classList.remove('hidden'); this.mapHud?.classList.add('hidden'); }
    showMap() { this.vabPanel?.classList.add('hidden'); this.flightHud?.classList.add('hidden'); this.mapHud?.classList.remove('hidden'); }

    addPart(type) {
        if (this.selectedInsertIndex >= 0 && this.selectedInsertIndex < this.assemblyParts.length) {
            this.assemblyParts.splice(this.selectedInsertIndex, 0, type);
        } else {
            this.assemblyParts.push(type);
        }
        this.selectedInsertIndex = -1;
        this._renderAssembly();
    }
    removePart(i) { this.assemblyParts.splice(i, 1); this.selectedInsertIndex = -1; this._renderAssembly(); }
    movePart(i, dir) {
        const j = i + dir;
        if (j < 0 || j >= this.assemblyParts.length) return;
        [this.assemblyParts[i], this.assemblyParts[j]] = [this.assemblyParts[j], this.assemblyParts[i]];
        this._renderAssembly();
    }
    selectInsert(i) { this.selectedInsertIndex = i; this._renderAssembly(); }
    clearAssembly() { this.assemblyParts = []; this.selectedInsertIndex = -1; this._renderAssembly(); }
    getAssemblyParts() { return [...this.assemblyParts]; }

    loadTemplate() {
        this.assemblyParts = ['LargeEngine','LargeTank','Decoupler','LargeTank','SmallEngine','SmallTank','CommandPod'];
        this._renderAssembly();
    }

    _renderAssembly() {
        const list = document.getElementById('assembly-list');
        if (!list) return;
        list.innerHTML = '';

        // Insert point at top (above first part)
        const insertTop = document.createElement('div');
        insertTop.className = 'insert-point' + (this.selectedInsertIndex === this.assemblyParts.length ? ' selected' : '');
        insertTop.textContent = '+ 点击此处插入';
        insertTop.addEventListener('click', () => this.selectInsert(this.assemblyParts.length));
        list.appendChild(insertTop);

        for (let i = this.assemblyParts.length - 1; i >= 0; i--) {
            const type = this.assemblyParts[i], def = PART_DEFS[type];
            // Part with controls
            const wrapper = document.createElement('div');
            wrapper.className = 'assembly-wrapper';

            const el = document.createElement('div');
            el.className = `assembly-part part-${type}`;
            el.textContent = def.name;
            wrapper.appendChild(el);

            // Move buttons
            const controls = document.createElement('div');
            controls.className = 'part-controls';
            const btnUp = document.createElement('button');
            btnUp.className = 'btn-part';
            btnUp.textContent = '\u25B2';
            btnUp.title = '上移';
            btnUp.addEventListener('click', (e) => { e.stopPropagation(); this.movePart(i, 1); });
            const btnDown = document.createElement('button');
            btnDown.className = 'btn-part';
            btnDown.textContent = '\u25BC';
            btnDown.title = '下移';
            btnDown.addEventListener('click', (e) => { e.stopPropagation(); this.movePart(i, -1); });
            const btnDel = document.createElement('button');
            btnDel.className = 'btn-part btn-del';
            btnDel.textContent = '\u2716';
            btnDel.title = '删除';
            btnDel.addEventListener('click', (e) => { e.stopPropagation(); this.removePart(i); });
            controls.appendChild(btnUp);
            controls.appendChild(btnDown);
            controls.appendChild(btnDel);
            wrapper.appendChild(controls);
            list.appendChild(wrapper);

            // Insert point below this part
            const insertBelow = document.createElement('div');
            insertBelow.className = 'insert-point' + (this.selectedInsertIndex === i ? ' selected' : '');
            insertBelow.textContent = '+ 插入';
            insertBelow.addEventListener('click', () => this.selectInsert(i));
            list.appendChild(insertBelow);
        }

        const { totalMass, twr } = this._stats();
        document.getElementById('total-mass').textContent = totalMass.toFixed(1);
        document.getElementById('twr').textContent = twr;
        document.getElementById('btn-launch').disabled = !(this.assemblyParts.includes('CommandPod') || this.assemblyParts.includes('CommandPodSmall')) || !this.assemblyParts.some(t => PART_DEFS[t].thrust > 0);
    }

    _stats() {
        let m = 0, t = 0;
        for (const tp of this.assemblyParts) { const d = PART_DEFS[tp]; m += d.dryMass + d.fuelCapacity; t += d.thrust; }
        return { totalMass: m, twr: m > 0 ? (t / (m * CONFIG.SURFACE_GRAVITY)).toFixed(2) : '0' };
    }

    updateHUD(d) {
        const s = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        s('hud-altitude', this._alt(d.altitude));
        s('hud-speed', this._spd(d.speed));
        s('hud-orbital-speed', this._spd(d.orbitalSpeed));
        s('hud-apoapsis', this._alt(d.apoapsis));
        s('hud-periapsis', this._alt(d.periapsis));
        s('hud-gforce', d.gForce.toFixed(1) + ' G');
        const tp = Math.round(d.throttle * 100);
        const tf = document.getElementById('throttle-fill');
        if (tf) tf.style.height = tp + '%';
        const tl = document.getElementById('throttle-label');
        if (tl) tl.textContent = tp + '%';
        const fp = Math.round(d.fuelFraction * 100);
        const ff = document.getElementById('fuel-fill');
        if (ff) ff.style.width = fp + '%';
        s('fuel-percent', fp + '%');
        const we = document.getElementById('warp-indicator');
        if (we) we.textContent = d.timeWarp > 1 ? d.timeWarp + 'x' : '1x';
    }

    updateMapHUD(d) {
        const s = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        s('map-apoapsis', this._alt(d.apoapsis));
        s('map-periapsis', this._alt(d.periapsis));
        s('map-speed', this._spd(d.orbitalSpeed));
        s('map-period', d.period > 0 && d.period < Infinity ? (d.period / 60).toFixed(1) + ' min' : '逃逸轨道');
        s('map-eccentricity', d.eccentricity.toFixed(4));
    }

    updateStaging(info) {
        const list = document.getElementById('stage-list');
        if (!list) return;
        list.innerHTML = '';
        for (const s of info) {
            const el = document.createElement('div');
            el.className = 'stage-item' + (s.active ? ' active' : '') + (s.spent ? ' spent' : '');
            el.innerHTML = `<span class="stage-icon">${s.engines > 0 ? '\uD83D\uDD25' : '\u2500'}</span><span>S${s.num + 1}${s.decoupler ? ' |' : ''} ${s.engines}x</span>`;
            list.appendChild(el);
        }
    }

    updateNavball(orientation) {
        const ctx = this.navCtx, w = 200, h = 200, cx = w / 2, cy = h / 2, r = 90;
        ctx.clearRect(0, 0, w, h);
        const euler = new THREE.Euler().setFromQuaternion(orientation, 'YXZ');
        const pitch = euler.x, roll = euler.z;
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = '#1565c0'; ctx.fillRect(0, 0, w, h);
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(-roll);
        ctx.fillStyle = '#5d4037';
        const py = (pitch / Math.PI) * r * 2;
        ctx.fillRect(-w, py, w * 2, h * 2);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-r, py); ctx.lineTo(r, py); ctx.stroke();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        for (let deg = -90; deg <= 90; deg += 15) {
            if (deg === 0) continue;
            const y = py + (deg / 90) * r, lw = deg % 30 === 0 ? 30 : 15;
            ctx.beginPath(); ctx.moveTo(-lw, y); ctx.lineTo(lw, y); ctx.stroke();
        }
        ctx.restore();
        // Prograde marker
        ctx.fillStyle = '#4caf50';
        ctx.beginPath(); ctx.moveTo(cx, cy - 10); ctx.lineTo(cx - 6, cy - 20); ctx.lineTo(cx + 6, cy - 20); ctx.closePath(); ctx.fill();
        // Crosshair
        ctx.strokeStyle = '#ffeb3b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - 15, cy); ctx.lineTo(cx - 5, cy); ctx.moveTo(cx + 5, cy); ctx.lineTo(cx + 15, cy);
        ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5); ctx.stroke();
        ctx.restore();
    }

    _alt(m) {
        if (m === Infinity || m > 1e9) return '逃逸';
        if (m < 0) return Math.round(m) + ' m';
        if (m < 10000) return m.toFixed(1) + ' m';
        return (m / 1000).toFixed(2) + ' km';
    }
    _spd(m) { if (Math.abs(m) < 1000) return m.toFixed(1) + ' m/s'; return (m / 1000).toFixed(2) + ' km/s'; }
}
