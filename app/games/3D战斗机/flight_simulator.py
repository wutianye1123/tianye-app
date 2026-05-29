  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>3D飞行模拟器 - 网页版</title>
      <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { overflow: hidden; font-family: Arial, sans-serif; background: #000; }
          #hud {
              position: absolute;
              top: 20px;
              left: 20px;
              color: #0f0;
              font-size: 18px;
              text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
              pointer-events: none;
          }
          #hud div { margin: 8px 0; }
          #controls {
              position: absolute;
              bottom: 20px;
              left: 20px;
              color: #0f0;
              font-size: 14px;
              text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
              pointer-events: none;
          }
          #controls div { margin: 5px 0; }
          #crosshair {
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              pointer-events: none;
          }
          #crosshair::before, #crosshair::after {
              content: '';
              position: absolute;
              background: rgba(255,255,255,0.8);
          }
          #crosshair::before {
              width: 40px; height: 2px;
              top: 50%; left: 50%;
              transform: translate(-50%, -50%);
          }
          #crosshair::after {
              width: 2px; height: 40px;
              top: 50%; left: 50%;
              transform: translate(-50%, -50%);
          }
          #startScreen {
              position: absolute;
              top: 0; left: 0;
              width: 100%; height: 100%;
              background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              color: white;
              z-index: 1000;
          }
          #startScreen h1 { font-size: 48px; margin-bottom: 20px; }
          #startScreen p { font-size: 18px; margin: 10px 0; }
          #startBtn {
              margin-top: 30px;
              padding: 15px 40px;
              font-size: 20px;
              background: #4CAF50;
              color: white;
              border: none;
              border-radius: 8px;
              cursor: pointer;
          }
          #startBtn:hover { background: #45a049; }
          .hidden { display: none !important; }
      </style>
  </head>
  <body>
      <div id="startScreen">
          <h1>🛩️ 3D飞行模拟器</h1>
          <p>真正的3D WebGL飞行体验</p>
          <br>
          <p><strong>控制说明：</strong></p>
          <p>W / S - 上升 / 下降</p>
          <p>A / D - 向左 / 向右</p>
          <p>↑ / ↓ - 加速 / 减速</p>
          <p>鼠标移动 - 控制转向</p>
          <p>ESC - 暂停/释放鼠标</p>
          <button id="startBtn">开始飞行</button>
      </div>

      <div id="hud" class="hidden">
          <div id="speed">速度: 0 km/h</div>
          <div id="altitude">高度: 0 m</div>
          <div id="position">位置: X: 0, Z: 0</div>
      </div>

      <div id="controls" class="hidden">
          <div><strong>控制:</strong></div>
          <div>W/S - 上升/下降</div>
          <div>A/D - 左/右</div>
          <div>↑/↓ - 加速/减速</div>
          <div>鼠标 - 转向</div>
          <div>ESC - 暂停</div>
      </div>

      <div id="crosshair" class="hidden"></div>

      <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
      <script>
          let scene, camera, renderer, aircraft;
          let mountains = [], clouds = [];
          let isRunning = false, isPaused = false;

          const aircraftState = {
              x: 0, y: 500, z: 0, speed: 10,
              velocityX: 0, velocityY: 0,
              roll: 0, pitch: 0, yaw: 0
          };

          const keys = { w: false, s: false, a: false, d: false, arrowup: false, arrowdown: false };

          function init() {
              scene = new THREE.Scene();
              scene.background = new THREE.Color(0x87CEEB);
              scene.fog = new THREE.Fog(0x87CEEB, 1000, 5000);

              camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
              camera.position.set(0, 500, 0);

              renderer = new THREE.WebGLRenderer({ antialias: true });
              renderer.setSize(window.innerWidth, window.innerHeight);
              renderer.shadowMap.enabled = true;
              document.body.appendChild(renderer.domElement);

              scene.add(new THREE.AmbientLight(0xffffff, 0.6));

              const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
              dirLight.position.set(500, 1000, 500);
              dirLight.castShadow = true;
              scene.add(dirLight);

              createTerrain();
              createMountains();
              createClouds();
              createAircraft();
              setupEventListeners();
              animate();
          }

          function createTerrain() {
              const ground = new THREE.Mesh(
                  new THREE.PlaneGeometry(10000, 10000),
                  new THREE.MeshLambertMaterial({ color: 0x228B22 })
              );
              ground.rotation.x = -Math.PI / 2;
              ground.receiveShadow = true;
              scene.add(ground);
          }

          function createMountains() {
              for (let i = 0; i < 50; i++) {
                  const height = Math.random() * 400 + 200;
                  const width = Math.random() * 200 + 100;
                  const mountain = new THREE.Mesh(
                      new THREE.ConeGeometry(width, height, 4),
                      new THREE.MeshLambertMaterial({ color: 0x8B4513 })
                  );
                  mountain.position.set(
                      Math.random() * 10000 - 5000,
                      height / 2,
                      Math.random() * 10000 - 5000
                  );
                  mountain.rotation.y = Math.random() * Math.PI * 2;
                  mountain.castShadow = true;
                  scene.add(mountain);
                  mountains.push(mountain);
              }
          }

          function createClouds() {
              const cloudMat = new THREE.MeshLambertMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.9 });
              for (let i = 0; i < 40; i++) {
                  const cloudGroup = new THREE.Group();
                  for (let j = 0; j < Math.floor(Math.random() * 4) + 3; j++) {
                      const sphere = new THREE.Mesh(
                          new THREE.SphereGeometry(Math.random() * 40 + 30, 8, 8),
                          cloudMat
                      );
                      sphere.position.set(
                          Math.random() * 80 - 40,
                          Math.random() * 30 - 15,
                          Math.random() * 80 - 40
                      );
                      cloudGroup.add(sphere);
                  }
                  cloudGroup.position.set(
                      Math.random() * 10000 - 5000,
                      Math.random() * 400 + 600,
                      Math.random() * 10000 - 5000
                  );
                  scene.add(cloudGroup);
                  clouds.push(cloudGroup);
              }
          }

          function createAircraft() {
              aircraft = new THREE.Group();

              const body = new THREE.Mesh(
                  new THREE.CylinderGeometry(5, 5, 50, 8),
                  new THREE.MeshLambertMaterial({ color: 0xCCCCCC })
              );
              body.rotation.x = Math.PI / 2;
              body.castShadow = true;
              aircraft.add(body);

              const nose = new THREE.Mesh(
                  new THREE.ConeGeometry(5, 15, 8),
                  new THREE.MeshLambertMaterial({ color: 0x999999 })
              );
              nose.rotation.x = -Math.PI / 2;
              nose.position.z = -32;
              aircraft.add(nose);

              const wing = new THREE.Mesh(
                  new THREE.BoxGeometry(80, 2, 15),
                  new THREE.MeshLambertMaterial({ color: 0xB22222 })
              );
              wing.castShadow = true;
              aircraft.add(wing);

              const tail = new THREE.Mesh(
                  new THREE.BoxGeometry(5, 25, 10),
                  new THREE.MeshLambertMaterial({ color: 0x3333AA })
              );
              tail.position.y = 10;
              tail.position.z = 20;
              aircraft.add(tail);

              const hTail = new THREE.Mesh(new THREE.BoxGeometry(25, 2, 10), wing.material);
              hTail.position.z = 20;
              aircraft.add(hTail);

              aircraft.position.set(0, 500, 0);
              scene.add(aircraft);
          }

          function setupEventListeners() {
              document.addEventListener('keydown', (e) => {
                  if (e.key.toLowerCase() in keys) keys[e.key.toLowerCase()] = true;
                  if (e.key === 'ArrowUp') keys.arrowup = true;
                  if (e.key === 'ArrowDown') keys.arrowdown = true;
                  if (e.key === 'Escape') togglePause();
              });
              document.addEventListener('keyup', (e) => {
                  if (e.key.toLowerCase() in keys) keys[e.key.toLowerCase()] = false;
                  if (e.key === 'ArrowUp') keys.arrowup = false;
                  if (e.key === 'ArrowDown') keys.arrowdown = false;
              });
              document.addEventListener('mousemove', (e) => {
                  if (document.pointerLockElement === renderer.domElement) {
                      aircraftState.yaw -= e.movementX * 0.002;
                      aircraftState.pitch -= e.movementY * 0.002;
                      aircraftState.pitch = Math.max(-0.5, Math.min(0.5, aircraftState.pitch));
                  }
              });
              renderer.domElement.addEventListener('click', () => {
                  if (isRunning && !isPaused) renderer.domElement.requestPointerLock();
              });
              window.addEventListener('resize', () => {
                  camera.aspect = window.innerWidth / window.innerHeight;
                  camera.updateProjectionMatrix();
                  renderer.setSize(window.innerWidth, window.innerHeight);
              });
              document.getElementById('startBtn').addEventListener('click', startGame);
          }

          function startGame() {
              document.getElementById('startScreen').classList.add('hidden');
              document.getElementById('hud').classList.remove('hidden');
              document.getElementById('controls').classList.remove('hidden');
              document.getElementById('crosshair').classList.remove('hidden');
              isRunning = true;
              renderer.domElement.requestPointerLock();
          }

          function togglePause() {
              if (!isRunning) return;
              isPaused = !isPaused;
              if (isPaused) document.exitPointerLock();
              else renderer.domElement.requestPointerLock();
          }

          function updateAircraft() {
              if (!isRunning || isPaused) return;
              const acc = 0.5, fric = 0.95;

              if (keys.w) { aircraftState.velocityY += acc; aircraftState.pitch = Math.min(0.3, aircraftState.pitch + 0.02); }
              if (keys.s) { aircraftState.velocityY -= acc; aircraftState.pitch = Math.max(-0.3, aircraftState.pitch - 0.02); }
              if (keys.a) { aircraftState.velocityX -= acc; aircraftState.roll = Math.max(-0.5, aircraftState.roll - 0.03); }
              if (keys.d) { aircraftState.velocityX += acc; aircraftState.roll = Math.min(0.5, aircraftState.roll + 0.03); }
              if (keys.arrowup) aircraftState.speed = Math.min(30, aircraftState.speed + 0.5);
              if (keys.arrowdown) aircraftState.speed = Math.max(5, aircraftState.speed - 0.5);

              if (!keys.a && !keys.d) aircraftState.roll *= 0.9;
              if (!keys.w && !keys.s) aircraftState.pitch *= 0.9;

              aircraftState.x += aircraftState.velocityX + aircraftState.speed * Math.sin(aircraftState.yaw);
              aircraftState.y += aircraftState.velocityY;
              aircraftState.z += aircraftState.speed * Math.cos(aircraftState.yaw);
              aircraftState.velocityX *= fric;
              aircraftState.velocityY *= fric;

              aircraftState.y = Math.max(100, Math.min(2000, aircraftState.y));

              aircraft.position.set(aircraftState.x, aircraftState.y, aircraftState.z);
              aircraft.rotation.set(aircraftState.pitch, aircraftState.yaw, -aircraftState.roll);

              camera.position.set(
                  aircraftState.x - Math.sin(aircraftState.yaw) * 100,
                  aircraftState.y + 30,
                  aircraftState.z - Math.cos(aircraftState.yaw) * 100
              );
              camera.lookAt(
                  aircraftState.x + Math.sin(aircraftState.yaw) * 200,
                  aircraftState.y,
                  aircraftState.z + Math.cos(aircraftState.yaw) * 200
              );
          }

          function updateHUD() {
              if (!isRunning) return;
              document.getElementById('speed').textContent = `速度: ${Math.round(aircraftState.speed * 36)} km/h`;
              document.getElementById('altitude').textContent = `高度: ${Math.round(aircraftState.y)} m`;
              document.getElementById('position').textContent = `位置: X: ${Math.round(aircraftState.x)}, Z: ${Math.round(aircraftState.z)}`;
          }

          function updateTerrain() {
              mountains.forEach(m => {
                  const dist = Math.sqrt(Math.pow(m.position.x - aircraftState.x, 2) + Math.pow(m.position.z - aircraftState.z, 2));
                  if (dist > 2000) {
                      const angle = Math.random() * Math.PI * 2;
                      const d = Math.random() * 1000 + 1500;
                      m.position.x = aircraftState.x + Math.sin(angle) * d;
                      m.position.z = aircraftState.z + Math.cos(angle) * d;
                  }
              });
              clouds.forEach(c => {
                  const dist = Math.sqrt(Math.pow(c.position.x - aircraftState.x, 2) + Math.pow(c.position.z - aircraftState.z, 2));
                  if (dist > 2500) {
                      const angle = Math.random() * Math.PI * 2;
                      const d = Math.random() * 1000 + 2000;
                      c.position.x = aircraftState.x + Math.sin(angle) * d;
                      c.position.z = aircraftState.z + Math.cos(angle) * d;
                  }
              });
          }

          function animate() {
              requestAnimationFrame(animate);
              if (!isPaused) {
                  updateAircraft();
                  updateTerrain();
                  updateHUD();
              }
              renderer.render(scene, camera);
          }

          init();
      </script>
  </body>
  </html>
