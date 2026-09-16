# Compress PDF

A tiny, client-side website that does three things with a PDF, without ever
uploading it anywhere:

- **Compress it** by recompressing the images embedded inside it.
- **Convert it to images** — one JPEG, PNG or WebP per page.
- **Tell you where its bytes actually went**, so you know whether compressing
  the images is even the right lever.

**Live app:** enable GitHub Pages for this repo (see below) and it will be
served at `https://<your-username>.github.io/compress-pdf/`.

## Compressing

1. You pick a PDF (drag & drop or file picker).
2. The app parses the PDF's internal object structure with
   [pdf-lib](https://pdf-lib.js.org/) and finds every embedded image.
3. Each image is decoded, optionally downscaled and/or desaturated, and
   re-encoded as a JPEG using a WebAssembly build of
   [MozJPEG](https://github.com/mozilla/mozjpeg) (via
   [`@jsquash/jpeg`](https://github.com/jamsinclair/jSquash)) at the quality
   you choose. MozJPEG's encoder (trellis quantization, optimized Huffman
   tables, etc.) produces meaningfully smaller files than the browser's
   built-in JPEG encoder at the same visual quality — if WASM is unavailable
   for some reason, it falls back to `canvas.toBlob('image/jpeg')`.
4. If the recompressed image is smaller than the original, it replaces the
   image inside the PDF's object graph. The rest of the PDF (text, fonts,
   vector graphics, layout) is left untouched.
5. The resulting PDF is offered back to you as a download.

### How images get decoded

Image decoding is where most PDF compressors quietly give up, and it is the
main reason a big PDF can come back barely smaller: the handful of images
that hold most of the bytes are exactly the ones in formats the browser
cannot read. So there are two decode paths:

- **Plain JPEG** (`DCTDecode` in a grey or RGB colour space) goes straight to
  the browser's own decoder. Fast, and it covers the common case.
- **Everything else** is handed to [PDF.js](https://mozilla.github.io/pdf.js/).
  The single image is wrapped in a throwaway one-page PDF and that page is
  rendered to a canvas, which makes PDF.js's worker do the decoding. That
  covers JPEG 2000 (`JPXDecode`), JBIG2, CCITT Group 3/4 fax, LZW,
  run-length, flate with PNG/TIFF predictors, and multi-filter chains — in
  indexed-palette, CMYK, ICC-based, Lab, Separation and DeviceN colour, at
  any bit depth, with `/Decode` arrays applied. Rendering happens directly at
  the target resolution, so downscaling a 6000px scan never allocates a
  6000px canvas.

Because everything ends up as a canvas, the output is always a plain
`DCTDecode` JPEG in `/DeviceRGB` (or `/DeviceGray`) — the only widely
supported lossy filter the PDF spec actually defines. WebP and AVIF are not
usable here: PDF has no filter for decoding them, so a WebP-encoded image
inside a PDF would not render in any standard viewer.

Images are still left alone when recompressing them would be unsafe or
pointless, and the result screen lists exactly which ones and why:

| Left unchanged | Why |
| --- | --- |
| Stencil masks (`/ImageMask true`) | 1-bit on/off masks; a lossy JPEG would fray their edges |
| Colour-key masked images (`/Mask [...]`) | The mask names exact colour values in the original colour space |
| Soft masks with `/Matte` | The colour data is pre-blended against the mask |
| JPEG 2000 with `/SMaskInData` | Its alpha lives inside the codestream, and `DCTDecode` has nowhere to put it |
| Anything under ~1 KB | Re-encoding costs more bytes than it saves |
| Images that grew | The original was already better compressed |

Soft masks (`/SMask`) *are* recompressed, as single-channel grey JPEGs, but
never below quality 60 — alpha channels show ringing artifacts long before
photos do.

Encrypted (password-protected) PDFs are rejected up front rather than
silently producing a corrupt file.

## Finding out where the bytes went

Recompressing images only helps if images are what a file is made of. The
**What's inside** tab measures that, so you don't have to guess: it walks the
object graph from the trailer and attributes every stream in the file to what
it is for — images, embedded font programs, page content and vector art,
annotations, attachments, thumbnails, metadata, colour profiles, tagged-PDF
structure — and reports the rest as document structure. The numbers are the
stored (still-compressed) lengths, and they add up to exactly the file size.

Two categories are worth calling out:

- **Unreferenced leftovers** — streams the walk never reaches. Nothing in the
  document refers to them any more; they are prior revisions left behind by
  incremental saves, and a plain "save as" in most PDF tools drops them.
- **Uncompressed streams** — anything stored with no `/Filter` at all, which
  some producers emit. Reported separately, since deflating those alone would
  shrink the file.

Whichever category is largest, the app says what actually helps — which for a
font-heavy or vector-heavy file is *not* this tool. It works on encrypted PDFs
too, since measuring a stream does not require decrypting it.

## Converting pages to images

The same PDF.js build renders whole pages. You choose the format (JPEG, PNG
or WebP), the render resolution in DPI, optional max width/height caps, the
quality for lossy formats, grayscale, and which pages (`all`, `1-5`,
`1,3,7-9`). Each page comes back as its own download, plus a "download all"
`.zip` built in the browser by a ~50-line store-only ZIP writer.

## No build step

This stays a plain HTML/CSS/JS site: pdf-lib, PDF.js and the MozJPEG
WebAssembly module are vendored locally (`vendor/`, all permissively
licensed — see the `LICENSE` files in each directory) and loaded directly by
the browser. No bundler, no runtime CDN dependency, works offline.

`vendor/pdfjs/` also carries PDF.js's optional data files — `wasm/` (the
OpenJPEG, JBIG2 and QCMS modules), `standard_fonts/`, `cmaps/` and `iccs/` —
so exotic PDFs decode and render correctly without reaching out to a CDN.
They are fetched lazily, only by the documents that need them.

## Local development

This is a static site with no build step. Serve the folder with any static
file server, for example:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Note that it has to be served over HTTP rather than opened as a `file://`
URL, because it uses ES modules and a Web Worker.

## Deployment

A GitHub Actions workflow at `.github/workflows/deploy.yml` deploys this
site to GitHub Pages automatically on every push to `main`. Make sure Pages
is set to the "GitHub Actions" source under **Settings → Pages**.

## Privacy

All processing happens locally in your browser using the File API, Canvas
API, Web Workers and WebAssembly. No PDF content, image data, or metadata is
ever transmitted over the network — the only requests the page makes are for
its own static assets on the same origin.
