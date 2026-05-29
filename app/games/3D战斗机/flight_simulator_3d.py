"""
3D Flight Simulator - True 3D Version
使用纯Pygame实现的真正3D飞行模拟器
"""

import pygame
import math
import random
import sys

# 初始化Pygame
pygame.init()

# 游戏常量
SCREEN_WIDTH = 1024
SCREEN_HEIGHT = 768
FPS = 60

# 颜色定义
SKY_BLUE = (135, 206, 235)
DARK_BLUE = (25, 25, 112)
GROUND_GREEN = (34, 139, 34)
MOUNTAIN_BROWN = (139, 69, 19)
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
RED = (255, 0, 0)
HUD_COLOR = (0, 255, 0)
CLOUD_COLOR = (240, 240, 250)

def rotate_x(point, angle):
    """绕X轴旋转"""
    x, y, z = point
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    return (x, y * cos_a - z * sin_a, y * sin_a + z * cos_a)

def rotate_y(point, angle):
    """绕Y轴旋转"""
    x, y, z = point
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    return (x * cos_a + z * sin_a, y, -x * sin_a + z * cos_a)

def rotate_z(point, angle):
    """绕Z轴旋转"""
    x, y, z = point
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    return (x * cos_a - y * sin_a, x * sin_a + y * cos_a, z)

def project_3d_to_2d(x, y, z, camera):
    """3D坐标投影到2D屏幕"""
    # 相对相机的坐标
    rel_x = x - camera.x
    rel_y = y - camera.y
    rel_z = z - camera.z

    # 应用相机旋转
    point = (rel_x, rel_y, rel_z)
    point = rotate_y(point, -camera.yaw)
    point = rotate_x(point, -camera.pitch)
    point = rotate_z(point, -camera.roll)
    x_rot, y_rot, z_rot = point

    # 透视投影
    if z_rot <= 10:
        return None

    fov = 500
    screen_x = SCREEN_WIDTH // 2 + int((x_rot * fov) / z_rot)
    screen_y = SCREEN_HEIGHT // 2 - int((y_rot * fov) / z_rot)

    return (screen_x, screen_y, z_rot)

def calculate_normal(v1, v2, v3):
    """计算三角形法向量"""
    # 边向量
    edge1 = (v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2])
    edge2 = (v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2])

    # 叉积
    nx = edge1[1] * edge2[2] - edge1[2] * edge2[1]
    ny = edge1[2] * edge2[0] - edge1[0] * edge2[2]
    nz = edge1[0] * edge2[1] - edge1[1] * edge2[0]

    # 归一化
    length = math.sqrt(nx*nx + ny*ny + nz*nz)
    if length == 0:
        return (0, 1, 0)
    return (nx/length, ny/length, nz/length)

def calculate_lighting(normal, light_dir=(0.5, -1, -0.5)):
    """计算光照强度"""
    # 光照方向归一化
    light_len = math.sqrt(light_dir[0]**2 + light_dir[1]**2 + light_dir[2]**2)
    light_dir = (light_dir[0]/light_len, light_dir[1]/light_len, light_dir[2]/light_len)

    # 点积计算光照
    dot = normal[0] * light_dir[0] + normal[1] * light_dir[1] + normal[2] * light_dir[2]
    intensity = max(0.3, min(1, -dot + 0.3))  # 基础环境光0.3

    return intensity

class Camera:
    """相机类"""
    def __init__(self):
        self.x = 0
        self.y = 500
        self.z = 0
        self.pitch = 0  # 俯仰角
        self.roll = 0   # 翻滚角
        self.yaw = 0    # 偏航角

