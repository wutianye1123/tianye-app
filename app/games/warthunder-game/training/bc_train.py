#!/usr/bin/env python3
# bc_train.py — 行为克隆训练（纯 numpy，零依赖）
# 数据：training/data/*.jsonl + training/data-dagger/*.jsonl（agent-recorder/agent-dagger 录制）
# 用法：python3 bc_train.py [epochs] [输出文件名]
# 模型：MLP 70->256->256->5（前 4 维动作用 tanh 回归，第 5 维开火用加权 BCE）
# 产出：training/bc-weights.json（权重 + obs 标准化参数，浏览器 js/agent-bc.js 手写前向直接吃）
import json, glob, sys, os
import numpy as np

BASE = os.path.dirname(__file__)
DATA_DIRS = [os.path.join(BASE, 'data'), os.path.join(BASE, 'data-dagger')]
OUT = os.path.join(BASE, sys.argv[2] if len(sys.argv) > 2 else 'bc-weights.json')
OBS_DIM, ACT_DIM = 70, 5
H1, H2 = 256, 256
EPOCHS = int(sys.argv[1]) if len(sys.argv) > 1 else 40
BATCH = 512
LR = 1e-3
FIRE_POS_W = 30.0     # 开火样本稀疏（~0.5%）→ BCE 正类加权
FIRE_OS = 5.0         # 开火样本等效过采样倍数（经样本权重实现）
COMBAT_W = 2.0        # 最近敌 <225m 的样本加权（交战行为更值钱）
SEED = 42

rng = np.random.default_rng(SEED)

# ---------- 读数据（farm 原始 + DAgger 纠正，混合） ----------
X, Y = [], []
n_files = 0
for DATA in DATA_DIRS:
    for f in glob.glob(os.path.join(DATA, '*.jsonl')):
        n_files += 1
        for line in open(f):
            line = line.strip()
            if not line.startswith('{'): continue
            d = json.loads(line)
            X.append(d['obs']); Y.append(d['act'])
X = np.array(X, dtype=np.float32); Y = np.array(Y, dtype=np.float32)
N = len(X)
print(f'loaded {N} samples from {n_files} files')
assert X.shape[1] == OBS_DIM and Y.shape[1] == ACT_DIM, 'dim mismatch'

# ---------- 标准化 obs（act 不标准化：输出即语义动作） ----------
mu, sd = X.mean(0), X.std(0) + 1e-6
Xn = (X - mu) / sd

# ---------- 切分 ----------
idx = rng.permutation(N)
n_val = max(1, int(N * 0.1))
va, tr = idx[:n_val], idx[n_val:]
Xtr, Ytr, Xva, Yva = Xn[tr], Y[tr], Xn[va], Y[va]
# 样本权重：交战加权 + 开火样本过采样权重（稀疏 0.5% → ×FIRE_OS 倍等效复制）
w_tr = np.where(X[tr][:, 16] < 0.5, COMBAT_W, 1.0).astype(np.float32)
w_tr *= np.where(Ytr[:, 4] > 0, FIRE_OS, 1.0).astype(np.float32)
fire_rate = float((Y[:, 4] > 0).mean())
print(f'train {len(tr)} / val {len(va)} | fire rate {fire_rate*100:.2f}% | combat samples {(w_tr>1).mean()*100:.0f}%')

# ---------- 模型与手写 Adam ----------
def init(fan_in, fan_out): return (rng.normal(0, np.sqrt(2 / fan_in), (fan_in, fan_out)).astype(np.float32),
                                   np.zeros(fan_out, dtype=np.float32))
W1, b1 = init(OBS_DIM, H1); W2, b2 = init(H1, H2); W3, b3 = init(H2, ACT_DIM)
params = {'W1': W1, 'b1': b1, 'W2': W2, 'b2': b2, 'W3': W3, 'b3': b3}
m = {k: np.zeros_like(v) for k, v in params.items()}
v = {k: np.zeros_like(v) for k, v in params.items()}
beta1, beta2, eps = 0.9, 0.999, 1e-8

def forward(x):
    h1 = np.maximum(x @ W1 + b1, 0)
    h2 = np.maximum(h1 @ W2 + b2, 0)
    return h1, h2, h2 @ W3 + b3     # 输出：前4维线性（推理时 tanh），第5维 logit

def tanh(x): return np.tanh(x)

