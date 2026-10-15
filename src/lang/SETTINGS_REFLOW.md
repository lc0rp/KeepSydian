# Desktop settings reflow repair

Assessed 2026-10-14 with cached Obsidian 1.12.4, its default theme and a fresh synthetic vault.
This follow-up repairs the failed 320px desktop settings and sync-dialog cases using plugin-owned
styles. The original failures and the first diagnostic comparison are retained as historical evidence.

## Measured cause

At a 320 CSS-pixel viewport, the host settings dialog is 288px wide. Its two borders consume 2px,
the navigation has a 180px minimum width, and the content has 48px padding on each side:

```text
288 - 2 - 180 - 48 - 48 = 10px available for settings
```

The same allocation exists with KeepSydian disabled and its stylesheet absent. Obsidian's built-in
General and Editor tabs both overflow their 106px content border box by 56px. Their text and controls
are visibly clipped. Before the repair, KeepSydian received the same 10px content box.
Its root overflowed by 51px in all four locales; its host content border box overflowed by 3px because
some of that content extends into the host's right padding. These are different measurement boxes.

The host's ordinary switch alone is 44px wide. Wrapping translated text cannot make that control
usable in 10px. Shrinking or clipping controls to pass the overflow assertion would hide the failure.
Independent review identified a bounded recovery: the public settings API gives the plugin its own
container. KeepSydian now adds a class to that container and reduces its inline padding to 8px below
521px on desktop. The same 106px border box therefore provides 90px of usable content. Navigation
and other settings tabs retain their original dimensions and padding. Mobile keeps its existing layout.

After that repair, the unchanged strict acceptance test reached the sync dialog and exposed a further
10–13px overflow in its progress indicator. Its narrow-layout connectors now have a 24px minimum,
down from 48px. The steps and their full labels remain present and wrap.

The 90px settings column remains cramped at 320px because the host navigation still takes 180px.
Passing overflow and keyboard checks does not establish ideal usability or screen-reader acceptance.

## Regression comparison

`test/specs/i18n-settings-boundary.e2e.ts` and `wdio.i18n-settings-boundary.conf.mts` run at 320, 430
and 768 CSS pixels, with mobile/touch emulation disabled. They use the same cached app and synthetic-vault
setup as the existing acceptance suite. The Electron window itself is 1024 by 800; WebDriver sets
the CSS viewport to the diagnostic width by 900. This tests desktop rendering at that viewport,
not a claim that a physical 320px desktop window is supported by Obsidian.

The comparison:

1. Disables KeepSydian, verifies that it and its stylesheet are absent, and records General and Editor
   tab screenshots and computed host dimensions.
2. Re-enables the plugin and visits English, Chinese, Russian and German. It asserts the actual locale,
   unchanged navigation and content border-box widths, the scoped padding, and no plugin overflow.
3. At 320px, preserves the reproduced core-tab overflow while asserting at least 90px of plugin content.
4. Returns to General after each locale and compares its dimensions, padding and classes with the
   disabled-plugin baseline. The plugin class and padding must not leak into core tabs.

The regression does not inject layout styles. An earlier diagnostic temporarily gave the plugin a
280px fixed-position box; those artifacts remain labeled as historical probes, not acceptance evidence.

Run with the already installed cache and Node 24:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
NO_PROXY=localhost,127.0.0.1 \
KEEPSIDIAN_TEST_BINARY_CACHE=/path/to/existing/obsidian-cache \
./node_modules/.bin/wdio run wdio.i18n-settings-boundary.conf.mts
```

A passing comparison verifies the scoped repair and core-tab isolation. The strict acceptance suite
now includes 320px in its default desktop matrix alongside 430, 768 and 1100px. Its overflow assertions
are unchanged. Set `KEEPSIDIAN_I18N_WIDTH=320` with `wdio.i18n-acceptance.conf.mts` to run that width
alone. Existing failed evidence is retained separately.

## Minimum-version runtime boundary

The plugin declares Obsidian 1.6.5. The available authorized cache contains only application ASARs and
installers for 1.12.4, 1.12.7 and 1.13.7, with Electron drivers 39.7.0, 39.8.3 and 43.3.0. There is no
1.6.5 application ASAR, compatible old installer or matching driver in the inspected cache/project paths.

The local version metadata for 1.6.5 identifies Electron 30.1.2 / Chromium 124.0.6367.243 and a maximum
installer version of 1.6.5. The cached newer applications and installers cannot establish a real
minimum-version launch. That requires obtaining the official older runtime and matching driver,
outside this task's currently available authorized runtimes. No download, install, quarantine change
or security-policy change was made. This is a missing-runtime blocker, not a failed 1.6.5 plugin test.

Unit tests cover absent/throwing `getLanguage`, which was added in Obsidian 1.8.7, plus explicit
language overrides and the English fallback. They do not replace a real minimum-version run.

Native Android/iOS/Capacitor, native-speaker approval, native screen readers, full RTL and full
theme/contrast acceptance remain explicitly unverified. All non-English catalogs remain opt-in drafts.
