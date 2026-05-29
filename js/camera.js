import * as THREE from 'three';
import { CONFIG } from './config.js';

export class CameraController {
    constructor(camera) {
        this.camera = camera;
        this.mode = 'flight';
        this.flightDistance = 50;
        this.flightAngleX = 0;
        this.flightAngleY = 0.3;
        this.flightSmooth = new THREE.Vector3();
        this.flightLookSmooth = new THREE.Vector3();
        this.mapDistance = 5;
        this.mapAngleX = 0;
        this.mapAngleY = 0.5;
        this.isDragging = false;
        this.lastMouse = { x: 0, y: 0 };
        this._setupInput();
    }

    _setupInput() {
        const c = document.getElementById('game-canvas');
        c.addEventListener('mousedown', e => { this.isDragging = true; this.lastMouse = { x: e.clientX, y: e.clientY }; });
        c.addEventListener('mousemove', e => {
            if (!this.isDragging) return;
            const dx = e.clientX - this.lastMouse.x, dy = e.clientY - this.lastMouse.y;
            this.lastMouse = { x: e.clientX, y: e.clientY };
            if (this.mode === 'flight') {
                this.flightAngleX -= dx * 0.005;
                this.flightAngleY = Math.max(-0.5, Math.min(1.2, this.flightAngleY + dy * 0.005));
            } else {
                this.mapAngleX -= dx * 0.005;
                this.mapAngleY = Math.max(-1.2, Math.min(1.2, this.mapAngleY + dy * 0.005));
            }
        });
        c.addEventListener('mouseup', () => this.isDragging = false);
        c.addEventListener('mouseleave', () => this.isDragging = false);
        c.addEventListener('wheel', e => {
            e.preventDefault();
            if (this.mode === 'flight') this.flightDistance = Math.max(5, Math.min(100, this.flightDistance + e.deltaY * 0.02));
            else this.mapDistance = Math.max(2, Math.min(30, this.mapDistance + e.deltaY * 0.005));
        }, { passive: false });
    }

    setMode(m) { this.mode = m; }

    updateFlight(pos, orientation, scale) {
        const target = new THREE.Vector3(pos.x * scale, pos.y * scale, pos.z * scale);
        const offset = new THREE.Vector3(0, 2, -this.flightDistance);
        offset.applyAxisAngle(new THREE.Vector3(1, 0, 0), -this.flightAngleY);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.flightAngleX);
        this.flightSmooth.lerp(target.clone().add(offset), 0.3);
        this.flightLookSmooth.lerp(target, 0.4);
        this.camera.position.copy(this.flightSmooth);
        this.camera.lookAt(this.flightLookSmooth);
    }

    updateMap() {
        const offset = new THREE.Vector3(0, 0, this.mapDistance);
        offset.applyAxisAngle(new THREE.Vector3(1, 0, 0), -this.mapAngleY);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.mapAngleX);
        this.camera.position.copy(offset);
        this.camera.lookAt(0, 0, 0);
    }

    resetFlight(pos, orientation, scale) {
        const t = new THREE.Vector3(pos.x * scale, pos.y * scale, pos.z * scale);
        const o = new THREE.Vector3(0, 2, -this.flightDistance);
        this.flightSmooth.copy(t.clone().add(o));
        this.flightLookSmooth.copy(t);
    }
}
