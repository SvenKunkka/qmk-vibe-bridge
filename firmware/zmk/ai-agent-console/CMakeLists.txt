if (CONFIG_AI_CONSOLE)
  zephyr_library()
  zephyr_library_sources(src/akp.c)
  zephyr_library_sources(src/raw_hid_events.c)
  zephyr_library_sources(src/ai_console.c)
  zephyr_library_sources(src/behavior_ai_console.c)

  if (CONFIG_AI_CONSOLE_RAW_HID_USB)
    zephyr_library_sources(src/raw_hid_usb.c)
  endif()

  if (CONFIG_AI_CONSOLE_RAW_HID_HOG)
    zephyr_library_sources(src/raw_hid_hog.c)
  endif()

  zephyr_include_directories(include)
endif()
