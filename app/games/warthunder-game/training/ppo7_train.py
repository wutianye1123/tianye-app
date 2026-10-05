#!/usr/bin/env python3
# ppo7_train.py — 第七代 PPO 训练服务器（torch 2.14.1 autograd 重写）
# 协议与第六代 ppo_train.py 完全兼容（HTTP 拉模式，CORS 全开；默认端口 8771）：
#   POST /rollout ← 页面发 {win, tid[], obs[][], act[][], logp[], val[], rew[], done[], lastObsByTid{}}
#   GET  /weights → {W1,b1,W2,b2,W3,b3, logStd[4], norm{mu,sd}, gen, meta{headDim:6, actDim:5}}
#   GET  /gen     → {gen} 轻量轮询       GET /stats → 训练监控
# 第七代（第一课：端到端瞄准开火）：
#   动作 5 维 = [throttle, turn, aimYaw, aimPitch, fire]
#     · 前 4 维高斯：mean 来自头，σ=logStd 逐维可学习（驾驶上限 e^0.1≈1.11、瞄准上限 e^-1.9≈0.15——
#       瞄准是精确技能，探索噪声封死；驾驶允许大开大合）
#     · fire 伯努利：sigmoid 头，采样 0/1
#   头 256→6 = [mean×4, fireLogit, value]；trunk 70→256→256 从第五代 BC 权重热启动
# 混合损失（PPO+BC）：L = L_ppo + α·L_bc
#   L_bc = MSE(tanh(mean4), act4) + posW·BCE(fireLogit, fire)
#   锚数据 = data/ + data-dagger/ 共 ~9.5 万条旧样本（交战段过滤 obs[16]<0.65）
# 新奖励体系在页面侧归因（agent-rl7.js）：击杀+10/命中+2/被命中-2/阵亡-10/开火-0.05/
#   出环带[60,260]m -0.01/步 / 撞障(脱困触发)-0.5 / 干净接近 +0.01×Δdist/10 /
#   朝敌 +0.003×cos(朝敌角) / 绕圈罚 -0.03/步（4s 窗里程>15m 且净位移比<0.3 且窗口内未开火）
# PPO：GAE(γ=.99,λ=.95) + clip 0.2 + 熵 bonus + value loss，按 tid 分段，KL 早停，
#   首批 value 预热（loss 只含 vf+bc，不动 policy），grad clip 1.0
# 落盘：每次更新原子写 training/ppo7-weights-latest.json；每 10 update 滚动备份 ppo7-weights-g{N}.json
# 用法：python3 training/ppo7_train.py [port=8771] [--alpha 0.5] [--resume] [--batch 2048]
import json, os, http.server, threading, time, sys, glob, argparse
import numpy as np
import torch
import torch.nn.functional as F

torch.set_num_threads(4)   # 留核给农场窗口/用户游戏

BASE = os.path.dirname(os.path.abspath(__file__))
# obs 92 维（2026-10-05 感知扩容）：旧 70 维原样 + 障碍7~10号×3维 + 前10障碍半径×10维
OBS_DIM, H1, H2, HEAD = 92, 256, 256, 6          # head: [mean_thr, mean_turn, mean_yaw, mean_pitch, fireLogit, value]
OBS_DIM_OLD = 70                                 # BC 锚数据/旧 checkpoint 的输入维（pad 兼容）
ACT_DIM = 5                                        # [thr, turn, aimYaw, aimPitch, fire]
GAUSS_DIM = 4                                      # 前 4 维高斯，第 5 维伯努利
BATCH = 2048
EPOCHS, MINIB = 4, 256
CLIP, LR = 0.2, 1e-4
ENT_W, VF_W = 0.004, 0.25
GAMMA, LAM = 0.99, 0.95
KL_STOP = 0.05
GRAD_CLIP = 1.0
CKPT_EVERY = 10
LOGSTD_LO = np.array([-2.5, -2.5, -3.9, -3.9], dtype=np.float32)   # σ 下限（驾驶 0.08 / 瞄准 0.02）
LOGSTD_HI = np.array([0.1, 0.1, -3.2, -3.2], dtype=np.float32)     # σ 上限（驾驶 1.11 / 瞄准 0.04——0.15/0.06 实测炮塔追不上白拦收敛门）
LOGSTD_INIT = np.array([-0.3, -0.3, -3.2, -3.2], dtype=np.float32) # σ 起步（驾驶 0.74 / 瞄准 0.04）
FIRE_TEMP_A, FIRE_TEMP_B = 0.12, 0.6   # fire 伯努利对数尺度温度（试训#2 定位：BC 火头 logit mean=-27/p50=-15.7，
                                       # 固定偏置无法校准；q=sigmoid(a·f+b)：中位状态→0.22 好状态→0.58 差状态→≈0）。
                                       # 采样与 logp/熵同口径，梯度照常流经 f；部署不带温度（保守）+纪律兜底
