export const CONFIG = {
    PLANET_RADIUS: 600000,
    SURFACE_GRAVITY: 40,
    ATMOSPHERE_HEIGHT: 70000,
    ATMOSPHERE_DENSITY_SEA: 1.225,
    ATMOSPHERE_SCALE_HEIGHT: 5600,
    get PLANET_MU() { return this.SURFACE_GRAVITY * this.PLANET_RADIUS * this.PLANET_RADIUS; },

    MUN_RADIUS: 200000,
    MUN_SURFACE_GRAVITY: 1.63,
    MUN_ORBIT_RADIUS: 12000000,
    MUN_ORBIT_PERIOD: 138984,
    get MUN_MU() { return this.MUN_SURFACE_GRAVITY * this.MUN_RADIUS * this.MUN_RADIUS; },
    get MUN_SOI() { return 2429559; },
    get MUN_ANGULAR_VELOCITY() { return 2 * Math.PI / this.MUN_ORBIT_PERIOD; },

    DRAG_COEFFICIENT: 0.2,
    PHYSICS_DT: 0.02,
    RENDER_SCALE_FLIGHT: 0.01,
    TIME_WARP_LEVELS: [1, 2, 4, 10, 50, 100],
    MAX_PHYSICS_WARP: 4,
    PLANET_COLOR_OCEAN: 0x1a6bb5,
    PLANET_COLOR_LAND: 0x3d8b37,
    ATMOSPHERE_COLOR: 0x6eb5ff,
    MUN_COLOR: 0x888888,
    STAR_COUNT: 2000,
};

export const PART_DEFS = {
    CommandPod: {
        name: '指令舱', dryMass: 0.8, fuelCapacity: 0, thrust: 0, isp: 0,
        dragArea: 1.5, icon: '\u25B2', height: 1.2, width: 1.25, color: 0x4fc3f7,
        stageType: 'command', category: 'pods',
    },
    CommandPodSmall: {
        name: '小型指令舱', dryMass: 0.5, fuelCapacity: 0, thrust: 0, isp: 0,
        dragArea: 1.0, icon: '\u25B4', height: 0.8, width: 0.9, color: 0x4fc3f7,
        stageType: 'command', category: 'pods',
    },
    LargeTank: {
        name: '大型燃料箱', dryMass: 0.5, fuelCapacity: 8000, thrust: 0, isp: 0,
        dragArea: 2.0, icon: '\u2588', height: 3.0, width: 1.25, color: 0xcccccc,
        stageType: 'fuel', category: 'fuel',
    },
    SmallTank: {
        name: '小型燃料箱', dryMass: 0.25, fuelCapacity: 2000, thrust: 0, isp: 0,
        dragArea: 1.5, icon: '\u2500', height: 1.5, width: 1.0, color: 0xbbbbbb,
        stageType: 'fuel', category: 'fuel',
    },
    TinyTank: {
        name: '迷你燃料箱', dryMass: 0.05, fuelCapacity: 500, thrust: 0, isp: 0,
        dragArea: 0.8, icon: '\u2500', height: 0.6, width: 0.8, color: 0xaaaaaa,
        stageType: 'fuel', category: 'fuel',
    },
    // 模板火箭(24t) TWR = 15MN/(24*9.81) = 63, 加速度 625m/s², 约4秒入轨
    LargeEngine: {
        name: '大型发动机', dryMass: 1.5, fuelCapacity: 0, thrust: 2000000, isp: 310,
        dragArea: 1.5, icon: '\u25BC', height: 1.0, width: 1.25, color: 0xff9800,
        stageType: 'engine', category: 'engines',
    },
    SmallEngine: {
        name: '小型发动机', dryMass: 0.5, fuelCapacity: 0, thrust: 600000, isp: 300,
        dragArea: 1.0, icon: '\u25BD', height: 0.6, width: 0.8, color: 0xffa726,
        stageType: 'engine', category: 'engines',
    },
    VacuumEngine: {
        name: '真空发动机', dryMass: 1.0, fuelCapacity: 0, thrust: 400000, isp: 390,
        dragArea: 1.2, icon: '\u25BD', height: 1.2, width: 1.0, color: 0x7e57c2,
        stageType: 'engine', category: 'engines',
    },
    SolidBooster: {
        name: '固体助推器', dryMass: 0.8, fuelCapacity: 4000, thrust: 1000000, isp: 250,
        dragArea: 1.5, icon: '\u25B2', height: 2.5, width: 0.75, color: 0xff5722,
        stageType: 'engine', category: 'engines',
    },
    Decoupler: {
        name: '分离器', dryMass: 0.05, fuelCapacity: 0, thrust: 0, isp: 0,
        dragArea: 2.0, icon: '\u2501', height: 0.15, width: 1.25, color: 0xffeb3b,
        stageType: 'decoupler', category: 'structural',
    },
    Parachute: {
        name: '降落伞', dryMass: 0.1, fuelCapacity: 0, thrust: 0, isp: 0,
        dragArea: 0.5, icon: '\u2602', height: 0.3, width: 0.8, color: 0xf44336,
        stageType: 'parachute', category: 'aero', deployedDragArea: 80.0,
    },
    Fairing: {
        name: '整流罩', dryMass: 0.2, fuelCapacity: 0, thrust: 0, isp: 0,
        dragArea: 0.3, icon: '\u25CB', height: 1.5, width: 1.3, color: 0xeeeeee,
        stageType: 'fairing', category: 'aero',
    },
    SolarPanel: {
        name: '太阳能板', dryMass: 0.05, fuelCapacity: 0, thrust: 0, isp: 0,
        dragArea: 1.0, icon: '\u25A0', height: 0.1, width: 1.5, color: 0x1a237e,
        stageType: 'utility', category: 'utility',
    },
    LandingLeg: {
        name: '着陆腿', dryMass: 0.05, fuelCapacity: 0, thrust: 0, isp: 0,
        dragArea: 0.3, icon: '\u251C', height: 0.3, width: 1.0, color: 0x757575,
        stageType: 'utility', category: 'utility',
    },
};

export const KEY_MAP = {
    THROTTLE_UP: 'ShiftLeft', THROTTLE_DOWN: 'ControlLeft',
    THROTTLE_MAX: 'KeyZ', THROTTLE_CUT: 'KeyX',
    PITCH_UP: 'KeyW', PITCH_DOWN: 'KeyS',
    YAW_LEFT: 'KeyA', YAW_RIGHT: 'KeyD',
    ROLL_LEFT: 'KeyQ', ROLL_RIGHT: 'KeyE',
    STAGE: 'Space', MAP_TOGGLE: 'KeyM', SAS_TOGGLE: 'KeyT',
    TIME_WARP_UP: 'Period', TIME_WARP_DOWN: 'Comma',
    PARACHUTE: 'KeyP', VIEW_TOGGLE: 'KeyV',
};
