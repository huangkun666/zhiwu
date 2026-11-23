import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export async function loadPdf(source: string | Uint8Array) {
  const { GlobalWorkerOptions, getDocument } = await import('pdfjs-dist');
  if (!GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const assetPath = import.meta.env.DEV ? 'node_modules/pdfjs-dist/' : 'pdf-assets/';
  const assetBase = new URL(`${import.meta.env.BASE_URL}${assetPath}`, window.location.href);
  return getDocument({
    ...(typeof source === 'string' ? { url: source } : { data: source }),
    cMapUrl: new URL('cmaps/', assetBase).href,
    standardFontDataUrl: new URL('standard_fonts/', assetBase).href,
    wasmUrl: new URL('wasm/', assetBase).href,
    iccUrl: new URL('iccs/', assetBase).href,
  });
}
