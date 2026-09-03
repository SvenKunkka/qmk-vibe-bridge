# AI Console 75 — example keyboard (AKP module demo)
# Feature toggles live in keyboard.json; this file only adds the module
# sources and include paths.

# module sources
SRC += ai_console/akp.c ai_console/ai_console.c
# module headers ("ai_console.h" from keymaps)
VPATH += keyboards/ai_console/ai_console
