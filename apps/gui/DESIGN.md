---
name: chainer app
description: One window-and-sheet layout in four skins: Retro workstation, Modern flat, Smoked glass, Night glass.
colors:
  retro-desktop: "#4a7a80"
  retro-face: "#cfd5d0"
  retro-face-hi: "#f7faf7"
  retro-shade: "#8a938f"
  retro-edge: "#333b38"
  retro-field: "#fcfefc"
  retro-text: "#11171a"
  retro-text-dim: "#3c4744"
  retro-indigo: "#232b66"
  retro-title-start: "#1f2760"
  retro-title-end: "#6e8fcb"
  modern-desktop-light: "#eef0f4"
  modern-face-light: "#ffffff"
  modern-text-light: "#151a22"
  modern-accent-light: "#2357d4"
  modern-desktop-dark: "#0f1217"
  modern-face-dark: "#181c23"
  modern-text-dark: "#e8ebf1"
  modern-accent-dark: "#78a2ff"
  smoked-desktop: "#07090b"
  smoked-text: "#e9ecee"
  smoked-text-dim: "#8f979d"
  smoked-amber: "#f0b34a"
  night-desktop: "#040a12"
  night-text: "#e8f3ff"
  night-text-dim: "#8fa9c4"
  night-cyan: "#4fd1ff"
  lamp-green: "#2fae55"
  lamp-amber: "#e3a51b"
  lamp-red: "#c8392e"
  lamp-blue: "#4d86d6"
typography:
  title:
    fontFamily: "Helvetica Neue, Noto Sans, Liberation Sans, DejaVu Sans, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Helvetica Neue, Noto Sans, Liberation Sans, DejaVu Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  label:
    fontFamily: "Helvetica Neue, Noto Sans, Liberation Sans, DejaVu Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  readout:
    fontFamily: "ui-monospace, DejaVu Sans Mono, Liberation Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  retro: "0px"
  smoked: "3px"
  modern: "8px"
  night: "7px"
  window-modern: "12px"
  tag-sm: "2px"
  field-modern-alt: "4px"
  control-night: "6px"
  panel-night: "9px"
  panel-modern: "10px"
  frame-night: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
components:
  button-default:
    backgroundColor: "{colors.retro-face}"
    textColor: "{colors.retro-text}"
    rounded: "{rounded.retro}"
    padding: "3px 16px"
    height: "26px"
  button-primary-modern:
    backgroundColor: "{colors.modern-accent-light}"
    textColor: "{colors.modern-face-light}"
    rounded: "{rounded.modern}"
    padding: "3px 16px"
    height: "34px"
  button-primary-smoked:
    backgroundColor: "{colors.smoked-amber}"
    textColor: "{colors.smoked-desktop}"
    rounded: "{rounded.smoked}"
    height: "30px"
  button-primary-night:
    backgroundColor: "{colors.night-cyan}"
    textColor: "{colors.night-desktop}"
    rounded: "{rounded.night}"
    height: "32px"
  field-retro:
    backgroundColor: "{colors.retro-field}"
    textColor: "{colors.retro-text}"
    rounded: "{rounded.retro}"
    height: "26px"
---

# Design System: chainer app

## Overview

**Creative North Star: "The Workstation"**

chainer is a tool people operate to move money, so the interface is a desk of real instruments: a window with a title bar, a list of sheets on the left, one working sheet, and a status strip along the bottom that always says which wallet, which network (real or test) and what job is running. One structure serves four skins, chosen by the user on first launch and changeable in Settings. The skin changes materials and light, never layout, copy or behaviour.

The default skin is Modern (flat, light or dark with the system). Retro is an original early-2000s workstation: a mist-teal desktop tiled with a faint node-and-edge pattern, bevelled windows, indigo title bars, recessed fields, lamps for state. It is written for this project and borrows nothing from any operating system. The other skins are Modern (flat, light or dark with the system), Smoked glass (near-black smoked panels, amber instruments, mono readouts) and Night glass (a translucent frame with a diagonal sheen around a dark pane, cyan accent).

**Key Characteristics:**
- One window-and-sheet structure; skins are CSS only.
- Numbers are always tabular and right-aligned; money and addresses are the content.
- State is never colour alone: lamps always sit beside text.
- Test networks are announced in the title bar, the status strip and the confirmation banner.

## Colors

Each skin is a restrained palette: neutrals tinted toward one hue plus one accent. Lamps are shared by all skins.

