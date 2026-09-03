/* Copyright 2026 AI Console contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * AI Console 75 — example keyboard (AKP module demo).
 * config.h is force-included by the build; feature toggles live in
 * keyboard.json, board-specific settings live here.
 */

#pragma once

/* debounce */
#define DEBOUNCE 5

/* OLED I2C pins (STM32 I2C1) */
#define I2C1_SCL_PIN B6
#define I2C1_SDA_PIN B7

/* RGB matrix (96 keys on the demo layout; PB1 = WS2812 data) */
#define WS2812_DI_PIN B1
#define WS2812_BITBANG_NOP_FUDGE 0.05

/* RGB matrix defaults */
#define RGB_MATRIX_DEFAULT_MODE RGB_MATRIX_SOLID_COLOR
#define RGB_MATRIX_DEFAULT_HUE 210
#define RGB_MATRIX_DEFAULT_SAT 255
#define RGB_MATRIX_DEFAULT_VAL 60

/* OLED timeout */
#define OLED_TIMEOUT 0

/* AKP module settings (defaults already exist in ai_console.c; override here) */
#define AI_CONSOLE_HOST_TIMEOUT_MS 6000
#define AI_CONSOLE_OLED_LINES 4
#define AI_CONSOLE_OLED_LINE_LEN 21
#define AI_CONSOLE_STATUS_LED_PIN A10
#define AI_CONSOLE_STATUS_LED_ON_LEVEL 1
