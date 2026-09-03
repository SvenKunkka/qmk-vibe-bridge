# 故障排查（TROUBLESHOOTING）

## 应用无法启动 / 黑屏

1. 确认 `npm run build` 成功（`app/dist/` 存在）。
2. 查看日志：`npm run start -w app 2>&1 | grep "\[error\]"`。
3. 删除损坏配置：`rm -rf ~/Library/Application\ Support/AIKeyboardConsole` 后重试。
4. Electron 二进制损坏时（`Electron failed to install correctly`）：
   `rm -rf node_modules/electron && cd app && npm install electron@33.4.11`。

## 键盘连不上（真实硬件）

1. 确认固件已刷入且启用 `RAW_ENABLE`（QMK）/ `AI_CONSOLE_RAW_HID_USB`（ZMK）。
2. 设备页填写正确的 vendorId/productId（十六进制）。
3. 应用日志应出现 `node-hid loaded`；没有则说明原生模块缺失：
   `cd app && npm run rebuild`（需 Xcode CLT）。
4. macOS 首次连接弹窗选「允许」；若被拒绝：系统设置→隐私与安全性→USB。
5. 用 `node -e "console.log(require('node-hid').devices())"` 检查系统是否枚举到设备。

## 模拟器

- 端口占用：虚拟键盘 18902、虚拟 Agent 18903（默认）。改端口：设置→设备/Agent 源。
- 应用没显示虚拟设备：设置→设备→「+ Virtual」；或重启应用（启动时自动连接）。

## 状态不更新 / 一直是 idle

1. 确认 Agent 状态来源已启用且选择正确（设置→Agent 状态来源）。
2. DSH 源需要 `unzstd`（`brew install zstd`）；日志出现 `[watch]` 说明在轮询。
3. 启发式状态有置信度显示；虚拟 Agent 为精确状态（置信度 100%），用于排查。
4. 陈旧保护：TOOL/THINKING 超过 20s 无新事件自动降级为 idle（可调 staleMs）。

## 按键无反应（宏执行）

1. 设置→执行器 改为「宏按键」；macOS 需授予辅助功能权限（设置页有提示与入口）。
2. 执行器「仅记录」模式不执行任何动作（日志可见 `[off] action recorded`）。
3. F13–F24 全局快捷键可能被其他应用占用（如屏幕录制软件）；可在系统设置中调整。

## 固件行为异常

- 灯不亮：确认键盘有 RGB 且模块检测到（HELLO 的 features）；主机只在能力协商
  通过后发送 RGB。无 RGB 的板子关闭特性即可，主机自动停发。
- OLED 空白：QMK 需 `I2C1_SCL_PIN/I2C1_SDA_PIN` 与 `mcuconf.h`（启用 I2C1）；
  示例键盘已含，移植时参照。
- 主机断开后灯没灭：心跳超时默认 6s（`AI_CONSOLE_HOST_TIMEOUT_MS`）。

## 常见报错对照

| 报错 | 处理 |
|---|---|
| `Electron failed to install correctly` | 重新安装 electron（见上） |
| `No handler registered for 'core:...'` | 更新应用（IPC 注册顺序已修复） |
| `node-gyp failed to rebuild node-hid` | 无需重建（NAPI 二进制跨运行时兼容）；检查 `build.npmRebuild=false` |
| `Cannot find module 'node-hid'` | `cd app && npm run rebuild` |
| `unzstd failed` | `brew install zstd` |
| `No session logs found under ~/.dsh/sessions` | 尚未运行过 DSH；运行一次即可 |
| ZMK 编译报 API 不匹配 | ZMK main 迭代快，按编译错误调整（见 FLASHING_ZMK.md 限制） |