BC_FILTER_DIST = 1.01     # BC 锚全量（2026-10-05 ②采样扩展配套：导航段网络接管后，
                          # 远距驾驶需要老师——规则 AI 开进数据本来就在 9.5 万条里；此前 0.65 只取交战段）

ap = argparse.ArgumentParser()
ap.add_argument('port', nargs='?', type=int, default=8771)
ap.add_argument('--alpha', type=float, default=0.5, help='BC 锚损失权重')
ap.add_argument('--resume', action='store_true', help='从 ppo7-weights-latest.json 恢复')
ap.add_argument('--batch', type=int, default=BATCH)
ap.add_argument('--lr', type=float, default=LR, help='学习率（续训建议 5e-5 治 KL 偏热）')
ap.add_argument('--keep-gen', action='store_true', help='resume 保留 gen 继续编（同语义续练用；'
                                                        '默认归零=语义变更基线重置）')
args = ap.parse_args()
BATCH = args.batch
LR = args.lr

# ---------- 网络：参数名与权重 json 逐键一致（JS 侧手写前向直接吃） ----------
class Net(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.W1 = torch.nn.Parameter(torch.zeros(OBS_DIM, H1))
        self.b1 = torch.nn.Parameter(torch.zeros(H1))
        self.W2 = torch.nn.Parameter(torch.zeros(H1, H2))
        self.b2 = torch.nn.Parameter(torch.zeros(H2))
        self.W3 = torch.nn.Parameter(torch.zeros(H2, HEAD))
        self.b3 = torch.nn.Parameter(torch.zeros(HEAD))
        self.logStd = torch.nn.Parameter(torch.zeros(GAUSS_DIM))

    def forward(self, x):
        h = F.relu(x @ self.W1 + self.b1)
        h = F.relu(h @ self.W2 + self.b2)
        out = h @ self.W3 + self.b3
        return out[:, :4], out[:, 4], out[:, 5]   # mean4, fireLogit, value

net = Net()
rng = np.random.default_rng(7)

def load_bc_warm_start():
    """trunk+驾驶/瞄准/开火头 ← 第五代 BC 权重；value 头小随机；norm 沿用。
    W1 为 70 行（旧 obs 维）→ 92 行网络：扩列零初始化（新感知从零学起）"""
    bc = json.load(open(os.path.join(BASE, 'bc-weights.json')))
    with torch.no_grad():
        tW1 = torch.tensor(bc['W1'], dtype=torch.float32)
        if tW1.shape[0] < OBS_DIM:                     # 70→92 扩列（新 22 行零初始化）
            pad = torch.zeros(OBS_DIM, H1)
            pad[:tW1.shape[0], :].copy_(tW1)
            tW1 = pad
        net.W1.copy_(tW1)
        net.b1.copy_(torch.tensor(bc['b1'], dtype=torch.float32))
        net.W2.copy_(torch.tensor(bc['W2'], dtype=torch.float32))
        net.b2.copy_(torch.tensor(bc['b2'], dtype=torch.float32))
        W3bc = torch.tensor(bc['W3'], dtype=torch.float32)          # 旧头 5 输出（已 40 epoch 训练）
        net.W3[:, 0:4].copy_(W3bc[:, 0:4])                          # mean×4 ← BC thr/turn/yaw/pitch 行
        net.W3[:, 4].copy_(W3bc[:, 4])                              # fireLogit ← BC fire 行（本就是 logit）
        net.W3[:, 5].copy_(torch.tensor(0.1 * rng.standard_normal(H2), dtype=torch.float32))
        net.b3[0:5].copy_(torch.tensor(bc['b3'], dtype=torch.float32)[0:5])
        net.b3[5].zero_()
        net.logStd.copy_(torch.tensor(LOGSTD_INIT))
    n = bc['norm']
    n = {'mu': n['mu'] + [0.0] * (OBS_DIM - OBS_DIM_OLD),        # 新维 mu=0 sd=1（标准化后原值不变）
         'sd': n['sd'] + [1.0] * (OBS_DIM - OBS_DIM_OLD)}
    return n

norm = load_bc_warm_start()
MU = np.array(norm['mu'], dtype=np.float32)
SD = np.array(norm['sd'], dtype=np.float32)

gen, updates, steps_total = 0, 0, 0
t0 = time.time()
first_batch_done = False
last_stats = {'rew': None, 'ent': None, 'kl': None, 'pclip': None, 'bc': None}   # None 而非 NaN（跨语言 JSON 坑）

if args.resume:
    p = os.path.join(BASE, 'ppo7-weights-latest.json')
    if os.path.exists(p):
        w = json.load(open(p))
        with torch.no_grad():
            for k in ('W1', 'b1', 'W2', 'b2', 'W3', 'b3', 'logStd'):
                t = torch.tensor(w[k], dtype=torch.float32)
                cur = getattr(net, k)          # 旧 70 维 checkpoint → 92 维网络：W1 扩列零初始化
                if t.shape != cur.shape and k == 'W1' and t.shape[1] == cur.shape[1] and t.shape[0] < cur.shape[0]:
                    pad = torch.zeros_like(cur); pad[:t.shape[0], :].copy_(t); t = pad
                    print(f'[PPO7] W1 {tuple(t.shape)}→{tuple(cur.shape)} 扩列热启动（新感知零初始化）', flush=True)
                getattr(net, k).copy_(t)
        # 语义变更（①避让折叠 ②导航采样 ③接近罚）→ 默认基线重置（gen 归零、曲线从头看）；
        # 同语义续练用 --keep-gen 保留 gen（且避免滚动备份 g{N} 覆盖上一轮文件）
        gen = w.get('gen', 0) if args.keep_gen else 0
        first_batch_done = True   # resume 时 value 头已训过，跳过首批预热
        print(f'[PPO7] resumed 权重自 gen{w.get("gen", 0)}（{"续编" if args.keep_gen else "基线重置→gen0"}, '
              f'lr={LR}, 预热跳过）', flush=True)
    else:
        print('[PPO7] --resume 但无 checkpoint，从 BC 热启动开始', flush=True)

opt = torch.optim.Adam(net.parameters(), lr=LR)

# ---------- BC 锚数据（9.5 万条旧样本，交战段过滤） ----------
def load_bc_anchor():
    obs_l, act_l = [], []
    for f in glob.glob(os.path.join(BASE, 'data', '*.jsonl')) + \
             glob.glob(os.path.join(BASE, 'data-dagger', '*.jsonl')):
        for line in open(f):
            try:
                d = json.loads(line)
                if len(d['obs']) == OBS_DIM_OLD and len(d['act']) == 5 and d['obs'][16] < BC_FILTER_DIST:
                    obs_l.append(d['obs']); act_l.append(d['act'])
            except Exception:
                pass
    obs = torch.tensor(np.array([o + [0.0] * (OBS_DIM - len(o)) for o in obs_l],   # 旧 70 维锚 pad 22 零
                                 dtype=np.float32))
    act = torch.tensor(np.array(act_l, dtype=np.float32))
    return obs, act

t_bc = time.time()
BC_obs, BC_act = load_bc_anchor()
fire_pos = float(BC_act[:, 4].mean())
BC_POSW = float(np.clip((1 - fire_pos) / max(fire_pos, 1e-4), 1.0, 20.0))
print(f'[PPO7] BC anchor: {len(BC_obs)} 条（交战段过滤后） fire+率={fire_pos:.3f} posW={BC_POSW:.1f} '
      f'加载 {time.time()-t_bc:.1f}s', flush=True)

def bc_loss_fn(mean4, fireLogit, actb):
    m = F.mse_loss(torch.tanh(mean4), actb[:, :4])
    b = F.binary_cross_entropy_with_logits(fireLogit, actb[:, 4], pos_weight=torch.tensor(BC_POSW))
    return m + b

# ---------- logp（与 agent-rl7.js 逐位一致） ----------
HALF_LOG_2PI = 0.5 * float(np.log(2 * np.pi))
def logp_all(mean4, fireLogit, act):
    """act: (N,5) 未截断原始采样 + fire∈{0,1} → (N,) 总 logp（含梯度的图由调用方控制）
    fire 与页面采样同口径：sigmoid(a·logit+b)（对数尺度温度探索）"""
    std = torch.exp(net.logStd)
    z = (act[:, :4] - mean4) / std
    lp_gauss = (-0.5 * z * z - net.logStd - HALF_LOG_2PI).sum(1)
    p = torch.sigmoid(FIRE_TEMP_A * fireLogit + FIRE_TEMP_B).clamp(1e-6, 1 - 1e-6)
    lp_fire = act[:, 4] * torch.log(p) + (1 - act[:, 4]) * torch.log(1 - p)
    return lp_gauss + lp_fire

def entropy_terms(fireLogit):
    ent_gauss = (net.logStd + HALF_LOG_2PI + 0.5).sum()          # 每维 0.5·log(2πe)
    p = torch.sigmoid(FIRE_TEMP_A * fireLogit + FIRE_TEMP_B).clamp(1e-6, 1 - 1e-6)
    ent_fire = (-(p * torch.log(p) + (1 - p) * torch.log(1 - p))).mean()
    return ent_gauss + ent_fire

# ---------- GAE（numpy，按 tid 分段 + lastObsByTid 引导） ----------
@torch.no_grad()
def values_of(obs_np):
    x = (torch.tensor(obs_np, dtype=torch.float32) - torch.tensor(MU)) / torch.tensor(SD)
    _, _, v = net(x)
    return v.numpy().astype(np.float32)

def gae(obs, rew, done, tid, last_obs_by_tid):
    vals_all = values_of(obs)
    segs = {}
    for i, t in enumerate(tid):
        segs.setdefault(t, []).append(i)
    N = len(obs)
    adv = np.zeros(N, dtype=np.float32)
    for t, idxs in segs.items():
        idxs = np.array(idxs)
        vals = vals_all[idxs]
        lo = last_obs_by_tid.get(t)
        v_last = float(values_of(np.array(lo, dtype=np.float32)[None, :])[0]) if lo is not None else 0.0
        vseq = np.append(vals, v_last)
        g = 0.0
        for k in range(len(idxs) - 1, -1, -1):
            d = done[idxs[k]]
            delta = rew[idxs[k]] + GAMMA * vseq[k + 1] * (1 - d) - vseq[k]
            g = delta + GAMMA * LAM * (1 - d) * g
            adv[idxs[k]] = g
    ret = adv + vals_all
    adv = (adv - adv.mean()) / (adv.std() + 1e-6)
    return adv.astype(np.float32), ret.astype(np.float32)

# ---------- PPO+BC 更新 ----------
lock = threading.Lock()
_bc_mu_t = torch.tensor(MU); _bc_sd_t = torch.tensor(SD)
def bc_norm(x):
    return (x - _bc_mu_t) / _bc_sd_t

def update(obs_np, act_np, logp_old_np, rew_np, done_np, tid, last_obs_by_tid):
    global gen, updates, steps_total, last_stats, first_batch_done
    N = len(obs_np)
    adv, ret = gae(obs_np, rew_np, done_np, tid, last_obs_by_tid)
    obs_t = torch.tensor(obs_np, dtype=torch.float32)
    obs_n = (obs_t - torch.tensor(MU)) / torch.tensor(SD)
    act_t = torch.tensor(act_np, dtype=torch.float32)
    logp_old_t = torch.tensor(logp_old_np, dtype=torch.float32)
    adv_t = torch.tensor(adv)
    ret_t = torch.tensor(ret)
    bc_n = len(BC_obs)

    value_only = not first_batch_done
    idx_all = np.arange(N)
    pclip_cnt = 0.0
    kl = 0.0
    bc_l = 0.0
    for ep in range(EPOCHS):
        rng.shuffle(idx_all)
        for s in range(0, N, MINIB):
            idx = torch.tensor(idx_all[s:s + MINIB])
            xb, ab, lb = obs_n[idx], act_t[idx], logp_old_t[idx]
            avb, rb = adv_t[idx], ret_t[idx]
            mean4, flogit, value = net(xb)
            if value_only:
                # 首批预热：只拟合 value（vf+bc 不含 policy 项，logStd/policy 头零梯度）
                loss = VF_W * F.mse_loss(value, rb)
                bidx = torch.from_numpy(rng.integers(0, bc_n, len(idx)))
                bm4, bf, _ = net(bc_norm(BC_obs[bidx]))
                loss = loss + args.alpha * bc_loss_fn(bm4, bf, BC_act[bidx])
            else:
                lp = logp_all(mean4, flogit, ab)
                ratio = torch.exp(torch.clamp(lp - lb, -10, 10))
                clipped = (ratio > 1 + CLIP) | (ratio < 1 - CLIP)
                with torch.no_grad():
                    pclip_cnt += float(clipped.float().mean()) * len(idx) / N / EPOCHS
                surr = torch.minimum(ratio * avb, torch.clamp(ratio, 1 - CLIP, 1 + CLIP) * avb)
                loss = -surr.mean() + VF_W * F.mse_loss(value, rb) - ENT_W * entropy_terms(flogit)
                bidx = torch.from_numpy(rng.integers(0, bc_n, len(idx)))
                bm4, bf, _ = net(bc_norm(BC_obs[bidx]))
                bl = bc_loss_fn(bm4, bf, BC_act[bidx])
                loss = loss + args.alpha * bl
                bc_l = float(bl)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), GRAD_CLIP)
            opt.step()
            with torch.no_grad():
                net.logStd.clamp_(min=torch.tensor(LOGSTD_LO), max=torch.tensor(LOGSTD_HI))
        # —— KL 早停（k3 无偏估计，512 子样本） ——
        if not value_only:
            sub = torch.tensor(idx_all[:512])
            with torch.no_grad():
                m4, fl, _ = net(obs_n[sub])
                kl = float((torch.exp(d := (logp_all(m4, fl, act_t[sub]) - logp_old_t[sub])) - 1 - d).mean())
            if kl > KL_STOP and ep < EPOCHS - 1:
                print(f'[PPO7] kl={kl:.4f} > {KL_STOP} @epoch{ep} → early stop', flush=True)
                break
    first_batch_done = True
    with torch.no_grad():
        ent = float(entropy_terms(net(obs_n[:256])[1]))
    updates += 1
    gen += 1
    steps_total += N
    last_stats = {'rew': float(rew_np.mean()), 'ent': ent, 'kl': kl,
                  'pclip': pclip_cnt, 'bc': bc_l, 'updates': updates}
    if not all(v == v for v in last_stats.values() if v is not None and isinstance(v, float)):
        last_stats = {k: (v if (v is None or v == v) else None) for k, v in last_stats.items()}
    print(f'[PPO7] update#{updates} gen={gen} steps={N} total={steps_total} '
          f'mean_rew={last_stats["rew"]:+.3f} ent={ent:.2f} kl={kl:.4f} '
          f'pclip={pclip_cnt*100:.1f}% bc={bc_l:.4f} σ={[f"{x:.2f}" for x in torch.exp(net.logStd).tolist()]} '
          f'age={time.time()-t0:.0f}s', flush=True)
    save_checkpoint()

