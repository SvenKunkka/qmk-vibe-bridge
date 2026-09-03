# ZMK 固件刷写说明（FLASHING_ZMK）

> **Compatibility matrix layer C (optional extension).** This firmware module is
> OPTIONAL: the desktop software neither flashes it nor requires it. Without
> it the keyboard simply remains read-only. See docs/COMPATIBILITY.md.

## 模块内容

`firmware/zmk/ai-agent-console/` —— 独立 ZMK Module（AKP v1）：

| 文件 | 作用 |
|---|---|
| `zephyr/module.yml` / `CMakeLists.txt` / `Kconfig` | ZMK 模块构建配置与选项 |
| `src/akp.c` + `include/akp/akp.h` | 协议编解码（与 QMK/TS 逐位一致，纯 C99） |
| `src/raw_hid_usb.c` | USB Raw HID 接口（usage page 0xFF60 / usage 0x61，32B 报告） |
| `src/raw_hid_hog.c` | BLE HID over GATT 传输 |
| `src/raw_hid_events.c` | 收发改发与事件分发 |
| `src/ai_console.c` | 状态机：HELLO/CAPS/STATE/RGB/SCREEN/心跳、underglow、LVGL widget |
| `src/behavior_ai_console.c` | 自定义 Behavior `ai-console-key`（F13–F24 动作键） |
| `dts/bindings/behavior/zmk,behavior-ai-console.yaml` | Behavior 绑定 |
| `behaviors/ai_console.dtsi` | Behavior 实例化 |
| `include/dt-bindings/behavior/ai_console.h` | 动作参数宏（AI_APPROVE 等） |

## 安装到你的 ZMK 配置

1. `config/west.yml` 增加模块：

   ```yaml
   manifest:
     remotes:
       - name: zmkfirmware
         url-base: https://github.com/zmkfirmware
       - name: vibebridge
         url-base: https://github.com/vibebridge
     projects:
       - name: zmk
         remote: zmkfirmware
         revision: main
         import: app/west.yml
       - name: ai-agent-console
         remote: vibebridge
         revision: main
     self:
       path: config
   ```

2. keymap overlay（示例 `config/keymap.overlay`）：

   ```c
   #include <dt-bindings/behavior/ai_console.h>
   #include <behaviors/ai_console.dtsi>

   / {
       keymap {
           compatible = "zmk,keymap";
           default_layer {
               bindings = <
                   &ai_console_key AI_SELECT_AGENT  &ai_console_key AI_APPROVE
                   &ai_console_key AI_REJECT        &ai_console_key AI_NEW_TASK
                   &ai_console_key AI_SEND          &ai_console_key AI_DICTATE
                   &ai_console_key AI_FAST_MODE     &ai_console_key AI_REASONING_UP
                   &ai_console_key AI_REASONING_DOWN
               >;
           };
       };
   };
   ```

3. 旋钮（encoder）绑定：

   ```c
   sensor-bindings = <&ai_console_key AI_REASONING_UP>, <&ai_console_key AI_REASONING_DOWN>;
   ```

4. 特性开关（Kconfig）：

   - `CONFIG_AI_CONSOLE_UNDERGLOW=y`（需 `ZMK_RGB_UNDERGLOW`）→ 状态颜色
   - `CONFIG_AI_CONSOLE_OLED=y`（需 `ZMK_DISPLAY` + 显示 shield，如 nice_view）→ 状态屏
   - 没有 RGB/屏幕的板子关闭对应项（主机通过能力协商也不会再发送对应负载）

## 构建与刷写（GitHub Actions 或本地 west）

GitHub Actions（推荐，官方 ZMK 工作流）：

1. 把你的仓库设为 ZMK config 仓库（unified-zmk-config-template）；
2. 在 `build.yaml` 中启用 `ai-agent-console` 并选择 shield；
3. Actions 产出 `.uf2`，拖入键盘（双按 reset 进入 UF2 模式）。

本地 west：

```sh
west init -l config && west update
west build -b nice_nano_v2 -- -DSHIELD=<你的shield>
west flash
```

## 兼容模式（不刷固件）

普通 ZMK 键盘：绑定 `&kp F13 … &kp F24`，应用全局 F13–F24 快捷键即可单向控制。
模块的 `emit-f-key` 属性（在 dtsi 中设 `<true>`）可在 Raw HID 不可用时回退输出
F 键。

## 说明与限制

- ZMK main 目前没有官方 Raw HID API；本模块自带的 USB/BLE(HOG) 传输实现遵循社区
  `zmk-raw-hid`（zzeneg）的成熟方案（attribution 见模块 README）。
- 本机环境无法安装 ZMK 工具链（west + nRF SDK），因此 ZMK 固件**未在本机编译**；
  编解码器（纯 C）已通过 clang 真实编译与向量测试，传输/behavior 代码按 ZMK 当前
  API 编写，需在 ZMK 环境构建验证（见 HARDWARE_VALIDATION.md）。
