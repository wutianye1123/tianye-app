// 游戏配置
const CONFIG = {
    GRID_ROWS: 5,
    GRID_COLS: 9,
    CELL_WIDTH: 80,
    CELL_HEIGHT: 90,
    GRID_OFFSET_X: 150,
    GRID_OFFSET_Y: 25,
    SUN_VALUE: 25,
    INITIAL_SUN: 150,
    WAVE_COUNT: 10,
    ZOMBIE_SPAWN_DELAY: 5000,
    SUN_SPAWN_INTERVAL: 10000,
    FPS: 60
};

// 植物配置
const PLANTS = {
    peashooter: {
        name: '豌豆射手',
        cost: 100,
        health: 100,
        damage: 20,
        fireRate: 1500,
        color: '#32CD32',
        projectileColor: '#90EE90'
    },
    sunflower: {
        name: '向日葵',
        cost: 50,
        health: 80,
        sunInterval: 5000,
        color: '#FFD700'
    },
    wallnut: {
        name: '坚果墙',
        cost: 50,
        health: 400,
        color: '#8B4513'
    },
    snowpea: {
        name: '寒冰射手',
        cost: 175,
        health: 100,
        damage: 20,
        fireRate: 1500,
        slowEffect: 0.5,
        color: '#00CED1',
        projectileColor: '#87CEEB'
    },
    cherrybomb: {
        name: '樱桃炸弹',
        cost: 150,
        health: 50,
        explosionRadius: 1,
        explosionDamage: 1800,
        color: '#DC143C'
    }
};

// 僵尸配置
const ZOMBIES = {
    normal: {
        name: '普通僵尸',
        health: 100,
        damage: 25,
        speed: 0.3,
        color: '#708090'
    },
    cone: {
        name: '路障僵尸',
        health: 200,
        damage: 25,
        speed: 0.3,
        color: '#FF8C00'
    },
    runner: {
        name: '快速僵尸',
        health: 80,
        damage: 20,
        speed: 0.6,
        color: '#9370DB'
    }
};

// 游戏状态
const GameState = {
    MENU: 'menu',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'game_over',
    VICTORY: 'victory'
};

// 图像资源
const IMAGES = {
    plants: {},
    zombies: {},
    loaded: false
};

// 加载图像
function loadImages() {
    return new Promise((resolve) => {
        const plantTypes = ['peashooter', 'sunflower', 'wallnut', 'snowpea', 'cherrybomb'];
        const zombieTypes = ['normal', 'cone', 'runner'];

        let loaded = 0;
        const total = plantTypes.length + zombieTypes.length;

        plantTypes.forEach(type => {
            const img = new Image();
            img.onload = () => {
                loaded++;
                if (loaded === total) {
                    IMAGES.loaded = true;
                    resolve();
                }
            };
            img.onerror = () => {
                loaded++;
                if (loaded === total) {
                    IMAGES.loaded = true;
                    resolve();
                }
            };
            img.src = `assets/characters/${type}.png`;
            IMAGES.plants[type] = img;
        });

        zombieTypes.forEach(type => {
            const img = new Image();
            img.onload = () => {
                loaded++;
                if (loaded === total) {
                    IMAGES.loaded = true;
                    resolve();
                }
            };
            img.onerror = () => {
                loaded++;
                if (loaded === total) {
                    IMAGES.loaded = true;
                    resolve();
                }
            };
            img.src = `assets/characters/zombie_${type}.png`;
            IMAGES.zombies[type] = img;
        });
    });
}