def weights_payload():
    with torch.no_grad():
        d = {k: getattr(net, k).numpy().tolist() for k in ('W1', 'b1', 'W2', 'b2', 'W3', 'b3', 'logStd')}
        d.update({'norm': {'mu': MU.tolist(), 'sd': SD.tolist()}, 'gen': gen,
                  'meta': {'obsDim': OBS_DIM, 'headDim': HEAD, 'actDim': ACT_DIM,
                           'gaussDim': GAUSS_DIM, 'updates': updates, 'steps': steps_total}})
        return d

def save_checkpoint():
    with lock:
        payload = weights_payload()
    flat = []
    for k2 in ('W1', 'b1', 'W2', 'b2', 'W3', 'b3', 'logStd'):
        x = payload[k2]
        flat.extend(x if not isinstance(x[0], list) else [i for row in x for i in row])
    if not all(np.isfinite(flat)):
        print('[PPO7] ⚠️ 权重含 NaN/Inf，跳过本次落盘（保留上一版）', flush=True)
        return
    tmp = os.path.join(BASE, 'ppo7-weights-latest.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(payload, f)
    os.replace(tmp, os.path.join(BASE, 'ppo7-weights-latest.json'))
    if updates > 0 and updates % CKPT_EVERY == 0:
        with open(os.path.join(BASE, f'ppo7-weights-g{gen}.json'), 'w') as f:
            json.dump(payload, f)

# ---------- rollout buffer ----------
buf = {'obs': [], 'act': [], 'logp': [], 'val': [], 'rew': [], 'done': [], 'tid': [], 'lastObsByTid': {}}
updating = False

def maybe_update():
    global buf, updating
    with lock:
        if len(buf['obs']) < BATCH or updating:
            return
        updating = True
        snap = {k: buf[k] for k in ('obs', 'act', 'logp', 'val', 'rew', 'done', 'tid')}
        snap['lastObsByTid'] = dict(buf['lastObsByTid'])
        buf = {k: ([] if k != 'lastObsByTid' else {}) for k in
               ('obs', 'act', 'logp', 'val', 'rew', 'done', 'tid', 'lastObsByTid')}
    def run():
        global updating
        try:
            update(np.array(snap['obs'], dtype=np.float32),
                   np.array(snap['act'], dtype=np.float32),
                   np.array(snap['logp'], dtype=np.float32),
                   np.array(snap['rew'], dtype=np.float32),
                   np.array(snap['done'], dtype=np.float32),
                   snap['tid'], snap['lastObsByTid'])
        except Exception as e:
            print(f'[PPO7] UPDATE ERROR: {e}', flush=True)
            import traceback; traceback.print_exc()
        finally:
            with lock:
                updating = False
            maybe_update()
    threading.Thread(target=run, daemon=True).start()

# ---------- HTTP 服务（同第六代：CORS 全开 / NaN 不出网） ----------
CORS = [('Access-Control-Allow-Origin', '*'),
        ('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'),
        ('Access-Control-Allow-Headers', 'Content-Type')]

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _cors(self):
        for k, v in CORS: self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        if self.path != '/rollout': self.send_error(404); return
        n = int(self.headers.get('Content-Length', 0))
        try:
            d = json.loads(self.rfile.read(n))
        except Exception as e:
            self.send_error(400, f'bad json: {e}'); return
        with lock:
            k = len(buf['obs'])
            buf['obs'] += d['obs']; buf['act'] += d['act']; buf['logp'] += d['logp']
            buf['val'] += d['val']; buf['rew'] += d['rew']; buf['done'] += d['done']
            buf['tid'] += d.get('tid') or [f"{d.get('win', 'w')}-0"] * (len(d['obs']) - k)
            if isinstance(d.get('lastObsByTid'), dict):
                buf['lastObsByTid'].update({str(k2): v for k2, v in d['lastObsByTid'].items()})
        body = json.dumps({'gen': gen, 'ok': True, 'buffered': len(buf['obs'])}).encode()
        self.send_response(200); self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)
        maybe_update()

    def do_GET(self):
        if self.path == '/gen' or self.path == '/stats':
            with lock:
                payload = {'gen': gen, 'updates': updates, 'buffered': len(buf['obs']),
                           'steps_total': steps_total, 'wall_s': round(time.time() - t0, 1),
                           'updating': updating, 'last_stats': last_stats}
            body = json.dumps(payload).encode()
            self.send_response(200); self._cors()
        elif self.path == '/weights':
            with lock:
                payload = weights_payload()
            body = json.dumps(payload).encode()
            self.send_response(200); self._cors()
        else:
            self.send_error(404); return
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)

if __name__ == '__main__':
    save_checkpoint()   # 启动即存一版（gen0 = BC 热启动状态，冒烟用）
    print(f'[PPO7] server on :{args.port}  (torch autograd, BC 锚 {len(BC_obs)} 条, α={args.alpha}, '
          f'batch={BATCH}, checkpoint=ppo7-weights-latest.json)', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', args.port), H).serve_forever()