### Retro
- **Mist Teal** (#4a7a80): the desktop, with a white-at-9% node tile.
- **Cool Face** (#cfd5d0): window and sheet surface; bevel light #f7faf7, shade #8a938f, edge #333b38.
- **Recess White** (#fcfefc): fields, tables and the sheet list.
- **Indigo** (#232b66): selection and the title bar's start; the bar runs to #6e8fcb on a 100-degree diagonal.
- **Ink** (#11171a) and **Ink Dim** (#3c4744): text.

### Modern
- Light: desktop #eef0f4, face #ffffff, text #151a22, accent **Signal Blue** #2357d4.
- Dark (system preference): desktop #0f1217, face #181c23, text #e8ebf1, accent #78a2ff.

### Smoked glass
- **Smoke** (#07090b desktop, face rgb(14 17 20 / 0.74)), text #e9ecee, dim #8f979d, accent **Instrument Amber** #f0b34a.

### Night glass
- **Deep Water** (#040a12 desktop with teal and blue light), text #e8f3ff, dim #8fa9c4, accent **Cyan** #4fd1ff.

### State tints (all skins)
Banners, tags and the restricted-region notice use a pale or deep tint per state (amber for test and restricted, blue for real, green for done, red for stopped), with text chosen for 4.5:1 or better on its tint. The exact tints differ per skin (see the skin stylesheets); they are a family, not individual tokens.

### Lamps (all skins)
Green #2fae55 done, amber #e3a51b running or test, red #c8392e failed, blue #4d86d6 real networks, grey for idle.

### Named Rules
**The Lamp-and-Word Rule.** A lamp never stands alone: its state is also written ("Test networks", "No job running").
**The One Accent Rule.** Each skin has one accent colour, used for selection, the primary button and focus; everything else is neutral.

## Typography

**Font stack (all skins):** Helvetica Neue, Noto Sans, Liberation Sans, DejaVu Sans, system-ui. No third-party or Microsoft faces are bundled. **Readout font:** ui-monospace / DejaVu Sans Mono for addresses, logs, and (in Smoked glass) labels and the status strip.

**Character:** plain, dense, legible; the interface is an instrument, so type is used at working sizes.

### Hierarchy
- **Title** (700, 19px Retro, 20px Night, 22px Modern, 1.2): the sheet title.
- **Section** (700, 14.5px, 15px in Modern): headings inside a sheet.
- **Body** (400, 13px Retro and Smoked, 13.5px Night, 14px Modern, 1.45, tabular numerals): everything else.
- **Label** (600): table headers, group legends.
- **Readout** (mono, 0.92em): addresses, hashes, the run log.

### Named Rules
**The Tabular Rule.** Every number, balance and amount uses tabular figures and sits right-aligned in its column.

## Layout

A window centred on the desktop with 18 to 26px of desktop around it, filling the screen on a phone. Inside: a 176 to 196px sheet list on the left and the working sheet on the right; the status strip runs along the bottom. Forms use a label column (150px) and a field column; tables scroll horizontally inside their own frame rather than the page. Under 760px the window fills the screen, the sheet list becomes a horizontally scrolling tab strip at the bottom, and form rows stack.

## Elevation & Depth

Retro uses 1px bevels (light top-left, dark bottom-right, inner shade) and a soft window drop shadow; fields are recessed with an inner top-left edge. Modern uses hairline borders and a soft ambient shadow. The glass skins use translucency: `backdrop-filter: blur(12px)` (Smoked) and `blur(18px) saturate(160%)` (Night) over a light-leaking desktop, a bright top edge and a deep ambient shadow; Night adds a 115-degree sheen. Depth is never decoration: a raised or translucent surface is always a window or dialog.

### Named Rules
**The Real Surface Rule.** Only windows, dialogs and the sheet list may be raised, translucent or recessed.

## Shapes

Retro is square (0px) with 1px bevels and round lamps and radio buttons. Smoked glass is tight (3 to 6px). Night glass is soft (7 to 14px) with a thick frame. Modern uses 8px controls and 12px windows. Pills are used only for the `region` tag in the glass and Modern skins.

## Components

### Buttons
- **Shape:** skin radius; Retro bevelled outward, pressed inward on `:active`.
- **Primary:** bold; Retro adds a 1px outer outline, Modern fills with Signal Blue, Smoked with Amber, Night with a cyan gradient.
- **Disabled:** dimmed; Retro uses an embossed text shadow.

### Fields
Recessed in Retro, hairline with a focus border in the others; focus ring is a dotted inner outline in Retro and a 1 to 2px accent outline elsewhere.

### Tables
A framed, horizontally scrolling table; header row in the skin's raised or dim style, selected row in the selection colour with its secondary text inheriting it, numbers right-aligned. The routes table carries a radio per row and a `region` tag for restricted services.

### Navigation
A sheet list on the left (a bottom tab strip under 760px) with icon and label; the current sheet uses the selection colour. All icons are drawn for the app on a 16px grid with a 1.5px stroke.

### Dialogs
Native `<dialog>` windows for the single confirmation before anything is signed, and for short name prompts. The confirmation always opens with a banner saying real or test networks.

### Status strip
Wallet name, the network toggle (a button) and the job lamp with its text.

## Do's and Don'ts

### Do:
- **Do** keep one accent per skin and use it for selection, the primary action and focus.
- **Do** write state in words next to every lamp.
- **Do** keep amounts tabular and right-aligned.
- **Do** say "Test networks" wherever the app is in test mode.

### Don't:
- **Don't** add decoration that is not a window, dialog or list: no glow halos, no gradient text, no card grids.
- **Don't** use emoji or text glyphs as icons; draw them on the 16px grid.
- **Don't** let a skin change the layout, the copy or what a control does.
- **Don't** copy any operating system's visual identity into Retro.
