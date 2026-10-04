#!/usr/bin/env python3
# ppo_train.py — PPO 训练服务器（纯 numpy，无 torch 依赖）
# 协议（HTTP 拉模式，CORS 全开）：
#   POST /rollout  ← 页面发 {win, tid[], obs[][], act[][], logp[], val[], rew[], done[], lastObsByTid{}}
#         tid = 每步所属坦克实例 id（同 id 步序连续成段；lastObsByTid = 未完段的引导观测）
#   GET  /weights  → 页面拉最新权重 {W1,b1,W2,b2,W3,b3, logStd[], norm{mu,sd}, gen}
#   GET  /gen      → {gen} 轻量轮询（gen 不变不拉大权重）
#   GET  /stats    → 训练监控 {gen, updates, buffered, steps_total, last_stats, wall_s}
# 网络：BC trunk(70→256→256, 热启动) + 新头 256→3 [mean_thr, mean_turn, value]
#   （第六代聚焦驾驶：throttle/turn 由 PPO 学，瞄准/开火/维护沿用第五代部署外壳）
# PPO：GAE(γ=.99,λ=.95) + clip 0.2 + entropy bonus + value loss，minibatch 更新，按 tid 分段算 GAE
# 落盘：每次更新后原子写 training/ppo-weights-latest.json（Ctrl-C / 时间熔断后取此文件评测）
import json, os, http.server, threading, time, sys
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
OBS_DIM, H1, H2, HEAD = 70, 256, 256, 3          # head: [mean_thr, mean_turn, value]
ACT_DIM = 2                                       # 第六代只训驾驶两维
BATCH = 2048                                      # 攒够多少步做一次 PPO 更新
EPOCHS, MINIB = 4, 64
CLIP, LR = 0.2, 5e-5      # 第二轮：1e-4→5e-5（首训末期 KL 冲 0.27，步子太大）
ENT_W, VF_W = 0.01, 0.25
GAMMA, LAM = 0.99, 0.95
KL_STOP = 0.05            # 每 epoch 估计 KL，超阈值早停（防策略一步迈太大）
LOGSTD_MAX = 0.1          # 第二轮：σ 上限收紧（e^0.1≈1.11，防探索噪声漂大稀释策略）
CKPT_EVERY = 10           # 每 10 个 update 存一版滚动备份（ppo-weights-g{N}.json，可回滚）

rng = np.random.default_rng(7)

# ---------- 网络（trunk 从 BC 热启动，mean 行沿用 BC 对应行，value 行小随机） ----------
bc = json.load(open(os.path.join(BASE, 'bc-weights.json')))
W1 = np.array(bc['W1'], dtype=np.float32); b1 = np.array(bc['b1'], dtype=np.float32)
W2 = np.array(bc['W2'], dtype=np.float32); b2 = np.array(bc['b2'], dtype=np.float32)
W3bc = np.array(bc['W3'], dtype=np.float32)                      # 旧头 5 输出
W3 = 0.1 * rng.standard_normal((H2, HEAD), dtype=np.float32)     # 新头 3 输出
W3[:, 0] = W3bc[:, 0]                                            # mean_thr ← BC throttle 行
W3[:, 1] = W3bc[:, 1]                                            # mean_turn ← BC turn 行
b3 = np.zeros(HEAD, dtype=np.float32)
logStd = np.full(ACT_DIM, -0.3, dtype=np.float32)                # σ≈0.74 起步（可学习）
MU, SD = np.array(bc['norm']['mu'], dtype=np.float32), np.array(bc['norm']['sd'], dtype=np.float32)
lock = threading.Lock()
gen = 0
updates = 0
steps_total = 0
t0 = time.time()

params = lambda: {'W1': W1, 'b1': b1, 'W2': W2, 'b2': b2, 'W3': W3, 'b3': b3}
adam_m = {k: np.zeros_like(v) for k, v in params().items()}
adam_v = {k: np.zeros_like(v) for k, v in params().items()}
LOGSTD_ADAM = {'m': np.zeros(ACT_DIM, dtype=np.float32), 'v': np.zeros(ACT_DIM, dtype=np.float32)}

