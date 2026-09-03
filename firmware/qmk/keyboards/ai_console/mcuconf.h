/* Copyright 2026 AI Console contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Enable the I2C1 peripheral for the OLED display (ssd1306).
 */

#pragma once

#include_next <mcuconf.h>

#undef STM32_I2C_USE_I2C1
#define STM32_I2C_USE_I2C1 TRUE