def train_step(xb, yb, wb, t):
    global W1, b1, W2, b2, W3, b3
    B = len(xb)
    h1, h2, out = forward(xb)
    # 前置激活（用于反向）
    z1 = xb @ W1 + b1; z2 = h1 @ W2 + b2
    # 损失梯度
    d4 = (tanh(out[:, :4]) - yb[:, :4]) * (1 - tanh(out[:, :4]) ** 2)   # MSE d/dz（链式含 tanh'）
    p = 1 / (1 + np.exp(-out[:, 4]))
    yf = yb[:, 4]
    d5 = (p - yf) * np.where(yf > 0, FIRE_POS_W, 1.0)
    dout = np.concatenate([d4, d5[:, None]], 1) * wb[:, None]
    loss = (((tanh(out[:, :4]) - yb[:, :4]) ** 2).mean()
            + float((-(yf * np.log(p + 1e-7) * np.where(yf > 0, FIRE_POS_W, 1.0)
                       + (1 - yf) * np.log(1 - p + 1e-7)) * wb).mean()))
    # 反向
    dW3 = h2.T @ dout / B; db3 = dout.mean(0)
    dh2 = dout @ W3.T * (z2 > 0)
    dW2 = h1.T @ dh2 / B; db2 = dh2.mean(0)
    dh1 = dh2 @ W2.T * (z1 > 0)
    dW1 = xb.T @ dh1 / B; db1 = dh1.mean(0)
    grads = {'W1': dW1, 'b1': db1, 'W2': dW2, 'b2': db2, 'W3': dW3, 'b3': db3}
    for k in params:
        m[k] = beta1 * m[k] + (1 - beta1) * grads[k]
        v[k] = beta2 * v[k] + (1 - beta2) * grads[k] ** 2
        mh = m[k] / (1 - beta1 ** t); vh = v[k] / (1 - beta2 ** t)
        params[k] -= LR * mh / (np.sqrt(vh) + eps)
    W1, b1 = params['W1'], params['b1']; W2, b2 = params['W2'], params['b2']; W3, b3 = params['W3'], params['b3']
    return float(loss)

def evaluate(Xv, Yv):
    _, _, out = forward(Xv)
    a_pred, a_true = tanh(out[:, :4]), Yv[:, :4]
    mae = np.abs(a_pred - a_true).mean(0)
    p = 1 / (1 + np.exp(-out[:, 4]))
    yf = Yv[:, 4]
    # 阈值扫描：选 F1 最高的阈值（js 推理侧用）
    best = (0.5, 0, 0, 0)
    for th in (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8):
        pred = p > th
        tp = float((pred & (yf > 0)).sum()); fp = float((pred & (yf == 0)).sum())
        fn = float((~pred & (yf > 0)).sum())
        prec = tp / max(1, tp + fp); rec = tp / max(1, tp + fn)
        f1 = 2 * prec * rec / max(1e-6, prec + rec)
        if f1 > best[3]: best = (th, prec, rec, f1)
    return mae, best

# ---------- 训练循环 ----------
t = 0
for ep in range(1, EPOCHS + 1):
    order = rng.permutation(len(Xtr))
    ep_loss = 0.0
    for i in range(0, len(order), BATCH):
        sel = order[i:i + BATCH]
        ep_loss += train_step(Xtr[sel], Ytr[sel], w_tr[sel], t := t + 1) * len(sel)
    if ep % 4 == 0 or ep == 1 or ep == EPOCHS:
        mae, (th, prec, rec, f1) = evaluate(Xva, Yva)
        print(f'ep {ep:3d} loss {ep_loss/len(Xtr):.4f} | val MAE thr/turn/yaw/pitch = '
              f'{mae[0]:.3f}/{mae[1]:.3f}/{mae[2]:.3f}/{mae[3]:.3f} | fire@th{th} P{prec:.2f} R{rec:.2f} F1 {f1:.2f}')

# ---------- 导出 ----------
_, (best_th, _, _, _) = evaluate(Xva, Yva)
model = {'meta': {'obsDim': OBS_DIM, 'actDim': ACT_DIM, 'arch': [H1, H2], 'fireTh': round(float(best_th), 2),
                  'actSemantics': ['throttle(-1..1)', 'turn(-1..1)', 'aimYaw(-1..1=π)', 'aimPitch(-1..1=0.3rad)', 'fire(0..1)']},
         'norm': {'mu': mu.tolist(), 'sd': sd.tolist()}}
for k in ('W1', 'b1', 'W2', 'b2', 'W3', 'b3'):
    model[k] = params[k].tolist()
json.dump(model, open(OUT, 'w'))
print(f'saved {OUT} ({os.path.getsize(OUT)//1024} KB)')