class Terrain3D:
    """3D地形类"""
    def __init__(self):
        self.mountains = []
        # 生成3D山脉
        for i in range(50):
            x = random.randint(-5000, 5000)
            z = random.randint(-5000, 5000)
            height = random.randint(200, 600)
            width = random.randint(150, 400)
            depth = random.randint(150, 400)
            self.mountains.append((x, height, z, width, depth))

    def draw(self, screen, camera):
        """绘制3D地形"""
        # 绘制地平线和天空
        horizon_y = SCREEN_HEIGHT // 2 - int(camera.pitch * 50)
        horizon_y = max(0, min(SCREEN_HEIGHT, horizon_y))

        # 天空渐变
        for y in range(horizon_y):
            ratio = y / horizon_y if horizon_y > 0 else 0
            r = int(SKY_BLUE[0] * (1 - ratio) + DARK_BLUE[0] * ratio)
            g = int(SKY_BLUE[1] * (1 - ratio) + DARK_BLUE[1] * ratio)
            b = int(SKY_BLUE[2] * (1 - ratio) + DARK_BLUE[2] * ratio)
            pygame.draw.line(screen, (r, g, b), (0, y), (SCREEN_WIDTH, y))

        # 地面
        pygame.draw.rect(screen, GROUND_GREEN, (0, horizon_y, SCREEN_WIDTH, SCREEN_HEIGHT - horizon_y))

        # 绘制3D山脉
        mountains_to_draw = []

        for mx, mheight, mz, mwidth, mdepth in self.mountains:
            # 计算山脉中心到相机的距离
            dist = math.sqrt((mx - camera.x)**2 + (mz - camera.z)**2)
            if dist < 3000:  # 只绘制可见范围
                mountains_to_draw.append((dist, mx, mheight, mz, mwidth, mdepth))

        # 按距离排序（远的先画）
        mountains_to_draw.sort(key=lambda x: x[0], reverse=True)

        for dist, mx, mheight, mz, mwidth, mdepth in mountains_to_draw:
            # 金字塔的4个面
            base_y = 0
            apex = (mx, mheight, mz)

            # 底面四个角
            corners = [
                (mx - mwidth//2, base_y, mz - mdepth//2),
                (mx + mwidth//2, base_y, mz - mdepth//2),
                (mx + mwidth//2, base_y, mz + mdepth//2),
                (mx - mwidth//2, base_y, mz + mdepth//2),
            ]

            # 绘制4个三角形面
            for i in range(4):
                v1 = apex
                v2 = corners[i]
                v3 = corners[(i + 1) % 4]

                # 投影三个顶点
                p1 = project_3d_to_2d(v1[0], v1[1], v1[2], camera)
                p2 = project_3d_to_2d(v2[0], v2[1], v2[2], camera)
                p3 = project_3d_to_2d(v3[0], v3[1], v3[2], camera)

                if p1 and p2 and p3:
                    # 计算光照
                    normal = calculate_normal(v1, v2, v3)
                    intensity = calculate_lighting(normal)

                    # 调整颜色亮度
                    color = (
                        int(MOUNTAIN_BROWN[0] * intensity),
                        int(MOUNTAIN_BROWN[1] * intensity),
                        int(MOUNTAIN_BROWN[2] * intensity)
                    )

                    # 绘制三角形
                    points = [(p1[0], p1[1]), (p2[0], p2[1]), (p3[0], p3[1])]
                    pygame.draw.polygon(screen, color, points)

class Cloud3D:
    """3D云朵类"""
    def __init__(self):
        self.reset()

    def reset(self):
        self.x = random.randint(-5000, 5000)
        self.y = random.randint(600, 1200)
        self.z = random.randint(-5000, 5000)
        self.size = random.randint(80, 200)
        self.spheres = []
        # 云由多个球体组成
        num_spheres = random.randint(3, 6)
        for _ in range(num_spheres):
            offset_x = random.randint(-self.size//2, self.size//2)
            offset_y = random.randint(-self.size//4, self.size//4)
            offset_z = random.randint(-self.size//2, self.size//2)
            sphere_size = random.randint(self.size//3, self.size//2)
            self.spheres.append((offset_x, offset_y, offset_z, sphere_size))

    def draw(self, screen, camera):
        # 检查是否在视野内
        dist = math.sqrt((self.x - camera.x)**2 + (self.z - camera.z)**2)
        if dist > 3000:
            return

        # 绘制云朵的每个球体
        for ox, oy, oz, size in self.spheres:
            world_x = self.x + ox
            world_y = self.y + oy
            world_z = self.z + oz

            proj = project_3d_to_2d(world_x, world_y, world_z, camera)
            if proj:
                sx, sy, sz = proj
                if sz > 0:
                    screen_size = int((size * 500) / sz)
                    if screen_size > 0:
                        # 绘制椭圆代表球体
                        rect = pygame.Rect(
                            sx - screen_size//2,
                            sy - screen_size//4,
                            screen_size,
                            screen_size//2
                        )
                        pygame.draw.ellipse(screen, CLOUD_COLOR, rect)

class Aircraft3D:
    """3D飞机类"""
    def __init__(self):
        self.x = 0
        self.y = 500
        self.z = 0
        self.speed = 10
        self.velocity_x = 0
        self.velocity_y = 0
        self.velocity_z = 0
        self.roll = 0  # 翻滚角
        self.pitch = 0  # 俯仰角

        # 3D飞机模型（顶点）
        self.vertices = [
            # 机身
            (0, 0, 30),      # 机头
            (0, 10, -20),    # 机身上
            (0, -10, -20),   # 机身下
            # 主翼
            (-50, 0, 0),     # 左翼尖
            (50, 0, 0),      # 右翼尖
            # 尾翼
            (0, 25, -25),    # 垂尾上
            (0, 0, -25),     # 垂尾中
            (-20, 0, -20),   # 左水平尾翼
            (20, 0, -20),    # 右水平尾翼
        ]

        # 面（三角形索引）
        self.faces = [
            # 机身
            (0, 1, 2),
            # 主翼
            (0, 3, 1),
            (0, 4, 2),
            # 垂直尾翼
            (5, 6, 2),
            # 水平尾翼
            (7, 6, 2),
            (8, 2, 6),
        ]

    def update(self, keys):
        """更新飞机位置"""
        acceleration = 0.5
        friction = 0.95

        # 方向控制
        if keys[pygame.K_w]:  # 上升
            self.velocity_y += acceleration
            self.pitch = min(0.3, self.pitch + 0.02)
        if keys[pygame.K_s]:  # 下降
            self.velocity_y -= acceleration
            self.pitch = max(-0.3, self.pitch - 0.02)
        if keys[pygame.K_a]:  # 向左
            self.velocity_x -= acceleration
            self.roll = max(-0.5, self.roll - 0.03)
        if keys[pygame.K_d]:  # 向右
            self.velocity_x += acceleration
            self.roll = min(0.5, self.roll + 0.03)
        if keys[pygame.K_UP]:  # 加速
            self.speed = min(30, self.speed + 0.5)
        if keys[pygame.K_DOWN]:  # 减速
            self.speed = max(5, self.speed - 0.5)

        # 自动回正
        if not keys[pygame.K_a] and not keys[pygame.K_d]:
            self.roll *= 0.9
        if not keys[pygame.K_w] and not keys[pygame.K_s]:
            self.pitch *= 0.9

        # 应用速度
        self.x += self.velocity_x
        self.y += self.velocity_y

        # 摩擦力
        self.velocity_x *= friction
        self.velocity_y *= friction

        # 向前移动
        self.z += self.speed

        # 限制高度
        if self.y < 100:
            self.y = 100
            self.velocity_y = 0
        if self.y > 2000:
            self.y = 2000
            self.velocity_y = 0

    def draw(self, screen, camera):
        """绘制3D飞机模型"""
        # 飞机在相机前方固定位置（第三人称视角）
        aircraft_cam_x = camera.x
        aircraft_cam_y = camera.y
        aircraft_cam_z = camera.z - 150  # 飞机在相机前方150单位

        # 变换后的顶点
        transformed_vertices = []

        for vx, vy, vz in self.vertices:
            # 应用飞机的旋转
            point = (vx, vy, vz)
            point = rotate_x(point, self.pitch)
            point = rotate_z(point, self.roll)
            tx, ty, tz = point

            # 世界坐标
            world_x = aircraft_cam_x + tx
            world_y = aircraft_cam_y + ty
            world_z = aircraft_cam_z + tz

            transformed_vertices.append((world_x, world_y, world_z))

        # 绘制面
        face_colors = [
            (200, 200, 200),  # 机身 - 浅灰
            (180, 50, 50),    # 主翼 - 红
            (180, 50, 50),
            (50, 50, 180),    # 尾翼 - 蓝
            (180, 180, 180),  # 水平尾翼 - 灰
            (180, 180, 180),
        ]

        for i, face in enumerate(self.faces):
            v1 = transformed_vertices[face[0]]
            v2 = transformed_vertices[face[1]]
            v3 = transformed_vertices[face[2]]

            # 投影到屏幕
            p1 = project_3d_to_2d(v1[0], v1[1], v1[2], camera)
            p2 = project_3d_to_2d(v2[0], v2[1], v2[2], camera)
            p3 = project_3d_to_2d(v3[0], v3[1], v3[2], camera)

            if p1 and p2 and p3:
                # 计算光照
                normal = calculate_normal(v1, v2, v3)
                intensity = calculate_lighting(normal)

                # 调整颜色
                base_color = face_colors[i]
                color = (
                    int(base_color[0] * intensity),
                    int(base_color[1] * intensity),
                    int(base_color[2] * intensity)
                )

                # 绘制三角形
                points = [(p1[0], p1[1]), (p2[0], p2[1]), (p3[0], p3[1])]
                pygame.draw.polygon(screen, color, points)
                pygame.draw.polygon(screen, BLACK, points, 1)  # 边框

    def draw_crosshair(self, screen):
        """绘制十字准星"""
        center_x = SCREEN_WIDTH // 2
        center_y = SCREEN_HEIGHT // 2
        size = 20

        pygame.draw.line(screen, WHITE, (center_x - size, center_y), (center_x + size, center_y), 2)
        pygame.draw.line(screen, WHITE, (center_x, center_y - size), (center_x, center_y + size), 2)

class HUD:
    """平视显示器类"""
    def __init__(self):
        self.font = pygame.font.Font(None, 36)
        self.small_font = pygame.font.Font(None, 24)

    def draw(self, screen, aircraft):
        """绘制HUD信息"""
        # 速度
        speed_text = self.font.render(f"速度: {aircraft.speed:.1f}", True, HUD_COLOR)
        screen.blit(speed_text, (20, 20))

        # 高度
        altitude_text = self.font.render(f"高度: {aircraft.y:.1f}m", True, HUD_COLOR)
        screen.blit(altitude_text, (20, 60))

        # 坐标
        pos_text = self.small_font.render(f"X: {aircraft.x:.1f}  Z: {aircraft.z:.1f}", True, HUD_COLOR)
        screen.blit(pos_text, (20, 110))

        # 控制说明
        controls = [
            "控制:",
            "W/S: 上升/下降",
            "A/D: 左/右",
            "↑/↓: 加速/减速",
            "ESC: 退出"
        ]

        y_offset = SCREEN_HEIGHT - 150
        for line in controls:
            text = self.small_font.render(line, True, HUD_COLOR)
            screen.blit(text, (20, y_offset))
            y_offset += 25

class Game:
    """游戏主类"""
    def __init__(self):
        self.screen = pygame.display.set_mode((SCREEN_WIDTH, SCREEN_HEIGHT))
        pygame.display.set_caption("3D飞行模拟器 - True 3D Version")
        self.clock = pygame.time.Clock()
        self.running = True

        self.camera = Camera()
        self.terrain = Terrain3D()
        self.aircraft = Aircraft3D()
        self.hud = HUD()

        # 创建云朵
        self.clouds = [Cloud3D() for _ in range(30)]

    def handle_events(self):
        """处理事件"""
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    self.running = False

    def update(self):
        """更新游戏状态"""
        keys = pygame.key.get_pressed()
        self.aircraft.update(keys)

        # 更新相机位置（跟随飞机）
        self.camera.x = self.aircraft.x
        self.camera.y = self.aircraft.y
        self.camera.z = self.aircraft.z - 100
        self.camera.pitch = self.aircraft.pitch
        self.camera.roll = self.aircraft.roll

        # 更新云朵位置
        for cloud in self.clouds:
            if cloud.z < self.aircraft.z - 2000:
                cloud.reset()
                cloud.z = self.aircraft.z + random.randint(2000, 6000)

    def draw(self):
        """绘制游戏画面"""
        self.screen.fill(BLACK)

        # 绘制地形
        self.terrain.draw(self.screen, self.camera)

        # 绘制云朵
        for cloud in self.clouds:
            cloud.draw(self.screen, self.camera)

        # 绘制飞机
        self.aircraft.draw(self.screen, self.camera)

        # 绘制十字准星
        self.aircraft.draw_crosshair(self.screen)

        # 绘制HUD
        self.hud.draw(self.screen, self.aircraft)

        pygame.display.flip()

    def run(self):
        """运行游戏主循环"""
        while self.running:
            self.handle_events()
            self.update()
            self.draw()
            self.clock.tick(FPS)

        pygame.quit()
        sys.exit()

if __name__ == "__main__":
    game = Game()
    game.run()
