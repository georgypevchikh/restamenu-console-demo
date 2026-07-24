# PDF font provenance and licenses

The `generate-po-pdf` Edge Function embeds Roboto directly in its bundle. It
does not fetch fonts from a CDN, Supabase Storage, or any other runtime network
location.

## Embedded Roboto files

Pinned npm source:
[`@expo-google-fonts/roboto@0.4.3`](https://www.npmjs.com/package/@expo-google-fonts/roboto/v/0.4.3)

Upstream repository:
[`expo/google-fonts`, `font-packages/roboto`](https://github.com/expo/google-fonts/tree/main/font-packages/roboto)

| Source file in the npm tarball     |   Bytes | SHA-256                                                            |
| ---------------------------------- | ------: | ------------------------------------------------------------------ |
| `400Regular/Roboto_400Regular.ttf` | 159,108 | `15256405ecb0d880678833a582760efad538ab2932318b52c8105b267d159459` |
| `700Bold/Roboto_700Bold.ttf`       | 159,900 | `4aaf8c5b661a386998c2e70cf2b87e2440f5404e0b8fd81164f0413fb3435ec6` |

For deployment portability, these exact TTF byte streams are deterministically
gzip-compressed and base64-encoded in
`supabase/functions/_shared/core/pdf-fonts.ts`. They are decompressed in-memory
and cached per warm Edge isolate. Deno tests verify both decoded byte lengths
and SHA-256 hashes before rendering.

Roboto copyright: Copyright 2011 The Roboto Project Authors
([`googlefonts/roboto-classic`](https://github.com/googlefonts/roboto-classic)).

Font license: SIL Open Font License 1.1. The complete upstream font license is
preserved in [`ROBOTO-OFL.txt`](./ROBOTO-OFL.txt). The OFL permits bundling and
embedding; generated PDF documents are not required to use the OFL.

The npm wrapper package is `MIT AND OFL-1.1`; no Expo runtime code is imported
by the Edge Function. The npm package is used only as the pinned, auditable
source of the font bytes and license.

## PDF libraries

- [`pdf-lib@1.17.1`](https://www.npmjs.com/package/pdf-lib/v/1.17.1) - MIT.
- [`@pdf-lib/fontkit@1.1.1`](https://www.npmjs.com/package/@pdf-lib/fontkit/v/1.1.1) -
  MIT.

`fontkit` subsets the embedded fonts per generated document. Roboto covers the
Latin Extended and Cyrillic characters required by this demo. Characters not
present in Roboto, notably color emoji and many non-Latin scripts, are replaced
with `?` before drawing so PDF generation remains deterministic and does not
emit missing-glyph boxes.
