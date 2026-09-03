# QMK 固件刷写说明（FLASHING_QMK）

> **Compatibility matrix layer C (optional extension).** This firmware module is
> OPTIONAL: the desktop software neither flashes it nor requires it. Without
> it the keyboard simply remains read-only. See docs/COMPATIBILITY.md.

## 模块内容

`firmware/qmk/modules/ai_console/` —— AKP v1 模块：

| 文件 | 作用 |
|---|---|
| `akp.h / akp.c` | 协议编解码（纯 C99，无 QMK 依赖） |
| `ai_console.h / ai_console.c` | QMK 集成：Raw HID、状态机、RGB、OLED、状态灯 |
| `test/akp_test.c` | 编解码测试（clang 直接编译运行） |

示例键盘 `firmware/qmk/keyboards/ai_console/`（AI Console 75）：
- 顶排 F13–F24 动作键、旋钮（推理深度）、逐键 RGB（可开关）、OLED、状态灯；
- `keyboard.json` + `config.h` + `mcuconf.h` + `rules.mk`；
- `build/ai_console_default.bin/.hex` —— 在本机 QMK 0.29 + STM32L432 工具链
  **真实编译通过**的固件产物。

## 在你的键盘上启用模块

1. 复制模块到你的键盘目录：

   ```sh
   cp -r firmware/qmk/modules/ai_console <qmk>/keyboards/<vendor>/<board>/ai_console
   ```

2. `rules.mk` 增加：

   ```make
   RAW_ENABLE = yes
   SRC += ai_console/akp.c ai_console/ai_console.c
   VPATH += keyboards/<vendor>/<board>/ai_console
   ```

3. 按需开启特性（无对应硬件可不开，模块自动降级）：

   ```make
   ENCODER_ENABLE = yes
   OLED_ENABLE = yes
   RGB_MATRIX_ENABLE = yes   # 或 RGBLIGHT_ENABLE
   ```

4. keymap 接线（参考示例 `keymaps/default/keymap.c`）：

   ```c
   #include "ai_console.h"

   bool process_record_user(uint16_t keycode, keyrecord_t *record) {
       if (!ai_console_process_record(keycode, record)) return false;
       return true;
   }
   void keyboard_post_init_user(void) { ai_console_init(); }
   // 可选：oled_task_user → ai_console_oled_render()
   //       encoder_update_user → ai_console_encoder_update(clockwise)
   //       rgb_matrix_indicators_user → ai_console_rgb_matrix_indicators()
   ```

5. 自定义键（可选）：把 `AI_SELECT_AGENT … AI_CUSTOM_3` 放到键位中；或在你的
   代码里直接调用 `ai_console_send_cmd("approve", "F14")`。

## 编译与刷写

```sh
# 前提：qmk 已安装（pip install qmk）并 qmk setup
cp -r firmware/qmk/keyboards/ai_console <qmk>/keyboards/
cd <qmk>
qmk compile -kb ai_console -km default     # 编译
qmk flash   -kb ai_console -km default     # 刷写（进入 bootloader 后）
```

示例键盘在本机验证的命令：

```sh
qmk compile -kb ai_console -km default
# 产物：ai_console_default.bin (31,220 B) / .hex
```

> 说明：示例键盘使用 STM32L432 + STM32-Dfu 引导，接线/引脚见 `keyboard.json`。
> 移植到自己的板子时改 `processor`、`bootloader`、`matrix_pins`、`encoder`、
> `oled.i2c` 引脚（`config.h` 中 `I2C1_SCL_PIN/I2C1_SDA_PIN`）与 `WS2812_DI_PIN`。
> 逐键 RGB 需要为你的板子提供 LED 布局（QMK `led_config`）；无 RGB 的板子
> 关闭 `rgb_matrix` 特性即可，主机侧自动不再发送 RGB 负载（能力协商）。

## 兼容模式（不刷固件）

任何 QMK 键盘：在键位中放 `KC_F13 … KC_F24`，应用注册了全局 F13–F24 快捷键，
即可单向控制（无状态回传）。安装模块后同键改为 `AI_*` 键码即可升级为双向。

## 状态颜色（固件侧默认）

空闲白 / 思考蓝(0x0078FF) / 工具紫(0x963CDC) / 等待批准橙(0xFF8C00) /
完成绿(0x00DC50) / 错误红(0xFF2828) / 断开灭灯。颜色由主机在 STATE 负载中下发，
固件无需内置调色板（内置仅为离线兜底）。

## 固件测试（无需 QMK 工具链）

```sh
cc -std=c99 -Wall -Wextra -I firmware/qmk/modules/ai_console \
   firmware/qmk/modules/ai_console/test/akp_test.c \
   firmware/qmk/modules/ai_console/akp.c -o /tmp/akp_test
/tmp/akp_test     # ALL TESTS PASSED（向量与 TS 实现互验）
```