def fwd(x):
    h1 = np.maximum(x @ W1 + b1, 0)
    h2 = np.maximum(h1 @ W2 + b2, 0)
    return h1, h2, h2 @ W3 + b3          # out: [mean0, mean1, value]

def entropy(logS):
    return float((logS + 0.5 * np.log(2 * np.pi * np.e)).sum())

last_stats = {'rew': None, 'ent': None, 'kl': None, 'pclip': None}   # None 而非 NaN：json.dumps 会把 NaN 写成裸标识符，JS JSON.parse 拒收
first_batch_done = False

def gae_and_update(obs, act, logp_old, rew, done, tid, last_obs_by_tid):
    """obs/act/...: 定长数组；tid: 每步的坦克 id（同 id 时间连续）；按段算 GAE 再整体 PPO 更新"""
    global W1, b1, W2, b2, W3, b3, logStd, updates, gen, steps_total, last_stats, first_batch_done
    N = len(obs)
    with lock:
        _, _, o = fwd(obs)
        vals_all = o[:, 2]
        # —— 按 tid 分段（段内时间连续；跨 POST 的未完段用 lastObsByTid 引导） ——
        segs = {}                            # tid -> [idx]
        for i, t in enumerate(tid):
            segs.setdefault(t, []).append(i)
        adv = np.zeros(N, dtype=np.float32)
        for t, idxs in segs.items():
            idxs = np.array(idxs)
            vals = vals_all[idxs]
            lo = last_obs_by_tid.get(t)
            v_last = float(fwd(np.array(lo, dtype=np.float32)[None, :])[2][0, 2]) if lo is not None else 0.0
            vseq = np.append(vals, v_last)
            g = 0.0
            for k in range(len(idxs) - 1, -1, -1):
                d = done[idxs[k]]
                nextv = vseq[k + 1] * (1 - d)
                delta = rew[idxs[k]] + GAMMA * nextv - vseq[k]
                g = delta + GAMMA * LAM * (1 - d) * g
                adv[idxs[k]] = g
        ret = adv + vals_all
        adv = (adv - adv.mean()) / (adv.std() + 1e-6)   # 优势归一化（epoch 前做）
        old_means = (np.maximum(np.maximum(obs @ W1 + b1, 0) @ W2 + b2, 0) @ W3 + b3)[:, :2].copy()

    # —— PPO epochs（更新期间不持锁时间过长：权重写入时再拿锁） ——
    idx_all = np.arange(N)
    pclip_cnt = 0.0
    t_step0 = updates * EPOCHS * max(1, N // MINIB)
    global first_batch_done
    value_only = not first_batch_done
    for ep in range(EPOCHS):
        rng.shuffle(idx_all)
        for s in range(0, N, MINIB):
            idx = idx_all[s:s + MINIB]
            with lock:
                xb, ab, lb, abv, rb = obs[idx], act[idx], logp_old[idx], adv[idx], ret[idx]
                h1b = np.maximum(xb @ W1 + b1, 0)
                h2b = np.maximum(h1b @ W2 + b2, 0)
                out = h2b @ W3 + b3
                mean_b, val_b = out[:, :2], out[:, 2]
                std = np.exp(logStd)

            if value_only:
                # 首批预热：只拟合 value 头（冻结 trunk 与 policy 列）——
                # value 随机初始化残差巨大，直接联合更新会冲垮 BC 热启动的驾驶头
                d_out = np.zeros((len(xb), HEAD), dtype=np.float32)
                d_out[:, 2] = VF_W * 2 * (val_b - rb)
                dW3 = np.zeros_like(W3); dW3[:, 2] = (h2b.T @ d_out / len(xb))[:, 2]
                db3 = np.zeros_like(b3); db3[2] = d_out.mean(0)[2]
                g = {'W1': np.zeros_like(W1), 'b1': np.zeros_like(b1),
                     'W2': np.zeros_like(W2), 'b2': np.zeros_like(b2), 'W3': dW3, 'b3': db3}
                t_step = t_step0 + ep * max(1, N // MINIB) + s // MINIB + 1
                with lock:
                    P = params()
                    for k in P:
                        adam_m[k] = 0.9 * adam_m[k] + 0.1 * g[k]
                        adam_v[k] = 0.999 * adam_v[k] + 0.001 * g[k] ** 2
                        mh = adam_m[k] / (1 - 0.9 ** t_step); vh = adam_v[k] / (1 - 0.999 ** t_step)
                        P[k] -= LR * 4 * mh / (np.sqrt(vh) + 1e-8)   # 预热提速 4×（只动 value 头，安全）
                continue

            z = (ab - mean_b) / std
            logp = (-0.5 * z ** 2 - logStd - 0.5 * np.log(2 * np.pi)).sum(1)
            ent = (logStd + 0.5 * np.log(2 * np.pi * np.e)).sum()

            ratio = np.exp(np.clip(logp - lb, -10, 10))
            clipped = (ratio > 1 + CLIP) | (ratio < 1 - CLIP)
            pclip_cnt += float(clipped.mean()) * len(idx) / N / EPOCHS
            surr = np.minimum(ratio * abv, np.clip(ratio, 1 - CLIP, 1 + CLIP) * abv)
            # pg_loss = -surr.mean()；vf_loss = ((val_b - rb)**2).mean()；loss = pg + VF_W*vf - ENT_W*ent

            # dL/dlogp（未截断支路 = ratio*adv，截断支路 = 0；负号来自最小化）
            safe = (ratio * abv <= (1 + CLIP) * abv + 1e-8) & (ratio * abv >= (1 - CLIP) * abv - 1e-8)
            dlogp = np.where(safe | ~clipped, ratio * abv, 0.0)
            dlogp = -dlogp
            # policy → mean：∂logp/∂mean = -(a-mean)/std²
            d_out = np.zeros((len(xb), HEAD), dtype=np.float32)
            d_out[:, :2] = dlogp[:, None] * (-(ab - mean_b) / (std ** 2))
            # value：vf_loss 对 val 的梯度（1/N 折叠进下面的 matmul 归一化，别除两次）
            d_out[:, 2] = VF_W * 2 * (val_b - rb)
            # logStd 梯度：score 项 ∂logp/∂logStd = z²-1（每样本求均值）+ 熵项 -ENT_W
            dlogstd = (dlogp[:, None] * (z ** 2 - 1)).mean(0) - ENT_W

            dW3 = h2b.T @ d_out / len(xb)
            db3 = d_out.mean(0)
            dh2 = d_out @ W3.T * (h2b > 0)
            dW2 = h1b.T @ dh2 / len(xb); db2 = dh2.mean(0)
            dh1 = dh2 @ W2.T * (h1b > 0)
            dW1 = xb.T @ dh1 / len(xb); db1 = dh1.mean(0)

            g = {'W1': dW1, 'b1': db1, 'W2': dW2, 'b2': db2, 'W3': dW3, 'b3': db3}
            t_step = t_step0 + ep * max(1, N // MINIB) + s // MINIB + 1
            with lock:
                P = params()
                for k in P:
                    adam_m[k] = 0.9 * adam_m[k] + 0.1 * g[k]
                    adam_v[k] = 0.999 * adam_v[k] + 0.001 * g[k] ** 2
                    mh = adam_m[k] / (1 - 0.9 ** t_step); vh = adam_v[k] / (1 - 0.999 ** t_step)
                    P[k] -= LR * mh / (np.sqrt(vh) + 1e-8)   # 原地更新=写回全局 W1..b3
                LOGSTD_ADAM['m'] = 0.9 * LOGSTD_ADAM['m'] + 0.1 * dlogstd
                LOGSTD_ADAM['v'] = 0.999 * LOGSTD_ADAM['v'] + 0.001 * dlogstd ** 2
                mh = LOGSTD_ADAM['m'] / (1 - 0.9 ** t_step); vh = LOGSTD_ADAM['v'] / (1 - 0.999 ** t_step)
                logStd = np.clip(logStd - LR * mh / (np.sqrt(vh) + 1e-8), -2.5, LOGSTD_MAX)
        # —— KL 早停：本 epoch 后新旧策略差超阈值就不再过下一遍数据 ——
        sub = idx_all[:512]
        with lock:
            m_sub = (np.maximum(np.maximum(obs[sub] @ W1 + b1, 0) @ W2 + b2, 0) @ W3 + b3)[:, :2]
            kl_ep = float((((m_sub - old_means[sub]) / np.exp(logStd)) ** 2).mean() / 2)
        if kl_ep > KL_STOP and ep < EPOCHS - 1:
            print(f'[PPO] kl={kl_ep:.4f} > {KL_STOP} @epoch{ep} → early stop', flush=True)
            break
    first_batch_done = True

    with lock:
        h2n = np.maximum(np.maximum(obs @ W1 + b1, 0) @ W2 + b2, 0)
        new_means = (h2n @ W3 + b3)[:, :2]
        kl = float((((new_means - old_means) / np.exp(logStd)) ** 2).mean() / 2)
    updates += 1
    gen += 1
    steps_total += N
    last_stats = {'rew': float(rew.mean()), 'ent': entropy(logStd), 'kl': kl,
                  'pclip': pclip_cnt, 'updates': updates}
    if not all(map(lambda x: x == x, last_stats.values())):   # NaN 兜底（防裸 NaN 出 JSON）
        last_stats = {k: (v if v == v else None) for k, v in last_stats.items()}
    print(f'[PPO] update#{updates} gen={gen} steps={N} total={steps_total} '
          f'mean_rew={last_stats["rew"]:+.3f} ent={last_stats["ent"]:.2f} kl={kl:.4f} '
          f'pclip={pclip_cnt*100:.1f}% age={time.time()-t0:.0f}s', flush=True)
    save_checkpoint()

def save_checkpoint():
    with lock:
        payload = weights_payload()
    tmp = os.path.join(BASE, 'ppo-weights-latest.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(payload, f)
    os.replace(tmp, os.path.join(BASE, 'ppo-weights-latest.json'))
    if updates > 0 and updates % CKPT_EVERY == 0:   # 滚动备份（本地保留，不进库）
        with open(os.path.join(BASE, f'ppo-weights-g{gen}.json'), 'w') as f:
            json.dump(payload, f)

def weights_payload():
    return {'W1': W1.tolist(), 'b1': b1.tolist(), 'W2': W2.tolist(), 'b2': b2.tolist(),
            'W3': W3.tolist(), 'b3': b3.tolist(), 'logStd': logStd.tolist(),
            'norm': {'mu': MU.tolist(), 'sd': SD.tolist()}, 'gen': gen,
            'meta': {'obsDim': OBS_DIM, 'headDim': HEAD, 'actDim': ACT_DIM,
                     'updates': updates, 'steps': steps_total}}

# ---------- rollout buffer ----------
buf = {'obs': [], 'act': [], 'logp': [], 'val': [], 'rew': [], 'done': [], 'tid': [],
       'lastObsByTid': {}}
updating = False

def maybe_update():
    """攒够 BATCH 就开后台线程更新（POST 立即返回，页面不等待）"""
    global buf, updating
    with lock:
        if len(buf['obs']) < BATCH or updating:
            return
        updating = True
        snap = {'obs': buf['obs'], 'act': buf['act'], 'logp': buf['logp'], 'val': buf['val'],
                'rew': buf['rew'], 'done': buf['done'], 'tid': buf['tid'],
                'lastObsByTid': dict(buf['lastObsByTid'])}
        buf = {'obs': [], 'act': [], 'logp': [], 'val': [], 'rew': [], 'done': [], 'tid': [],
               'lastObsByTid': {}}
    def run():
        global updating
        try:
            gae_and_update(np.array(snap['obs'], dtype=np.float32),
                           np.array(snap['act'], dtype=np.float32),
                           np.array(snap['logp'], dtype=np.float32),
                           np.array(snap['rew'], dtype=np.float32),
                           np.array(snap['done'], dtype=np.float32),
                           snap['tid'], snap['lastObsByTid'])
        except Exception as e:
            print(f'[PPO] UPDATE ERROR: {e}', flush=True)
            import traceback; traceback.print_exc()
        finally:
            with lock:
                updating = False
            maybe_update()
    threading.Thread(target=run, daemon=True).start()

# ---------- HTTP 服务 ----------
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
            buf['tid'] += d.get('tid') or [f"{d.get('win','w')}-0"] * (len(d['obs']) - k)
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
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    save_checkpoint()   # 启动即存一版（gen0 = BC 热启动状态）
    print(f'[PPO] server on :{port}  (BC trunk 热启动, batch={BATCH}, checkpoint=ppo-weights-latest.json)', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
