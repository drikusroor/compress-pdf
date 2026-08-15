# Compress PDF

A tiny, client-side website that shrinks PDF file size by recompressing the
images embedded inside it. Everything happens in your browser — no PDF is
ever uploaded to a server.

**Live app:** enable GitHub Pages for this repo (see below) and it will be
served at `https://<your-username>.github.io/compress-pdf/`.

## How it works

1. You pick a PDF (drag & drop or file picker).
2. The app parses the PDF's internal object structure with
   [pdf-lib](https://pdf-lib.js.org/) and finds every embedded image
   (JPEG images, plus simple uncompressed raster images).
3. Each image is decoded using the browser's built-in image codecs, drawn to
   a `<canvas>` (optionally downscaled and/or desaturated), and re-encoded as
   a JPEG using a WebAssembly build of [MozJPEG](https://github.com/mozilla/mozjpeg)
   (via [`@jsquash/jpeg`](https://github.com/jamsinclair/jSquash)) at the
   quality level you choose. MozJPEG's encoder (trellis quantization,
   optimized Huffman tables, etc.) produces meaningfully smaller files than
   the browser's built-in JPEG encoder at the same visual quality — if WASM
   is unavailable for some reason, it falls back to the native
   `canvas.toBlob('image/jpeg')` encoder automatically.
4. If the recompressed image is smaller than the original, it replaces the
   image inside the PDF's object graph. The rest of the PDF (text, fonts,
   vector graphics, layout) is left untouched.
5. The resulting PDF is offered back to you as a download — nothing is sent
   anywhere.

This stays a plain HTML/CSS/JS site with no build step: the MozJPEG
WebAssembly module and pdf-lib are vendored locally
(`vendor/mozjpeg/`, `vendor/pdf-lib.min.js` — both permissively licensed, see
their respective `LICENSE` files) and loaded directly by the browser, so the
whole thing works offline with no bundler and no runtime CDN dependency.

Note: WebP is not usable here — the PDF spec has no filter for decoding WebP
image streams, so a WebP-encoded image embedded in a PDF wouldn't render in
any standard PDF viewer (Acrobat, browsers, PDF.js, etc.). JPEG (via the
standard `DCTDecode` filter) is the best-supported lossy format PDF actually
defines, which is why the effort here went into a better JPEG encoder
instead. By default, the app also does **not** downscale image resolution
(the "max image resolution" slider defaults to "No limit") since resizing
tends to cause more visible quality loss than a well-tuned JPEG quality
setting — lower it yourself if you want to trade resolution for extra size
savings.

Images that use formats this simple approach can't safely handle (e.g.
CMYK/JPEG2000/CCITT fax scans, indexed color, images with transparency
masks) are left as-is rather than risking corruption — the app tells you if
some images couldn't be compressed further.

## Local development

This is a static site with no build step. Serve the folder with any static
file server, for example:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

## Deployment

A GitHub Actions workflow at `.github/workflows/deploy.yml` deploys this
site to GitHub Pages automatically on every push to `main`. Make sure Pages
is set to the "GitHub Actions" source under **Settings → Pages**.

## Privacy

All processing happens locally in your browser using the File API, Canvas
API, and WebAssembly-free JavaScript. No PDF content, image data, or
metadata is ever transmitted over the network.