// 游戏类
class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.state = GameState.MENU;

        // 游戏数据
        this.sun = CONFIG.INITIAL_SUN;
        this.score = 0;
        this.wave = 1;
        this.zombiesKilled = 0;
        this.zombiesInWave = 0;

        // 游戏对象
        this.grid = [];
        this.plants = [];
        this.zombies = [];
        this.projectiles = [];
        this.suns = [];
        this.particles = [];

        // 选中的植物
        this.selectedPlant = 'peashooter';

        // 计时器
        this.lastTime = 0;
        this.sunSpawnTimer = 0;
        this.waveTimer = 0;

        // 初始化
        this.init();
    }

    async init() {
        // 加载图像
        await loadImages();

        // 初始化网格
        this.initGrid();

        // 绑定事件
        this.bindEvents();

        // 绘制卡片
        this.drawPlantCards();

        // 尝试自动加载存档，若失败则显示开始菜单
        if (!this.tryAutoLoad()) {
            this.showOverlay('植物大战僵尸', '点击开始游戏按钮开始', '开始游戏');
        }
    }

    initGrid() {
        this.grid = [];
        for (let row = 0; row < CONFIG.GRID_ROWS; row++) {
            this.grid[row] = [];
            for (let col = 0; col < CONFIG.GRID_COLS; col++) {
                this.grid[row][col] = null;
            }
        }
    }

    bindEvents() {
        // 植物选择
        document.querySelectorAll('.plant-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (card.classList.contains('disabled')) return;
                document.querySelectorAll('.plant-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this.selectedPlant = card.dataset.plant;
            });
        });

        // 画布点击
        this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e));

        // 控制按钮
        document.getElementById('start-btn').addEventListener('click', () => this.startGame());
        document.getElementById('pause-btn').addEventListener('click', () => this.togglePause());
        document.getElementById('restart-btn').addEventListener('click', () => this.restartGame());
        document.getElementById('overlay-btn').addEventListener('click', () => this.handleOverlayClick());
    }

    handleCanvasClick(e) {
        if (this.state !== GameState.PLAYING) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        // 检查是否点击了阳光
        for (let i = this.suns.length - 1; i >= 0; i--) {
            const sun = this.suns[i];
            const dist = Math.sqrt((x - sun.x) ** 2 + (y - sun.y) ** 2);
            if (dist < 25) {
                this.sun += CONFIG.SUN_VALUE;
                this.updateUI();
                this.suns.splice(i, 1);
                this.addParticles(sun.x, sun.y, '#FFD700', 5);
                return;
            }
        }

        // 检查是否在网格内
        const col = Math.floor((x - CONFIG.GRID_OFFSET_X) / CONFIG.CELL_WIDTH);
        const row = Math.floor((y - CONFIG.GRID_OFFSET_Y) / CONFIG.CELL_HEIGHT);

        if (row >= 0 && row < CONFIG.GRID_ROWS && col >= 0 && col < CONFIG.GRID_COLS) {
            if (this.grid[row][col] === null) {
                this.plantPlant(row, col);
            }
        }
    }

    plantPlant(row, col) {
        const plantType = this.selectedPlant;
        const plantConfig = PLANTS[plantType];

        if (this.sun < plantConfig.cost) return;

        this.sun -= plantConfig.cost;
        this.updateUI();

        const plant = {
            type: plantType,
            row: row,
            col: col,
            x: CONFIG.GRID_OFFSET_X + col * CONFIG.CELL_WIDTH + CONFIG.CELL_WIDTH / 2,
            y: CONFIG.GRID_OFFSET_Y + row * CONFIG.CELL_HEIGHT + CONFIG.CELL_HEIGHT / 2,
            health: plantConfig.health,
            maxHealth: plantConfig.health,
            lastFire: 0,
            lastSun: 0,
            animOffset: Math.random() * Math.PI * 2
        };

        this.plants.push(plant);
        this.grid[row][col] = plant;

        // 樱桃炸弹立即爆炸
        if (plantType === 'cherrybomb') {
            setTimeout(() => this.explodeCherryBomb(plant), 500);
        }

        this.addParticles(plant.x, plant.y, plantConfig.color, 8);
    }

    explodeCherryBomb(plant) {
        const explosionRadius = PLANTS.cherrybomb.explosionRadius;
        const damage = PLANTS.cherrybomb.explosionDamage;

        // 移除植物
        this.grid[plant.row][plant.col] = null;
        const idx = this.plants.indexOf(plant);
        if (idx > -1) this.plants.splice(idx, 1);

        // 对范围内僵尸造成伤害
        this.zombies.forEach(zombie => {
            const rowDiff = Math.abs(zombie.row - plant.row);
            const colDiff = Math.abs(Math.floor((zombie.x - CONFIG.GRID_OFFSET_X) / CONFIG.CELL_WIDTH) - plant.col);
            if (rowDiff <= explosionRadius && colDiff <= explosionRadius) {
                zombie.health -= damage;
                this.addParticles(zombie.x, zombie.y, '#FF4500', 10);
            }
        });

        // 爆炸特效
        for (let i = 0; i < 20; i++) {
            this.addParticles(plant.x, plant.y, '#FF4500', 1);
            this.addParticles(plant.x, plant.y, '#FFD700', 1);
        }
    }

    startGame() {
        this.state = GameState.PLAYING;
        document.getElementById('start-btn').disabled = true;
        document.getElementById('pause-btn').disabled = false;
        document.getElementById('restart-btn').disabled = false;
        this.hideOverlay();
        this.lastTime = performance.now();
        this.gameLoop();
    }

    togglePause() {
        if (this.state === GameState.PLAYING) {
            this.state = GameState.PAUSED;
            this.showOverlay('游戏暂停', '点击继续按钮恢复游戏', '继续');
            document.getElementById('pause-btn').textContent = '继续';
        } else if (this.state === GameState.PAUSED) {
            this.state = GameState.PLAYING;
            this.hideOverlay();
            document.getElementById('pause-btn').textContent = '暂停';
            this.lastTime = performance.now();
            this.gameLoop();
        }
    }

    restartGame() {
        // 清除存档
        try { localStorage.removeItem('pvz_game_save'); } catch (e) {}

        this.sun = CONFIG.INITIAL_SUN;
        this.score = 0;
        this.wave = 1;
        this.zombiesKilled = 0;
        this.zombiesInWave = 0;

        this.grid = [];
        this.plants = [];
        this.zombies = [];
        this.projectiles = [];
        this.suns = [];
        this.particles = [];

        this.initGrid();
        this.updateUI();
        this.startGame();
    }

    showOverlay(title, message, btnText) {
        document.getElementById('overlay').classList.remove('hidden');
        document.getElementById('overlay-title').textContent = title;
        document.getElementById('overlay-message').textContent = message;
        document.getElementById('overlay-btn').textContent = btnText;
    }

    hideOverlay() {
        document.getElementById('overlay').classList.add('hidden');
    }

    handleOverlayClick() {
        if (this.state === GameState.MENU) {
            this.startGame();
        } else if (this.state === GameState.PAUSED) {
            this.togglePause();
        } else if (this.state === GameState.GAME_OVER || this.state === GameState.VICTORY) {
            this.restartGame();
        }
    }

    updateUI() {
        document.getElementById('sun-count').textContent = this.sun;
        document.getElementById('wave-count').textContent = `${this.wave}/${CONFIG.WAVE_COUNT}`;
        document.getElementById('score').textContent = this.score;

        // 更新植物卡片状态
        document.querySelectorAll('.plant-card').forEach(card => {
            const cost = parseInt(card.dataset.cost);
            if (this.sun < cost) {
                card.classList.add('disabled');
            } else {
                card.classList.remove('disabled');
            }
        });
    }

    gameLoop() {
        if (this.state !== GameState.PLAYING) return;

        const currentTime = performance.now();
        const deltaTime = currentTime - this.lastTime;
        this.lastTime = currentTime;

        this.update(deltaTime);
        this.render();

        requestAnimationFrame(() => this.gameLoop());
    }

    update(deltaTime) {
        // 生成阳光
        this.sunSpawnTimer += deltaTime;
        if (this.sunSpawnTimer >= CONFIG.SUN_SPAWN_INTERVAL) {
            this.spawnSun();
            this.sunSpawnTimer = 0;
        }

        // 波次管理
        this.waveTimer += deltaTime;
        if (this.waveTimer >= CONFIG.ZOMBIE_SPAWN_DELAY && this.zombiesInWave < this.getZombiesPerWave()) {
            this.spawnZombie();
            this.zombiesInWave++;
            this.waveTimer = 0;
        }

        // 检查波次完成
        if (this.zombiesInWave >= this.getZombiesPerWave() && this.zombies.length === 0) {
            if (this.wave < CONFIG.WAVE_COUNT) {
                this.wave++;
                this.zombiesInWave = 0;
                this.waveTimer = -3000; // 波次间隔
                this.updateUI();
            } else {
                this.state = GameState.VICTORY;
                this.showOverlay('恭喜胜利!', `最终得分: ${this.score}`, '再来一局');
            }
        }

        // 更新植物
        this.updatePlants(deltaTime);

        // 更新僵尸
        this.updateZombies(deltaTime);

        // 更新子弹
        this.updateProjectiles(deltaTime);

        // 更新阳光
        this.updateSuns(deltaTime);

        // 更新粒子
        this.updateParticles(deltaTime);
    }

    getZombiesPerWave() {
        return 5 + this.wave * 2;
    }

    updatePlants(deltaTime) {
        const now = performance.now();

        this.plants.forEach(plant => {
            const config = PLANTS[plant.type];

            // 向日葵产生阳光
            if (plant.type === 'sunflower') {
                if (now - plant.lastSun >= config.sunInterval) {
                    this.suns.push({
                        x: plant.x,
                        y: plant.y - 20,
                        targetY: plant.y + 30,
                        speed: 0.5,
                        value: CONFIG.SUN_VALUE,
                        lifetime: 8000
                    });
                    plant.lastSun = now;
                }
            }

            // 射击类植物
            if (config.fireRate) {
                // 检查该行是否有僵尸
                const hasZombie = this.zombies.some(z => z.row === plant.row && z.x > plant.x);
                if (hasZombie && now - plant.lastFire >= config.fireRate) {
                    this.projectiles.push({
                        x: plant.x + 20,
                        y: plant.y,
                        row: plant.row,
                        speed: 5,
                        damage: config.damage,
                        color: config.projectileColor,
                        slowEffect: config.slowEffect || 0
                    });
                    plant.lastFire = now;
                }
            }
        });
    }

    updateZombies(deltaTime) {
        this.zombies = this.zombies.filter(zombie => {
            const config = ZOMBIES[zombie.type];

            // 检查是否死亡
            if (zombie.health <= 0) {
                this.score += 50;
                this.zombiesKilled++;
                this.updateUI();
                this.addParticles(zombie.x, zombie.y, config.color, 10);
                return false;
            }

            // 检查是否到达左边界
            if (zombie.x < 50) {
                this.state = GameState.GAME_OVER;
                this.showOverlay('游戏结束', `得分: ${this.score}`, '重新开始');
                return false;
            }

            // 检查是否在攻击植物
            const col = Math.floor((zombie.x - CONFIG.GRID_OFFSET_X) / CONFIG.CELL_WIDTH);
            const plant = this.grid[zombie.row]?.[col];

            if (plant && zombie.x < plant.x + 30 && zombie.x > plant.x - 30) {
                // 攻击植物
                zombie.isAttacking = true;
                plant.health -= config.damage * deltaTime / 1000;
                if (plant.health <= 0) {
                    this.grid[plant.row][plant.col] = null;
                    const idx = this.plants.indexOf(plant);
                    if (idx > -1) this.plants.splice(idx, 1);
                    this.addParticles(plant.x, plant.y, PLANTS[plant.type].color, 10);
                }
            } else {
                zombie.isAttacking = false;
                // 移动
                const speed = config.speed * (zombie.slowed ? 0.5 : 1);
                zombie.x -= speed * deltaTime / 16;
            }

            // 减速效果衰减
            if (zombie.slowed) {
                zombie.slowTimer -= deltaTime;
                if (zombie.slowTimer <= 0) {
                    zombie.slowed = false;
                }
            }

            return true;
        });
    }

    updateProjectiles(deltaTime) {
        this.projectiles = this.projectiles.filter(proj => {
            proj.x += proj.speed * deltaTime / 16;

            // 检查是否出界
            if (proj.x > this.canvas.width) return false;

            // 检查碰撞
            for (let zombie of this.zombies) {
                if (zombie.row === proj.row) {
                    const dist = Math.abs(proj.x - zombie.x);
                    if (dist < 25) {
                        zombie.health -= proj.damage;
                        if (proj.slowEffect) {
                            zombie.slowed = true;
                            zombie.slowTimer = 3000;
                        }
                        this.addParticles(proj.x, proj.y, proj.color, 3);
                        return false;
                    }
                }
            }

            return true;
        });
    }

    updateSuns(deltaTime) {
        this.suns = this.suns.filter(sun => {
            sun.lifetime -= deltaTime;
            if (sun.lifetime <= 0) return false;

            if (sun.y < sun.targetY) {
                sun.y += sun.speed * deltaTime / 16;
            }

            return true;
        });
    }

    updateParticles(deltaTime) {
        this.particles = this.particles.filter(p => {
            p.x += p.vx * deltaTime / 16;
            p.y += p.vy * deltaTime / 16;
            p.vy += 0.1; // 重力
            p.life -= deltaTime;
            return p.life > 0;
        });
    }

    spawnSun() {
        this.suns.push({
            x: CONFIG.GRID_OFFSET_X + Math.random() * (CONFIG.GRID_COLS * CONFIG.CELL_WIDTH),
            y: 0,
            targetY: 50 + Math.random() * 300,
            speed: 1,
            value: CONFIG.SUN_VALUE,
            lifetime: 10000
        });
    }

    spawnZombie() {
        const row = Math.floor(Math.random() * CONFIG.GRID_ROWS);
        const types = ['normal', 'normal', 'cone', 'runner'];
        const type = types[Math.floor(Math.random() * Math.min(this.wave, types.length))];
        const config = ZOMBIES[type];

        this.zombies.push({
            type: type,
            row: row,
            x: this.canvas.width + 50,
            y: CONFIG.GRID_OFFSET_Y + row * CONFIG.CELL_HEIGHT + CONFIG.CELL_HEIGHT / 2,
            health: config.health * (1 + this.wave * 0.1),
            isAttacking: false,
            slowed: false,
            slowTimer: 0,
            animOffset: Math.random() * Math.PI * 2
        });
    }

    addParticles(x, y, color, count) {
        for (let i = 0; i < count; i++) {
            this.particles.push({
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 4,
                vy: (Math.random() - 0.5) * 4 - 2,
                color: color,
                size: 3 + Math.random() * 4,
                life: 500 + Math.random() * 500
            });
        }
    }

    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // 绘制背景
        this.drawBackground();

        // 绘制网格
        this.drawGrid();

        // 绘制植物
        this.drawPlants();

        // 绘制僵尸
        this.drawZombies();

        // 绘制子弹
        this.drawProjectiles();

        // 绘制阳光
        this.drawSuns();

        // 绘制粒子
        this.drawParticles();
    }

    drawBackground() {
        // 绘制草地纹理
        const gradient = this.ctx.createLinearGradient(0, 0, 0, this.canvas.height);
        gradient.addColorStop(0, '#4a7c23');
        gradient.addColorStop(0.5, '#3d6b1c');
        gradient.addColorStop(1, '#2d5016');
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // 左侧僵尸出生区
        this.ctx.fillStyle = 'rgba(50, 30, 20, 0.5)';
        this.ctx.fillRect(0, 0, CONFIG.GRID_OFFSET_X, this.canvas.height);
    }

    drawGrid() {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.lineWidth = 1;

        for (let row = 0; row <= CONFIG.GRID_ROWS; row++) {
            this.ctx.beginPath();
            this.ctx.moveTo(CONFIG.GRID_OFFSET_X, CONFIG.GRID_OFFSET_Y + row * CONFIG.CELL_HEIGHT);
            this.ctx.lineTo(CONFIG.GRID_OFFSET_X + CONFIG.GRID_COLS * CONFIG.CELL_WIDTH, CONFIG.GRID_OFFSET_Y + row * CONFIG.CELL_HEIGHT);
            this.ctx.stroke();
        }

        for (let col = 0; col <= CONFIG.GRID_COLS; col++) {
            this.ctx.beginPath();
            this.ctx.moveTo(CONFIG.GRID_OFFSET_X + col * CONFIG.CELL_WIDTH, CONFIG.GRID_OFFSET_Y);
            this.ctx.lineTo(CONFIG.GRID_OFFSET_X + col * CONFIG.CELL_WIDTH, CONFIG.GRID_OFFSET_Y + CONFIG.GRID_ROWS * CONFIG.CELL_HEIGHT);
            this.ctx.stroke();
        }
    }

    drawPlants() {
        const time = performance.now();

        this.plants.forEach(plant => {
            const config = PLANTS[plant.type];
            const bounce = Math.sin(time / 300 + plant.animOffset) * 3;

            this.ctx.save();
            this.ctx.translate(plant.x, plant.y + bounce);

            // 绘制植物
            this.drawPlantAnimated(plant.type, config, plant.health / plant.maxHealth, time);

            this.ctx.restore();

            // 血条
            if (plant.health < plant.maxHealth) {
                const barWidth = 50;
                const barHeight = 5;
                const healthPercent = plant.health / plant.maxHealth;

                this.ctx.fillStyle = '#333';
                this.ctx.fillRect(plant.x - barWidth / 2, plant.y - 55, barWidth, barHeight);

                this.ctx.fillStyle = healthPercent > 0.5 ? '#4CAF50' : healthPercent > 0.25 ? '#FFC107' : '#F44336';
                this.ctx.fillRect(plant.x - barWidth / 2, plant.y - 55, barWidth * healthPercent, barHeight);
            }
        });
    }

    drawPlant(type, config, healthPercent) {
        const ctx = this.ctx;
        const time = performance.now();

        // 使用 Canvas 绘制带动画的角色
        this.drawPlantAnimated(type, config, healthPercent, time);
    }

    drawPlantAnimated(type, config, healthPercent, time) {
        const ctx = this.ctx;
        const breathe = Math.sin(time / 500) * 2;
        const sway = Math.sin(time / 800) * 0.05;

        ctx.save();
        ctx.rotate(sway);

        switch (type) {
            case 'peashooter':
                this.drawPeashooter(ctx, config, time, breathe);
                break;
            case 'sunflower':
                this.drawSunflower(ctx, config, time, breathe);
                break;
            case 'wallnut':
                this.drawWallnut(ctx, config, healthPercent, time, breathe);
                break;
            case 'snowpea':
                this.drawSnowpea(ctx, config, time, breathe);
                break;
            case 'cherrybomb':
                this.drawCherrybomb(ctx, config, time, breathe);
                break;
        }

        ctx.restore();
    }

    drawPeashooter(ctx, config, time, breathe) {
        const mouthOpen = Math.sin(time / 300) * 3 + 5;
        const leafWave = Math.sin(time / 400) * 5;

        // 茎
        ctx.fillStyle = '#228B22';
        ctx.beginPath();
        ctx.moveTo(-8, 0);
        ctx.quadraticCurveTo(-6 + leafWave/2, 15, -5, 30);
        ctx.lineTo(5, 30);
        ctx.quadraticCurveTo(6 - leafWave/2, 15, 8, 0);
        ctx.fill();

        // 叶子
        ctx.fillStyle = '#32CD32';
        ctx.save();
        ctx.translate(-10, 10);
        ctx.rotate(-0.3 + Math.sin(time/600) * 0.1);
        ctx.beginPath();
        ctx.ellipse(0, 0, 12, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(10, 15);
        ctx.rotate(0.3 - Math.sin(time/600) * 0.1);
        ctx.beginPath();
        ctx.ellipse(0, 0, 12, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 头部
        ctx.fillStyle = config.color;
        ctx.beginPath();
        ctx.arc(0, -15 + breathe, 22, 0, Math.PI * 2);
        ctx.fill();

        // 头顶
        ctx.beginPath();
        ctx.arc(0, -25 + breathe, 8, 0, Math.PI * 2);
        ctx.fill();

        // 嘴巴（炮口）
        ctx.fillStyle = '#006400';
        ctx.beginPath();
        ctx.ellipse(18, -15 + breathe, 10, 8 + mouthOpen/2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#004400';
        ctx.beginPath();
        ctx.arc(22, -15 + breathe, 6, 0, Math.PI * 2);
        ctx.fill();

        // 眼睛
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.ellipse(-8, -20 + breathe, 6, 7, 0, 0, Math.PI * 2);
        ctx.ellipse(5, -20 + breathe, 6, 7, 0, 0, Math.PI * 2);
        ctx.fill();

        // 瞳孔（看向右边/前方）
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.arc(-6, -19 + breathe, 3, 0, Math.PI * 2);
        ctx.arc(7, -19 + breathe, 3, 0, Math.PI * 2);
        ctx.fill();

        // 眼睛高光
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(-7, -21 + breathe, 1.5, 0, Math.PI * 2);
        ctx.arc(6, -21 + breathe, 1.5, 0, Math.PI * 2);
        ctx.fill();
    }

    drawSunflower(ctx, config, time, breathe) {
        const petalRotate = time / 1000;
        const petalBounce = Math.sin(time / 300);

        // 茎
        ctx.fillStyle = '#228B22';
        ctx.beginPath();
        ctx.moveTo(-6, 0);
        ctx.quadraticCurveTo(-4, 20, -5, 35);
        ctx.lineTo(5, 35);
        ctx.quadraticCurveTo(4, 20, 6, 0);
        ctx.fill();

        // 叶子
        ctx.fillStyle = '#32CD32';
        ctx.save();
        ctx.translate(-12, 12);
        ctx.rotate(-0.4 + Math.sin(time/500) * 0.15);
        ctx.beginPath();
        ctx.ellipse(0, 0, 15, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(12, 18);
        ctx.rotate(0.4 - Math.sin(time/500) * 0.15);
        ctx.beginPath();
        ctx.ellipse(0, 0, 15, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 花瓣（两圈）
        ctx.fillStyle = config.color;
        for (let ring = 0; ring < 2; ring++) {
            const petalCount = ring === 0 ? 12 : 8;
            const radius = ring === 0 ? 28 : 18;
            const petalSize = ring === 0 ? 12 : 8;
            for (let i = 0; i < petalCount; i++) {
                const angle = (i / petalCount) * Math.PI * 2 + petalRotate * (ring === 0 ? 1 : -0.5);
                const bounce = Math.sin(time / 400 + i) * 3;
                ctx.save();
                ctx.translate(0, -20 + breathe);
                ctx.rotate(angle);
                ctx.beginPath();
                ctx.ellipse(0, -radius - bounce, petalSize, petalSize * 1.8, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }

        // 花心
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.arc(0, -20 + breathe, 15, 0, Math.PI * 2);
        ctx.fill();

        // 花心纹理
        ctx.fillStyle = '#6B3510';
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const x = Math.cos(angle) * 8;
            const y = -20 + breathe + Math.sin(angle) * 8;
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // 笑脸
        const blink = Math.floor(time / 3000) % 10 === 0 ? 0.5 : 1;
        ctx.fillStyle = 'black';
        ctx.save();
        ctx.translate(0, -20 + breathe);
        ctx.scale(1, blink);
        ctx.beginPath();
        ctx.arc(-5, -3, 3, 0, Math.PI * 2);
        ctx.arc(5, -3, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 微笑
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, -17 + breathe, 7, 0.2, Math.PI - 0.2);
        ctx.stroke();

        // 腮红
        ctx.fillStyle = 'rgba(255, 150, 150, 0.5)';
        ctx.beginPath();
        ctx.ellipse(-10, -15 + breathe, 5, 3, 0, 0, Math.PI * 2);
        ctx.ellipse(10, -15 + breathe, 5, 3, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    drawWallnut(ctx, config, healthPercent, time, breathe) {
        const wobble = Math.sin(time / 200) * 2;
        const squash = 1 + Math.sin(time / 400) * 0.05;

        ctx.save();
        ctx.scale(1, squash);

        // 主体阴影
        ctx.fillStyle = '#5D3A1A';
        ctx.beginPath();
        ctx.ellipse(2, 2, 26, 32, 0, 0, Math.PI * 2);
        ctx.fill();

        // 主体
        ctx.fillStyle = config.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, 26, 32, 0, 0, Math.PI * 2);
        ctx.fill();

        // 高光
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.beginPath();
        ctx.ellipse(-8, -10, 10, 15, -0.3, 0, Math.PI * 2);
        ctx.fill();

        // 裂纹（根据血量）
        if (healthPercent < 0.66) {
            ctx.strokeStyle = '#3D2A0A';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(-10, -18);
            ctx.lineTo(-5, 0);
            ctx.lineTo(-12, 18);
            ctx.stroke();
        }
        if (healthPercent < 0.33) {
            ctx.beginPath();
            ctx.moveTo(8, -22);
            ctx.lineTo(12, 5);
            ctx.lineTo(5, 22);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-3, -15);
            ctx.lineTo(5, 0);
            ctx.stroke();
        }

        // 眼睛
        const eyeY = -5 + wobble/2;
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.ellipse(-9, eyeY, 8, 9, 0, 0, Math.PI * 2);
        ctx.ellipse(9, eyeY, 8, 9, 0, 0, Math.PI * 2);
        ctx.fill();

        // 瞳孔
        ctx.fillStyle = 'black';
        const pupilOffset = Math.sin(time/1000) * 2;
        ctx.beginPath();
        ctx.arc(-8 + pupilOffset, eyeY, 4, 0, Math.PI * 2);
        ctx.arc(10 + pupilOffset, eyeY, 4, 0, Math.PI * 2);
        ctx.fill();

        // 高光
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(-9, eyeY - 3, 2, 0, Math.PI * 2);
        ctx.arc(9, eyeY - 3, 2, 0, Math.PI * 2);
        ctx.fill();

        // 嘴巴
        ctx.strokeStyle = '#3D2A0A';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 8, 10, 0.2, Math.PI - 0.2);
        ctx.stroke();

        ctx.restore();
    }

    drawSnowpea(ctx, config, time, breathe) {
        const mouthOpen = Math.sin(time / 300) * 3 + 5;
        const iceSparkle = Math.sin(time / 200);

        // 茎（冰蓝色）
        ctx.fillStyle = '#008B8B';
        ctx.beginPath();
        ctx.moveTo(-8, 0);
        ctx.quadraticCurveTo(-6, 15, -5, 30);
        ctx.lineTo(5, 30);
        ctx.quadraticCurveTo(6, 15, 8, 0);
        ctx.fill();

        // 冰晶叶子
        ctx.fillStyle = '#40E0D0';
        ctx.save();
        ctx.translate(-12, 10);
        ctx.rotate(-0.3 + Math.sin(time/500) * 0.1);
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(5, -12);
            ctx.lineTo(10, 0);
            ctx.fill();
            ctx.rotate(Math.PI * 2 / 3);
        }
        ctx.restore();

        // 头部
        ctx.fillStyle = config.color;
        ctx.beginPath();
        ctx.arc(0, -15 + breathe, 22, 0, Math.PI * 2);
        ctx.fill();

        // 冰晶装饰
        ctx.strokeStyle = '#87CEEB';
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2 + time / 2000;
            const spark = iceSparkle * 3 + 5;
            ctx.save();
            ctx.translate(0, -15 + breathe);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(0, -22);
            ctx.lineTo(-3, -28 - spark);
            ctx.lineTo(0, -22);
            ctx.lineTo(3, -28 - spark);
            ctx.stroke();
            ctx.restore();
        }

        // 嘴巴（炮口）
        ctx.fillStyle = '#006B6B';
        ctx.beginPath();
        ctx.ellipse(18, -15 + breathe, 10, 8 + mouthOpen/2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#004040';
        ctx.beginPath();
        ctx.arc(22, -15 + breathe, 6, 0, Math.PI * 2);
        ctx.fill();

        // 眼睛
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.ellipse(-8, -20 + breathe, 6, 7, 0, 0, Math.PI * 2);
        ctx.ellipse(5, -20 + breathe, 6, 7, 0, 0, Math.PI * 2);
        ctx.fill();

        // 瞳孔（深蓝色）
        ctx.fillStyle = '#000080';
        ctx.beginPath();
        ctx.arc(-6, -19 + breathe, 3, 0, Math.PI * 2);
        ctx.arc(7, -19 + breathe, 3, 0, Math.PI * 2);
        ctx.fill();

        // 高光
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(-7, -21 + breathe, 1.5, 0, Math.PI * 2);
        ctx.arc(6, -21 + breathe, 1.5, 0, Math.PI * 2);
        ctx.fill();
    }

    drawCherrybomb(ctx, config, time, breathe) {
        const pulse = 1 + Math.sin(time / 100) * 0.1;
        const shake = Math.sin(time / 50) * 2;
        const anger = Math.sin(time / 200) * 3;

        ctx.save();
        ctx.translate(shake, 0);
        ctx.scale(pulse, pulse);

        // 茎
        ctx.strokeStyle = '#228B22';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-12, -15);
        ctx.quadraticCurveTo(-5, -40, 0, -42);
        ctx.quadraticCurveTo(5, -40, 12, -15);
        ctx.stroke();

        // 叶子
        ctx.fillStyle = '#32CD32';
        ctx.beginPath();
        ctx.ellipse(0, -42, 8, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // 左樱桃阴影
        ctx.fillStyle = '#8B0000';
        ctx.beginPath();
        ctx.arc(-10, 7, 20, 0, Math.PI * 2);
        ctx.fill();

        // 左樱桃
        ctx.fillStyle = config.color;
        ctx.beginPath();
        ctx.arc(-12, 5, 20, 0, Math.PI * 2);
        ctx.fill();

        // 高光
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.ellipse(-18, -2, 6, 8, -0.3, 0, Math.PI * 2);
        ctx.fill();

        // 右樱桃阴影
        ctx.fillStyle = '#8B0000';
        ctx.beginPath();
        ctx.arc(14, 7, 20, 0, Math.PI * 2);
        ctx.fill();

        // 右樱桃
        ctx.fillStyle = config.color;
        ctx.beginPath();
        ctx.arc(12, 5, 20, 0, Math.PI * 2);
        ctx.fill();

        // 高光
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.ellipse(6, -2, 6, 8, 0.3, 0, Math.PI * 2);
        ctx.fill();

        // 左樱桃眼睛（愤怒）
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.ellipse(-18, 0, 6, 7, 0, 0, Math.PI * 2);
        ctx.ellipse(-8, 0, 6, 7, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.arc(-17, 2, 3, 0, Math.PI * 2);
        ctx.arc(-7, 2, 3, 0, Math.PI * 2);
        ctx.fill();

        // 愤怒眉毛
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-22, -8 - anger);
        ctx.lineTo(-14, -5);
        ctx.moveTo(-4, -5);
        ctx.lineTo(-12, -8 - anger);
        ctx.stroke();

        // 右樱桃眼睛（愤怒）
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.ellipse(6, 0, 6, 7, 0, 0, Math.PI * 2);
        ctx.ellipse(16, 0, 6, 7, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.arc(7, 2, 3, 0, Math.PI * 2);
        ctx.arc(17, 2, 3, 0, Math.PI * 2);
        ctx.fill();

        // 愤怒眉毛
        ctx.beginPath();
        ctx.moveTo(2, -8 - anger);
        ctx.lineTo(10, -5);
        ctx.moveTo(20, -5);
        ctx.lineTo(12, -8 - anger);
        ctx.stroke();

        // 嘴巴（咬牙）
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(-13, 10, 6, 0, Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(11, 10, 6, 0, Math.PI);
        ctx.stroke();

        ctx.restore();
    }

    drawZombies() {
        const time = performance.now();

        this.zombies.forEach(zombie => {
            const config = ZOMBIES[zombie.type];
            const walkAnim = zombie.isAttacking ? 0 : Math.sin(time / 200 + zombie.animOffset) * 5;

            this.ctx.save();
            this.ctx.translate(zombie.x, zombie.y);

            // 减速效果
            if (zombie.slowed) {
                this.ctx.fillStyle = 'rgba(135, 206, 235, 0.3)';
                this.ctx.beginPath();
                this.ctx.arc(0, 0, 35, 0, Math.PI * 2);
                this.ctx.fill();
            }

            // 绘制僵尸
            this.drawZombie(zombie.type, config, zombie.isAttacking, walkAnim);

            this.ctx.restore();

            // 血条
            const barWidth = 40;
            const barHeight = 4;
            const healthPercent = zombie.health / (config.health * (1 + this.wave * 0.1));

            this.ctx.fillStyle = '#333';
            this.ctx.fillRect(zombie.x - barWidth / 2, zombie.y - 50, barWidth, barHeight);

            this.ctx.fillStyle = '#F44336';
            this.ctx.fillRect(zombie.x - barWidth / 2, zombie.y - 50, barWidth * Math.max(0, healthPercent), barHeight);
        });
    }

    drawZombie(type, config, isAttacking, walkAnim) {
        const ctx = this.ctx;
        const time = performance.now();

        // 使用 Canvas 绘制带动画的僵尸
        this.drawZombieAnimated(type, config, isAttacking, walkAnim, time);
    }

    drawZombieAnimated(type, config, isAttacking, walkAnim, time) {
        const ctx = this.ctx;

        const walkCycle = time / 200;
        const legSwing = Math.sin(walkCycle) * 15;
        const armSwing = Math.sin(walkCycle) * 20;
        const bodyBob = Math.abs(Math.sin(walkCycle)) * 3;
        const headTilt = Math.sin(walkCycle * 0.5) * 0.1;

        ctx.save();
        ctx.rotate(headTilt);

        // 根据僵尸类型设置颜色
        const skinColor = type === 'runner' ? '#9370DB' : '#6B8E23';
        const clothColor = config.color;

        // 阴影
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.beginPath();
        ctx.ellipse(0, 42, 20, 8, 0, 0, Math.PI * 2);
        ctx.fill();

        // 腿
        ctx.fillStyle = '#2F4F4F';
        // 左腿
        ctx.save();
        ctx.translate(-8, 15);
        ctx.rotate(isAttacking ? 0 : legSwing * Math.PI / 180);
        ctx.fillRect(-5, 0, 10, 28);
        // 鞋子
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(-6, 23, 12, 6);
        ctx.restore();

        // 右腿
        ctx.fillStyle = '#2F4F4F';
        ctx.save();
        ctx.translate(8, 15);
        ctx.rotate(isAttacking ? 0 : -legSwing * Math.PI / 180);
        ctx.fillRect(-5, 0, 10, 28);
        // 鞋子
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(-6, 23, 12, 6);
        ctx.restore();

        // 身体
        ctx.fillStyle = clothColor;
        ctx.beginPath();
        ctx.roundRect(-18, -25 - bodyBob, 36, 45, 5);
        ctx.fill();

        // 衣服细节
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.fillRect(-15, -5 - bodyBob, 30, 3);

        // 左臂
        ctx.fillStyle = skinColor;
        ctx.save();
        ctx.translate(-18, -15 - bodyBob);
        const leftArmAngle = isAttacking ? -60 + Math.sin(time / 100) * 20 : -30 + armSwing * Math.PI / 180;
        ctx.rotate(leftArmAngle * Math.PI / 180);
        ctx.fillRect(-5, 0, 10, 30);
        // 手
        ctx.fillStyle = skinColor;
        ctx.beginPath();
        ctx.arc(0, 32, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 右臂（攻击手）
        ctx.fillStyle = skinColor;
        ctx.save();
        ctx.translate(18, -15 - bodyBob);
        const rightArmAngle = isAttacking ? -90 + Math.sin(time / 80) * 30 : 30 - armSwing * Math.PI / 180;
        ctx.rotate(rightArmAngle * Math.PI / 180);
        ctx.fillRect(-5, 0, 10, 30);
        // 手
        ctx.fillStyle = skinColor;
        ctx.beginPath();
        ctx.arc(0, 32, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 头
        ctx.fillStyle = skinColor;
        ctx.beginPath();
        ctx.arc(0, -35 - bodyBob, 18, 0, Math.PI * 2);
        ctx.fill();

        // 头发（稀疏）
        ctx.fillStyle = '#2F2F2F';
        for (let i = 0; i < 5; i++) {
            const angle = -Math.PI/2 + (i - 2) * 0.3;
            const x = Math.cos(angle) * 16;
            const y = -35 - bodyBob + Math.sin(angle) * 16;
            ctx.beginPath();
            ctx.ellipse(x, y - 5, 3, 8, angle, 0, Math.PI * 2);
            ctx.fill();
        }

        // 路障帽子
        if (type === 'cone') {
            ctx.fillStyle = '#FF8C00';
            ctx.beginPath();
            ctx.moveTo(0, -60 - bodyBob);
            ctx.lineTo(-15, -35 - bodyBob);
            ctx.lineTo(15, -35 - bodyBob);
            ctx.closePath();
            ctx.fill();
            // 路障条纹
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.moveTo(0, -55 - bodyBob);
            ctx.lineTo(-8, -45 - bodyBob);
            ctx.lineTo(8, -45 - bodyBob);
            ctx.closePath();
            ctx.fill();
        }

        // 眼睛
        const eyeBlink = Math.floor(time / 3000) % 20 === 0;
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.ellipse(-7, -38 - bodyBob, 5, eyeBlink ? 1 : 6, 0, 0, Math.PI * 2);
        ctx.ellipse(7, -38 - bodyBob, 5, eyeBlink ? 1 : 6, 0, 0, Math.PI * 2);
        ctx.fill();

        // 瞳孔（红色，看向左边）
        ctx.fillStyle = '#FF0000';
        ctx.beginPath();
        ctx.arc(-9, -37 - bodyBob, 3, 0, Math.PI * 2);
        ctx.arc(5, -37 - bodyBob, 3, 0, Math.PI * 2);
        ctx.fill();

        // 瞳孔高光
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(-10, -39 - bodyBob, 1, 0, Math.PI * 2);
        ctx.arc(4, -39 - bodyBob, 1, 0, Math.PI * 2);
        ctx.fill();

        // 嘴巴
        ctx.fillStyle = '#8B0000';
        ctx.beginPath();
        ctx.arc(0, -28 - bodyBob, 8, 0.1, Math.PI - 0.1);
        ctx.fill();

        // 牙齿
        ctx.fillStyle = '#F5F5DC';
        ctx.fillRect(-5, -30 - bodyBob, 3, 5);
        ctx.fillRect(2, -30 - bodyBob, 3, 5);

        // 快速僵尸特效
        if (type === 'runner') {
            ctx.strokeStyle = 'rgba(147, 112, 219, 0.5)';
            ctx.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                ctx.moveTo(25 + i * 10, -20);
                ctx.lineTo(35 + i * 10, -20);
                ctx.moveTo(25 + i * 10, 0);
                ctx.lineTo(35 + i * 10, 0);
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    drawProjectiles() {
        this.projectiles.forEach(proj => {
            this.ctx.fillStyle = proj.color;
            this.ctx.beginPath();
            this.ctx.arc(proj.x, proj.y, 8, 0, Math.PI * 2);
            this.ctx.fill();

            // 光晕效果
            this.ctx.strokeStyle = proj.color;
            this.ctx.lineWidth = 2;
            this.ctx.globalAlpha = 0.5;
            this.ctx.beginPath();
            this.ctx.arc(proj.x, proj.y, 12, 0, Math.PI * 2);
            this.ctx.stroke();
            this.ctx.globalAlpha = 1;
        });
    }

    drawSuns() {
        this.suns.forEach(sun => {
            const pulse = Math.sin(performance.now() / 200) * 3;

            this.ctx.fillStyle = '#FFD700';
            this.ctx.beginPath();
            this.ctx.arc(sun.x, sun.y, 18 + pulse, 0, Math.PI * 2);
            this.ctx.fill();

            // 光芒
            this.ctx.strokeStyle = '#FFA500';
            this.ctx.lineWidth = 3;
            for (let i = 0; i < 8; i++) {
                const angle = (i / 8) * Math.PI * 2;
                this.ctx.beginPath();
                this.ctx.moveTo(
                    sun.x + Math.cos(angle) * 20,
                    sun.y + Math.sin(angle) * 20
                );
                this.ctx.lineTo(
                    sun.x + Math.cos(angle) * (28 + pulse),
                    sun.y + Math.sin(angle) * (28 + pulse)
                );
                this.ctx.stroke();
            }

            // 笑脸
            this.ctx.fillStyle = '#FF8C00';
            this.ctx.beginPath();
            this.ctx.arc(sun.x - 5, sun.y - 3, 3, 0, Math.PI * 2);
            this.ctx.arc(sun.x + 5, sun.y - 3, 3, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.beginPath();
            this.ctx.arc(sun.x, sun.y + 3, 6, 0, Math.PI);
            this.ctx.stroke();
        });
    }

    drawParticles() {
        this.particles.forEach(p => {
            this.ctx.globalAlpha = Math.min(1, p.life / 500);
            this.ctx.fillStyle = p.color;
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            this.ctx.fill();
        });
        this.ctx.globalAlpha = 1;
    }

    drawPlantCards() {
        const plants = ['peashooter', 'sunflower', 'wallnut', 'snowpea', 'cherrybomb'];

        plants.forEach(type => {
            const canvas = document.getElementById(`card-${type}`);
            if (!canvas) return;

            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const config = PLANTS[type];
            ctx.save();
            ctx.translate(canvas.width / 2, canvas.height / 2 + 10);
            ctx.scale(0.55, 0.55);
            this.drawPlantAnimated(type, config, 1, performance.now());
            ctx.restore();
        });
    }

    // ===== 存档系统 =====

    saveGame() {
        if (this.state !== GameState.PLAYING && this.state !== GameState.PAUSED) {
            showSaveToast('无法保存：游戏未在进行中');
            return;
        }
        try {
            const data = {
                sun: this.sun,
                score: this.score,
                wave: this.wave,
                zombiesKilled: this.zombiesKilled,
                zombiesInWave: this.zombiesInWave,
                state: this.state,
                selectedPlant: this.selectedPlant,
                // 网格占用状态：存储每格的植物索引（用于重建引用）
                grid: this.grid.map(row => row.map(cell => {
                    if (cell === null) return null;
                    return {
                        type: cell.type,
                        row: cell.row,
                        col: cell.col,
                        health: cell.health,
                        maxHealth: cell.maxHealth
                    };
                })),
                plants: this.plants.map(p => ({
                    type: p.type,
                    row: p.row,
                    col: p.col,
                    health: p.health,
                    maxHealth: p.maxHealth,
                    animOffset: p.animOffset
                })),
                zombies: this.zombies.map(z => ({
                    type: z.type,
                    row: z.row,
                    x: z.x,
                    health: z.health,
                    slowed: z.slowed || false,
                    slowTimer: z.slowTimer || 0,
                    animOffset: z.animOffset
                }))
            };
            localStorage.setItem('pvz_game_save', JSON.stringify(data));
            showSaveToast('已保存');
        } catch (e) {
            console.error('保存失败:', e);
            showSaveToast('保存失败');
        }
    }

    loadGame() {
        try {
            const raw = localStorage.getItem('pvz_game_save');
            if (!raw) {
                showSaveToast('没有存档');
                return;
            }
            const data = JSON.parse(raw);
            this.applySaveData(data);
            showSaveToast('已加载');
        } catch (e) {
            console.error('加载失败:', e);
            showSaveToast('加载失败');
        }
    }

    applySaveData(data) {
        // 停止当前游戏循环
        this.state = GameState.PAUSED;

        // 基础数值
        this.sun = data.sun;
        this.score = data.score;
        this.wave = data.wave;
        this.zombiesKilled = data.zombiesKilled;
        this.zombiesInWave = data.zombiesInWave || 0;
        this.selectedPlant = data.selectedPlant || 'peashooter';

        // 重建网格
        this.initGrid();

        // 重建植物
        this.plants = [];
        if (data.plants) {
            data.plants.forEach(p => {
                const plant = {
                    type: p.type,
                    row: p.row,
                    col: p.col,
                    x: CONFIG.GRID_OFFSET_X + p.col * CONFIG.CELL_WIDTH + CONFIG.CELL_WIDTH / 2,
                    y: CONFIG.GRID_OFFSET_Y + p.row * CONFIG.CELL_HEIGHT + CONFIG.CELL_HEIGHT / 2,
                    health: p.health,
                    maxHealth: p.maxHealth,
                    lastFire: 0,
                    lastSun: 0,
                    animOffset: p.animOffset !== undefined ? p.animOffset : Math.random() * Math.PI * 2
                };
                this.plants.push(plant);
                this.grid[p.row][p.col] = plant;
            });
        }

        // 重建僵尸
        this.zombies = [];
        if (data.zombies) {
            data.zombies.forEach(z => {
                this.zombies.push({
                    type: z.type,
                    row: z.row,
                    x: z.x,
                    y: CONFIG.GRID_OFFSET_Y + z.row * CONFIG.CELL_HEIGHT + CONFIG.CELL_HEIGHT / 2,
                    health: z.health,
                    isAttacking: false,
                    slowed: z.slowed || false,
                    slowTimer: z.slowTimer || 0,
                    animOffset: z.animOffset !== undefined ? z.animOffset : Math.random() * Math.PI * 2
                });
            });
        }

        // 清空临时对象
        this.projectiles = [];
        this.suns = [];
        this.particles = [];
        this.sunSpawnTimer = 0;
        this.waveTimer = 0;

        // 恢复游戏状态
        this.state = GameState.PLAYING;

        // 启用按钮
        document.getElementById('start-btn').disabled = true;
        document.getElementById('pause-btn').disabled = false;
        document.getElementById('restart-btn').disabled = false;
        document.getElementById('pause-btn').textContent = '暂停';

        this.hideOverlay();
        this.updateUI();
        this.lastTime = performance.now();
        this.gameLoop();
    }

    // 自动加载存档（在 init 结束时调用）
    tryAutoLoad() {
        try {
            const raw = localStorage.getItem('pvz_game_save');
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data || data.sun === undefined) return false;
            this.applySaveData(data);
            showSaveToast('已加载存档');
            return true;
        } catch (e) {
            return false;
        }
    }
}

// Toast 提示函数
function showSaveToast(msg) {
    const el = document.getElementById('saveMsg');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 1500);
}

// 启动游戏
window.addEventListener('load', () => {
    const game = new Game();

    // F5 保存 / F9 加载
    window.addEventListener('keydown', (e) => {
        if (e.key === 'F5') {
            e.preventDefault();
            game.saveGame();
        } else if (e.key === 'F9') {
            e.preventDefault();
            game.loadGame();
        }
    });
});
