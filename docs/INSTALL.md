# 安装与运行（INSTALL）

## 前置要求

- macOS 12+（arm64/x64），或 Windows 10+ / Linux（x86_64/aarch64）
- Node.js ≥ 20（建议 22+）
- 可选：Python ≥ 3.10 + `brew install zstd`（DSH 会话日志为 zstd 压缩，用于真实 DSH 状态读取）

## 方式一：源码运行（开发版）

```sh
git clone <repo> && cd <repo>
npm install                 # 安装全部依赖（Electron、node-hid 等）
npm run build               # 构建 akp-codec → core → simulator → app
npm run simulate            # 终端 1：启动虚拟键盘 + 虚拟 Agent 模拟器
npm run start -w app        # 终端 2：启动桌面应用
```

应用启动后会自动连接模拟器：
- 设备页显示 Virtual Keyboard 及状态（Ready）；
- Agent 页显示虚拟 Agent 的状态轮播（思考→工具→等待批准→完成）；
- 点击键盘模拟器终端或应用按钮触发动作，观察状态变化。

### 验证安装

```sh
npm test                    # 协议 + 核心 + 模拟器测试
npm run test:e2e -w app     # Electron smoke test（无 GUI 全链路）
npm run test:firmware       # 固件静态校验 + C 编解码测试
```

## 方式二：已打包 macOS 开发版

```
app/release/mac-arm64/AI Keyboard Console.app
```

直接双击运行，或在终端：

```sh
open "app/release/mac-arm64/AI Keyboard Console.app"
```

打包版默认配置会自动启动模拟器（虚拟设备 `vk-sim` 已启用时）。如需重新打包：

```sh
cd app && npm run pack:mac        # 生成 .app
# 或
cd app && npm run pack:mac:dmg    # 生成 .dmg 安装包（需配置签名）
```

## macOS 权限

1. **辅助功能（必需，用于宏按键执行）**
   系统设置 → 隐私与安全性 → 辅助功能 → 添加并勾选本应用。
   未授权时动作执行器会返回错误（界面提示）。仅记录模式（设置→执行器→仅记录）
   不需要该权限。
2. **输入监控（可选）**：如需在后台捕获真实键盘输入。
3. 首次插入带 Raw HID 的键盘时，macOS 可能弹出「允许此电脑连接配件？」——选择允许。

## 连接真实键盘

1. 刷入 QMK/ZMK 固件模块（见 FLASHING_QMK.md / FLASHING_ZMK.md）；
2. 应用「设备」页 → 填写键盘的 vendorId/productId（十六进制，如 `0x3434` / `0x0234`）
   → 连接；
3. 或让应用自动发现（检测 usage page 0xFF60 的 Raw HID 设备）。
4. 设备页会显示能力（rgb/oled/encoder…），无对应硬件的特性自动关闭。

## Agent 状态来源设置

设置 → Agent 状态来源：

| 来源 | 说明 |
|---|---|
| DeepSeek Harness | 尾随 `~/.dsh/sessions/**/session.jsonl.zstd`（需 zstd CLI） |
| Codex | 尾随 `~/.codex/sessions/**/rollout-*.jsonl` |
| Claude Code | 尾随 `~/.claude/projects/**/*.jsonl` |
| 虚拟 Agent | 连接模拟器（精确状态，用于演示/测试） |

选择多个来源时以最后活跃的为准；活动源在设置中指定。状态是启发式解析，置信度
显示在 Agent 页。

## 配置文件

`~/Library/Application Support/AIKeyboardConsole/config.json`（macOS）。
包含设备列表、按键映射、灯光、执行器、Agent 源等；删除后应用重置为默认值。
