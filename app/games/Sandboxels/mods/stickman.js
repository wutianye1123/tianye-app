// 火柴人皮肤（游戏中心出品）—— 把人类变成粉笔画火柴人：白脑袋 + 黑身子
// 用法：模组管理器输入 stickman.js 回车，刷新生效；旧人类擦掉重放即为新配色
elements.human.color = ["#fdfdf5"];   // 头：粉笔白
elements.head.color = ["#fdfdf5"];
elements.body.color = ["#151515"];    // 身：炭黑
// 兼容其它人类变体模组可能引入的部件
if (elements.arm) elements.arm.color = ["#151515"];
if (elements.leg) elements.leg.color = ["#151515"];
if (elements.child) { elements.child.color = ["#fdfdf5"]; }
if (elements.baby) { elements.baby.color = ["#fdfdf5"]; }
