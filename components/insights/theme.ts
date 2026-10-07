"use client";

import { studioTheme, type AgStudioTheme } from "ag-studio";

/**
 * AG Studio themed with Handback's tokens (app/globals.css), in a light and a
 * dark colour mode. The page switches between them by setting
 * data-ag-theme-mode on the wrapper, which carries the ag-theme-mode class.
 */

const SANS = "var(--font-geist), ui-sans-serif, system-ui, sans-serif";
const DISPLAY = "var(--font-bricolage), var(--font-geist), ui-sans-serif, sans-serif";

const shared = {
  fontFamily: SANS,
  fontSize: 13,
  borderRadius: 10,
  studioWidgetBorderRadius: 18,
  studioWidgetTitleFontFamily: DISPLAY,
  studioWidgetTitleFontWeight: 700,
  studioWidgetTitleFontSize: 15,
  studioWidgetSubtitleFontSize: 12,
  studioWidgetPadding: 14,
  studioCanvasBorderRadius: 20,
  chartFontFamily: SANS,
  gridFontFamily: SANS,
} as const;

// Money colours first, so the built-in charts read like the rest of the counter.
const palette = (c: { brand: string; held: string; released: string; charged: string; note: string; extra: string[] }) => ({
  chartPaletteFills1Color: c.brand,
  chartPaletteFills2Color: c.held,
  chartPaletteFills3Color: c.released,
  chartPaletteFills4Color: c.charged,
  chartPaletteFills5Color: c.note,
  chartPaletteFills6Color: c.extra[0],
  chartPaletteFills7Color: c.extra[1],
  chartPaletteFills8Color: c.extra[2],
  chartPaletteStrokes1Color: c.brand,
  chartPaletteStrokes2Color: c.held,
  chartPaletteStrokes3Color: c.released,
  chartPaletteStrokes4Color: c.charged,
  chartPaletteStrokes5Color: c.note,
  chartPaletteStrokes6Color: c.extra[0],
  chartPaletteStrokes7Color: c.extra[1],
  chartPaletteStrokes8Color: c.extra[2],
});

export const LIGHT_MODE = "handback-light";
export const DARK_MODE = "handback-dark";

export function handbackTheme(): AgStudioTheme {
  return studioTheme
    .withParams({
      ...shared,
      ...palette({ brand: "#3730a3", held: "#b7791f", released: "#1f7a4d", charged: "#c2462b", note: "#64748b", extra: ["#8b87e0", "#d9a75b", "#5aa77f"] }),
    })
    .withParams(
      {
        browserColorScheme: "light",
        backgroundColor: "#faf7f2",
        foregroundColor: "#1d1b2f",
        textColor: "#1d1b2f",
        subtleTextColor: "#6b6a7a",
        accentColor: "#3730a3",
        borderColor: "#e9e4dc",
        studioCanvasBackgroundColor: "#faf7f2",
        studioWidgetBackgroundColor: "#ffffff",
        studioWidgetBorder: { color: "#e9e4dc" },
        studioPanelContainerBackgroundColor: "#ffffff",
        menuBackgroundColor: "#ffffff",
        tooltipBackgroundColor: "#1d1b2f",
        tooltipTextColor: "#ffffff",
      },
      LIGHT_MODE,
    )
    .withParams(
      {
        ...palette({ brand: "#9d98ff", held: "#e3a94e", released: "#52c48d", charged: "#f0805f", note: "#9aa8bd", extra: ["#c4c1ff", "#f2cd8c", "#8fdcb5"] }),
        browserColorScheme: "dark",
        backgroundColor: "#14121e",
        foregroundColor: "#eeebf7",
        textColor: "#eeebf7",
        subtleTextColor: "#a8a4ba",
        accentColor: "#9d98ff",
        borderColor: "#322e45",
        studioCanvasBackgroundColor: "#14121e",
        studioWidgetBackgroundColor: "#1d1a2b",
        studioWidgetBorder: { color: "#322e45" },
        studioPanelContainerBackgroundColor: "#1d1a2b",
        menuBackgroundColor: "#1d1a2b",
        tooltipBackgroundColor: "#eeebf7",
        tooltipTextColor: "#14121e",
      },
      DARK_MODE,
    );
}
