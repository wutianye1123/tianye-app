import * as THREE from 'three';
import { CONFIG } from './config.js';

export class CelestialBody {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);
        this.munGroup = new THREE.Group();
        this.scene.add(this.munGroup);
        this.planet = null;
        this.clouds = null;
        this.atmosphere = null;
        this.mun = null;
        this.sun = null;
        this.stars = null;
        this._buildPlanet();
        this._buildClouds();
        this._buildAtmosphere();
        this._buildMun();
        this._buildSun();
        this._buildStars();
    }

    _buildPlanet() {
        const geo = new THREE.SphereGeometry(1, 64, 64);
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uOcean: { value: new THREE.Color(CONFIG.PLANET_COLOR_OCEAN) },
                uLand: { value: new THREE.Color(CONFIG.PLANET_COLOR_LAND) },
                uBeach: { value: new THREE.Color(0xc2b280) },
                uIce: { value: new THREE.Color(0xe8e8f0) },
                uLightDir: { value: new THREE.Vector3(1, 0.5, 0.5).normalize() },
            },
            vertexShader: `
                varying vec3 vNormal; varying vec3 vWorldPos;
                void main() {
                    vNormal = normalize(normalMatrix * normal);
                    vWorldPos = normalize(position);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform vec3 uOcean, uLand, uBeach, uIce, uLightDir;
                varying vec3 vNormal, vWorldPos;
                float hash3(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
                float noise3d(vec3 p){
                    vec3 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
                    float a=hash3(i),b=hash3(i+vec3(1,0,0)),c=hash3(i+vec3(0,1,0)),d=hash3(i+vec3(1,1,0));
                    float e=hash3(i+vec3(0,0,1)),g=hash3(i+vec3(1,0,1)),h=hash3(i+vec3(0,1,1)),k=hash3(i+vec3(1,1,1));
                    return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y),mix(mix(e,g,f.x),mix(h,k,f.x),f.y),f.z);
                }
                float fbm(vec3 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise3d(p);p*=2.0;a*=0.5;}return v;}
                void main(){
                    vec3 p=vWorldPos*4.0; float n=fbm(p),n2=fbm(p*2.0+vec3(5,3,7));
                    float land=smoothstep(0.42,0.48,n);
                    vec3 col=mix(uOcean*(0.8+0.2*n2),uLand*(0.7+0.3*n2),land);
                    col=mix(col,uBeach,smoothstep(0.47,0.50,n)*(1.0-smoothstep(0.50,0.55,n))*0.6);
                    col=mix(col,uIce,smoothstep(0.75,0.9,abs(vWorldPos.y)));
                    col*=0.2+0.8*max(dot(vNormal,uLightDir),0.0);
                    col+=vec3(0.3,0.5,0.8)*pow(1.0-max(dot(vNormal,vec3(0,0,1)),0.0),3.0)*0.3;
                    gl_FragColor=vec4(col,1.0);
                }`,
        });
        this.planet = new THREE.Mesh(geo, mat);
        this.group.add(this.planet);
    }

    _buildClouds() {
        const geo = new THREE.SphereGeometry(1.005, 32, 32);
        const mat = new THREE.ShaderMaterial({
            uniforms: { uTime: { value: 0 } },
            vertexShader: `varying vec3 vPos;void main(){vPos=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `
                uniform float uTime; varying vec3 vPos;
                float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
                float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
                float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<3;i++){v+=a*n(p);p*=2.0;a*=0.5;}return v;}
                void main(){
                    vec2 uv=vec2(atan(vPos.z,vPos.x)*3.0,asin(vPos.y)*3.0)+uTime*0.01;
                    float c=fbm(uv*2.0);
                    float alpha=smoothstep(0.45,0.65,c)*0.4;
                    gl_FragColor=vec4(1.0,1.0,1.0,alpha);
                }`,
            transparent: true, depthWrite: false,
        });
        this.clouds = new THREE.Mesh(geo, mat);
        this.group.add(this.clouds);
    }

    _buildAtmosphere() {
        const geo = new THREE.SphereGeometry(1.18, 32, 32);
        const mat = new THREE.ShaderMaterial({
            uniforms: { uColor: { value: new THREE.Color(CONFIG.ATMOSPHERE_COLOR) } },
            vertexShader: `varying vec3 vN,vV;void main(){vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
            fragmentShader: `uniform vec3 uColor;varying vec3 vN,vV;void main(){float rim=1.0-max(dot(vN,vV),0.0);gl_FragColor=vec4(uColor,pow(rim,3.0)*0.5);}`,
            transparent: true, side: THREE.BackSide, depthWrite: false,
        });
        this.atmosphere = new THREE.Mesh(geo, mat);
        this.group.add(this.atmosphere);
    }

    _buildMun() {
        const munScale = CONFIG.MUN_RADIUS / CONFIG.PLANET_RADIUS;
        const geo = new THREE.SphereGeometry(munScale, 32, 32);
        const mat = new THREE.ShaderMaterial({
            uniforms: { uLightDir: { value: new THREE.Vector3(1, 0.5, 0.5).normalize() } },
            vertexShader: `varying vec3 vN,vP;void main(){vN=normalize(normalMatrix*normal);vP=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `
                uniform vec3 uLightDir; varying vec3 vN,vP;
                float h3(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
                float n3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
                mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z);}
                float fbm(vec3 p){float v=0.0,a=0.5;for(int i=0;i<3;i++){v+=a*n3(p);p*=2.0;a*=0.5;}return v;}
                void main(){
                    float n=fbm(vP*8.0);
                    vec3 col=vec3(0.55+n*0.15);
                    float crater=smoothstep(0.35,0.38,n)*(1.0-smoothstep(0.38,0.41,n));
                    col=mix(col,vec3(0.35),crater*0.7);
                    col*=0.15+0.85*max(dot(vN,uLightDir),0.0);
                    gl_FragColor=vec4(col,1.0);
                }`,
        });
        this.mun = new THREE.Mesh(geo, mat);
        this.munGroup.add(this.mun);
    }

    _buildSun() {
        const geo = new THREE.SphereGeometry(0.3, 16, 16);
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffaa });
        this.sun = new THREE.Mesh(geo, mat);
        this.sun.position.set(5000, 2500, 5000);
        this.scene.add(this.sun);
        const light = new THREE.DirectionalLight(0xffffff, 1.5);
        light.position.set(1, 0.5, 0.5).normalize();
        this.scene.add(light);
        this.scene.add(new THREE.AmbientLight(0x222244, 0.3));
    }

    _buildStars() {
        const count = CONFIG.STAR_COUNT;
        const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            const t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1), r = 50000;
            pos[i*3]=r*Math.sin(p)*Math.cos(t); pos[i*3+1]=r*Math.sin(p)*Math.sin(t); pos[i*3+2]=r*Math.cos(p);
            const b = 0.5 + Math.random() * 0.5;
            col[i*3]=b*(Math.random()>0.8?1.0:0.9); col[i*3+1]=b*(Math.random()>0.5?1.0:0.85); col[i*3+2]=b;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        this.stars = new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.5, vertexColors: true, sizeAttenuation: false }));
        this.scene.add(this.stars);
    }

    updateMun(munAngle, planetScale, mapMode) {
        if (!this.mun) return;
        const munOrbitRender = mapMode ? CONFIG.MUN_ORBIT_RADIUS / CONFIG.PLANET_RADIUS : CONFIG.MUN_ORBIT_RADIUS * CONFIG.RENDER_SCALE_FLIGHT;
        const a = munAngle;
        if (mapMode) {
            this.munGroup.scale.setScalar(1);
            this.munGroup.position.set(munOrbitRender * Math.cos(a), 0, munOrbitRender * Math.sin(a));
        } else {
            this.munGroup.scale.setScalar(planetScale);
            this.munGroup.position.set(munOrbitRender * Math.cos(a), 0, munOrbitRender * Math.sin(a));
        }
    }

    updateClouds(dt) {
        if (this.clouds && this.clouds.material.uniforms) {
            this.clouds.material.uniforms.uTime.value += dt;
        }
    }

    setScale(scale) {
        this.group.scale.setScalar(scale);
    }
}
