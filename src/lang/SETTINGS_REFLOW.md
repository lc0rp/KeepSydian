# Desktop settings reflow boundary

Assessed 2026-10-14 with cached Obsidian 1.12.4, its default theme and a fresh synthetic vault.
This follow-up diagnoses the failed 320px desktop settings case. It does not change the host UI
or turn that failed reflow criterion into a pass.

## Measured cause

At a 320 CSS-pixel viewport, the host settings dialog is 288px wide. Its two borders consume 2px,
the navigation has a 180px minimum width, and the content has 48px padding on each side:

```text
288 - 2 - 180 - 48 - 48 = 10px available for settings
```

The same allocation exists with KeepSydian disabled and its stylesheet absent. Obsidian's built-in
General and Editor tabs both overflow their 106px content border box by 56px. Their text and controls
are visibly clipped. KeepSydian does not cause this allocation: after re-enabling it, the host sidebar,
content width and padding are unchanged, and the plugin root gets exactly the same 10px content box.
Its root overflows by 51px in all four locales; its host content border box overflows by 3px because
some of that content extends into the host's right padding. These are different measurement boxes.

The host's ordinary switch alone is 44px wide. Wrapping translated text cannot make that control
usable in 10px. Shrinking or clipping controls to pass the overflow assertion would hide the failure.
Recovering space requires changing the host navigation/padding or adding a separate settings surface,
which is outside a plugin-local text/reflow repair. No host selectors or product CSS were changed.

At 430px, the host gives the plugin about 109px. The existing plugin wrap rules prevent overflow,
but the page remains cramped. This is not a claim that 430px settings are an ideal layout.

## Regression comparison

`test/specs/i18n-settings-boundary.e2e.ts` and `wdio.i18n-settings-boundary.conf.mts` run at 320 and
430 CSS pixels, with mobile/touch emulation disabled. They use the same cached app and synthetic-vault
setup as the existing acceptance suite. The Electron window itself is 1024 by 800; WebDriver sets
the CSS viewport to the diagnostic width by 900. This tests desktop rendering at that viewport,
not a claim that a physical 320px desktop window is supported by Obsidian.

The comparison:

1. Disables KeepSydian, verifies that it and its stylesheet are absent, and records General and Editor
   tab screenshots and computed host dimensions.
2. Re-enables the plugin and visits English, Chinese, Russian and German. It asserts the actual locale,
   unchanged host allocation, and equality between the plugin root and the host's available content box.
3. At 320px, asserts the reproduced host overflow and records the plugin failure without calling it a pass.
4. Temporarily gives the same plugin subtree a 280px fixed-position box in the test page. All four locales
   must have no horizontal overflow. It preserves the content, stylesheet and desktop ancestry, then
   removes the temporary style. This is a labeled diagnostic intervention, not a shipped layout fix.

Run with the already installed cache and Node 24:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
NO_PROXY=localhost,127.0.0.1 \
KEEPSIDIAN_TEST_BINARY_CACHE=/path/to/existing/obsidian-cache \
./node_modules/.bin/wdio run wdio.i18n-settings-boundary.conf.mts
```

A passing comparison verifies the cause and component-width regression. The original strict 320px
acceptance case remains failing and reproducible with `KEEPSIDIAN_I18N_WIDTH=320` and
`wdio.i18n-acceptance.conf.mts`. Existing failed evidence is retained separately. Neither test skips
the failed criterion nor relaxes its overflow assertion.

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
