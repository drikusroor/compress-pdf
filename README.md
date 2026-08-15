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
   a JPEG at the quality level you choose.
4. If the recompressed image is smaller than the original, it replaces the
   image inside the PDF's object graph. The rest of the PDF (text, fonts,
   vector graphics, layout) is left untouched.
5. The resulting PDF is offered back to you as a download — nothing is sent
   anywhere.

No WebAssembly codec is bundled: modern browsers already ship fast, native
JPEG encoders/decoders via `<canvas>` and `createImageBitmap`, so this stays
a plain HTML/CSS/JS site with no build step and a single small vendored
dependency (`vendor/pdf-lib.min.js`, MIT licensed).

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
