"""Fixes stb_image's animated-GIF frame handling so Showdown's sprites decode like browsers show
them (checked against Pillow). Run on a fresh stb_image.h: python tools/patch-stb.py <stb_image.h>

1. Disposal 2 ("restore to background") cleared only the pixels the frame drew, back to the
   picture before it; when an earlier frame had been kept (disposal 1) that picture showed
   through, so frames piled up. It now clears the frame's whole rectangle to transparent.
2. Disposal 3 ("restore to previous") read from "two frames back", which is wrong for runs of
   such frames and pointed before the buffer. It now restores the picture saved before the
   frame was drawn (g->background), which stb already keeps.
3. Pixels the first frame doesn't draw were filled with the GIF's opaque background colour;
   browsers leave them transparent.
"""
import sys

path = sys.argv[1]
src = open(path, encoding='utf8', newline='').read()


def sub(old, new):
    global src
    assert src.count(old) == 1, f'stb_image.h changed, patch needs updating: {old[:60]!r}'
    src = src.replace(old, new)


sub('''      if ((dispose == 3) && (two_back == 0)) {
         dispose = 2; // if I don't have an image to revert back to, default to the old background
      }

      if (dispose == 3) { // use previous graphic
         for (pi = 0; pi < pcount; ++pi) {
            if (g->history[pi]) {
               memcpy( &g->out[pi * 4], &two_back[pi * 4], 4 );
            }
         }
      } else if (dispose == 2) {
         // restore what was changed last frame to background before that frame;
         for (pi = 0; pi < pcount; ++pi) {
            if (g->history[pi]) {
               memcpy( &g->out[pi * 4], &g->background[pi * 4], 4 );
            }
         }
      } else {''', '''      STBI_NOTUSED(two_back);
      if (dispose == 3) { // patched: restore the picture from before the previous frame was drawn
         for (pi = 0; pi < pcount; ++pi) {
            if (g->history[pi]) {
               memcpy( &g->out[pi * 4], &g->background[pi * 4], 4 );
            }
         }
      } else if (dispose == 2) { // patched: clear the previous frame's rectangle to transparent
         int row;
         for (row = g->start_y; row < g->max_y; row += g->line_size) {
            memset( &g->out[row + g->start_x], 0, g->max_x - g->start_x );
         }
      } else {''')

sub('            if (first_frame && (g->bgindex > 0)) {',
    '            if (0 && first_frame && (g->bgindex > 0)) { // patched: keep undrawn pixels transparent, like browsers')

sub('               two_back = out - 2 * stride;', '               two_back = out + (layers - 2) * stride; // patched: was before the buffer')

open(path, 'w', encoding='utf8', newline='').write(src)
print('patched', path)
