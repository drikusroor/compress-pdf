// Account for every byte in a PDF, so "why is this file 22 MB?" has an answer.
//
// Only stream payloads are measured directly — they are where essentially all
// of a PDF's weight lives, and their stored (still-compressed) length is
// exactly what the file carries. Whatever the streams do not account for is
// reported as structure: dictionaries, cross-reference tables and syntax.
//
// Every stream is attributed by walking the object graph from the trailer and
// remembering which dictionary key first reached it. Streams the walk never
// reaches are leftovers from incremental saves — a category worth calling out,
// because nothing in the document refers to them any more.

const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFStream } = window.PDFLib;

const K = {
  Type: PDFName.of('Type'),
  Subtype: PDFName.of('Subtype'),
  Filter: PDFName.of('Filter'),
};

export const CATEGORIES = [
  { key: 'images', label: 'Images' },
  { key: 'fonts', label: 'Embedded fonts' },
  { key: 'content', label: 'Page content & vector art' },
  { key: 'attachments', label: 'File attachments' },
  { key: 'annotations', label: 'Annotations & form fields' },
  { key: 'thumbnails', label: 'Page thumbnails' },
  { key: 'metadata', label: 'Metadata' },
  { key: 'colour', label: 'Colour profiles' },
  { key: 'structureTree', label: 'Tagged-PDF structure' },
  { key: 'other', label: 'Other streams' },
  { key: 'unreferenced', label: 'Unreferenced leftovers' },
  { key: 'structure', label: 'Dictionaries, xref & syntax' },
];

// Which category a dictionary entry puts its value into. Anything not listed
// inherits whatever category reached the parent.
const KEY_CATEGORY = {
  FontFile: 'fonts',
  FontFile2: 'fonts',
  FontFile3: 'fonts',
  Font: 'fonts',
  FontDescriptor: 'fonts',
  DescendantFonts: 'fonts',
  CharProcs: 'fonts',
  ToUnicode: 'fonts',
  Encoding: 'fonts',
  Widths: 'fonts',
  W: 'fonts',
  CIDSet: 'fonts',
  CIDToGIDMap: 'fonts',
  Metadata: 'metadata',
  Thumb: 'thumbnails',
  Annots: 'annotations',
  AcroForm: 'annotations',
  XFA: 'annotations',
  AP: 'annotations',
  StructTreeRoot: 'structureTree',
  ParentTree: 'structureTree',
  ColorSpace: 'colour',
  OutputIntents: 'colour',
  DestOutputProfile: 'colour',
};

const asName = (obj) => (obj instanceof PDFName ? obj.decodeText() : null);

/** A stream's own identity beats whatever key happened to reach it. */
function refineCategory(value, inherited) {
  if (!(value instanceof PDFStream)) return inherited;
  // ...except where the key already said what the stream is *for*: a page
  // thumbnail is an /Image and an annotation's appearance is a /Form, and
  // filing either under images or page content would be misleading.
  if (inherited === 'thumbnails' || inherited === 'annotations') return inherited;
  const subtype = asName(value.dict.get(K.Subtype));
  const type = asName(value.dict.get(K.Type));
  if (subtype === 'Image') return 'images';
  if (type === 'EmbeddedFile') return 'attachments';
  if (subtype === 'Form') return 'content';
  if (type === 'Metadata') return 'metadata';
  return inherited;
}

function categoryForKey(key, parentType, inherited) {
  if (key === 'Contents' && parentType === 'Page') return 'content';
  return KEY_CATEGORY[key] || inherited;
}

/** Map every reachable object to a category, following indirect references. */
function categoriseObjects(context) {
  const categories = new Map();
  const queued = new Set();
  const queue = [];

  const enqueue = (ref, category) => {
    if (queued.has(ref.tag)) return;
    queued.add(ref.tag);
    queue.push({ ref, category });
  };

  // Direct (non-indirect) values nest only shallowly inside a single object;
  // anything deep is made of indirect objects, which go through the queue.
  const collect = (value, category, parentType) => {
    if (value instanceof PDFRef) {
      enqueue(value, category);
    } else if (value instanceof PDFStream) {
      collect(value.dict, category, parentType);
    } else if (value instanceof PDFDict) {
      const type = asName(value.get(K.Type));
      for (const [key, child] of value.entries()) {
        collect(child, categoryForKey(key.decodeText(), type, category), type);
      }
    } else if (value instanceof PDFArray) {
      for (const child of value.asArray()) collect(child, category, parentType);
    }
  };

  const { Root, Info } = context.trailerInfo;
  if (Root instanceof PDFRef) enqueue(Root, 'other');
  if (Info instanceof PDFRef) enqueue(Info, 'metadata');

  while (queue.length) {
    const { ref, category } = queue.pop();
    let value;
    try {
      value = context.lookup(ref);
    } catch {
      continue;
    }
    if (!value) continue;
    const refined = refineCategory(value, category);
    categories.set(ref.tag, refined);
    collect(value, refined, null);
  }

  return categories;
}

/**
 * @param {Uint8Array} pdfBytes
 * @returns a size breakdown plus the few document facts that shape the advice
 */
export async function analysePdf(pdfBytes) {
  const pdfDoc = await PDFDocument.load(pdfBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const context = pdfDoc.context;
  const categories = categoriseObjects(context);
  // If the walk found nothing at all (a trailer we could not follow), calling
  // every object "unreferenced" would be a confident lie.
  const fallback = categories.size > 0 ? 'unreferenced' : 'other';

  const totals = new Map(CATEGORIES.map(({ key }) => [key, { bytes: 0, count: 0 }]));
  let streamBytes = 0;
  let streamCount = 0;
  const uncompressed = { bytes: 0, count: 0 };

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    let bytes;
    try {
      bytes = object.getContents().length;
    } catch {
      continue;
    }
    const key = categories.get(ref.tag) || fallback;
    const entry = totals.get(key) || totals.get('other');
    entry.bytes += bytes;
    entry.count += 1;
    streamBytes += bytes;
    streamCount += 1;
    if (!object.dict.get(K.Filter)) {
      uncompressed.bytes += bytes;
      uncompressed.count += 1;
    }
  }

  // Whatever the streams do not explain is the document's own syntax.
  const fileSize = pdfBytes.length;
  const structure = totals.get('structure');
  structure.bytes = Math.max(0, fileSize - streamBytes);
  structure.count = context.enumerateIndirectObjects().length - streamCount;

  const breakdown = CATEGORIES.map(({ key, label }) => ({
    key,
    label,
    ...totals.get(key),
    share: fileSize > 0 ? totals.get(key).bytes / fileSize : 0,
  })).filter((row) => row.bytes > 0);
  breakdown.sort((a, b) => b.bytes - a.bytes);

  let pageCount = 0;
  try {
    pageCount = pdfDoc.getPageCount();
  } catch {
    pageCount = 0;
  }

  const readString = (getter) => {
    try {
      return pdfDoc[getter]() || '';
    } catch {
      return '';
    }
  };

  return {
    fileSize,
    pageCount,
    objectCount: context.enumerateIndirectObjects().length,
    encrypted: pdfDoc.isEncrypted,
    producer: readString('getProducer'),
    creator: readString('getCreator'),
    breakdown,
    uncompressed,
  };
}
